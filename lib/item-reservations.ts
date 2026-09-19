import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

/**
 * Reservations do not expire: a slot is released by `release`, consumed by
 * `commit`, or retired when an authoritative host signal proves the launch dead
 * — never by a clock. `expires_at` survives only as a column the shared
 * migration's capacity triggers still count, written beyond any clock, so the
 * fence counts every reservation instead of reviving time as an authority.
 */
const NO_EXPIRY = Number.MAX_SAFE_INTEGER;

/**
 * Launch-retry ladder: the initial attempt plus retries at 15s, 1m and 5m, then
 * a durable blocked record. Exhaustion is a state, not a loop.
 */
export const LAUNCH_RETRY_DELAYS_MS: readonly number[] = [15_000, 60_000, 300_000];
const MAX_LAUNCH_ATTEMPTS = LAUNCH_RETRY_DELAYS_MS.length + 1;

export interface LaunchAttemptRecord {
  attemptCount: number;
  nextDueAt: number | null;
  blockedAt: number | null;
}

interface AttemptRow {
  attempt_count: number;
  next_due_at: number | null;
  blocked_at: number | null;
}

/** Durable launch-attempt generation per (root, item), owned here rather than in
 * the shared migration list, which records progress by array index. */
export function createLaunchAttemptStore(db: PluginDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS collab_launch_attempts (
      root_thread_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      first_attempt_at INTEGER NOT NULL,
      last_attempt_at INTEGER NOT NULL,
      next_due_at INTEGER,
      blocked_at INTEGER,
      PRIMARY KEY (root_thread_id, item_id)
    )
  `);
  const read = db.prepare(
    "SELECT attempt_count, next_due_at, blocked_at FROM collab_launch_attempts WHERE root_thread_id = ? AND item_id = ?",
  );
  const insert = db.prepare(
    "INSERT INTO collab_launch_attempts (root_thread_id, item_id, attempt_count, first_attempt_at, last_attempt_at, next_due_at, blocked_at) VALUES (?, ?, 1, ?, ?, ?, NULL)",
  );
  const advance = db.prepare(
    "UPDATE collab_launch_attempts SET attempt_count = ?, last_attempt_at = ?, next_due_at = ?, blocked_at = ? WHERE root_thread_id = ? AND item_id = ?",
  );
  const clear = db.prepare(
    "DELETE FROM collab_launch_attempts WHERE root_thread_id = ? AND item_id = ?",
  );

  return {
    /**
     * Consume one attempt, recorded BEFORE dispatch so a crash mid-launch burns
     * an attempt instead of double-launching. Null while the generation is not
     * due and while it is durably blocked. `now` is the caller's clock.
     */
    begin(rootThreadId: string, itemId: string, now: number): LaunchAttemptRecord | null {
      const txn = db.transaction((): LaunchAttemptRecord | null => {
        const row = read.get(rootThreadId, itemId) as AttemptRow | undefined;
        if (!row) {
          const nextDueAt = now + LAUNCH_RETRY_DELAYS_MS[0]!;
          insert.run(rootThreadId, itemId, now, now, nextDueAt);
          return { attemptCount: 1, nextDueAt, blockedAt: null };
        }
        if (row.blocked_at !== null) return null;
        if (row.next_due_at !== null && row.next_due_at > now) return null;
        const attemptCount = row.attempt_count + 1;
        if (attemptCount >= MAX_LAUNCH_ATTEMPTS) {
          advance.run(MAX_LAUNCH_ATTEMPTS, now, null, now, rootThreadId, itemId);
          return { attemptCount: MAX_LAUNCH_ATTEMPTS, nextDueAt: null, blockedAt: now };
        }
        const nextDueAt = now + LAUNCH_RETRY_DELAYS_MS[attemptCount - 1]!;
        advance.run(attemptCount, now, nextDueAt, null, rootThreadId, itemId);
        return { attemptCount, nextDueAt, blockedAt: null };
      });
      return txn.immediate();
    },

    /** The launch landed, or an owner explicitly requeued the slice. */
    clear(rootThreadId: string, itemId: string): void {
      clear.run(rootThreadId, itemId);
    },
  };
}

/** Durable scheduling generation per root: every trigger advances
 * `requested_seq`, and a trigger that lands while a pass is in flight leaves the
 * row dirty instead of being dropped by a process-local flag. */
export function createSchedulerGenerationStore(db: PluginDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS collab_scheduler_generations (
      root_thread_id TEXT PRIMARY KEY,
      requested_seq INTEGER NOT NULL DEFAULT 0,
      serviced_seq INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )
  `);
  const request = db.prepare(`
    INSERT INTO collab_scheduler_generations (root_thread_id, requested_seq, serviced_seq, updated_at)
    VALUES (?, 1, 0, ?)
    ON CONFLICT(root_thread_id) DO UPDATE SET
      requested_seq = requested_seq + 1,
      updated_at = excluded.updated_at
  `);
  const service = db.prepare(
    "UPDATE collab_scheduler_generations SET serviced_seq = ?, updated_at = ? WHERE root_thread_id = ? AND serviced_seq < ?",
  );
  const read = db.prepare(
    "SELECT requested_seq, serviced_seq FROM collab_scheduler_generations WHERE root_thread_id = ?",
  );
  const sequence = (rootThreadId: string): { requested: number; serviced: number } => {
    const row = read.get(rootThreadId) as
      | { requested_seq: number; serviced_seq: number }
      | undefined;
    return { requested: row?.requested_seq ?? 0, serviced: row?.serviced_seq ?? 0 };
  };

  return {
    /** Advance the dirty generation and report the value to service. */
    request(rootThreadId: string, now: number): number {
      const txn = db.transaction((): number => {
        request.run(rootThreadId, now);
        return sequence(rootThreadId).requested;
      });
      return txn.immediate();
    },

    requested(rootThreadId: string): number {
      return sequence(rootThreadId).requested;
    },

    /** Record the generation a pass serviced; true while a newer generation is
     * still outstanding, which owes exactly one follow-up pass. */
    service(rootThreadId: string, servicedSeq: number, now: number): boolean {
      const txn = db.transaction((): boolean => {
        service.run(servicedSeq, now, rootThreadId, servicedSeq);
        const current = sequence(rootThreadId);
        return current.requested > current.serviced;
      });
      return txn.immediate();
    },
  };
}

/**
 * Cross-generation scheduler lock. The row is acquired before BB is asked to
 * create a child thread, so overlapping old/new plugin instances cannot both
 * pass a process-local availability check and spawn the same work item.
 */
export function createItemReservationStore(db: PluginDatabase) {
  const acquireStmt = db.prepare(`
    INSERT OR IGNORE INTO collab_item_reservations (
      root_thread_id, item_id, claim_token, created_at, expires_at, slot_limit
    )
    SELECT @root_thread_id, @item_id, @claim_token, @created_at, @expires_at, @slot_limit
    WHERE NOT EXISTS (
      SELECT 1 FROM collab_agents
      WHERE root_thread_id = @root_thread_id
        AND item_id = @item_id
        AND retired_at IS NULL
        AND COALESCE(role, 'worker') != 'verifier'
    )
      AND (
        SELECT COUNT(*) FROM collab_agents
        WHERE root_thread_id = @root_thread_id
          AND retired_at IS NULL
          AND COALESCE(role, 'worker') != 'verifier'
      ) + (
        SELECT COUNT(*) FROM collab_item_reservations
        WHERE root_thread_id = @root_thread_id
      ) < @slot_limit
  `);
  const releaseStmt = db.prepare(`
    DELETE FROM collab_item_reservations
    WHERE root_thread_id = ? AND item_id = ? AND claim_token = ?
  `);
  const releaseItemStmt = db.prepare(
    "DELETE FROM collab_item_reservations WHERE root_thread_id = ? AND item_id = ?",
  );
  const reservation = db.prepare(
    "SELECT claim_token, slot_limit FROM collab_item_reservations WHERE root_thread_id = ? AND item_id = ?",
  );
  const liveWorker = db.prepare(`
    SELECT 1 FROM collab_agents
    WHERE root_thread_id = ? AND item_id = ? AND retired_at IS NULL
      AND COALESCE(role, 'worker') != 'verifier'
    LIMIT 1
  `);
  const writeRootCap = db.prepare(`
    INSERT INTO collab_root_worker_caps (root_thread_id, max_workers, updated_at)
    VALUES (@root_thread_id, @max_workers, @updated_at)
    ON CONFLICT(root_thread_id) DO UPDATE SET
      max_workers = CASE
        WHEN EXISTS (
          SELECT 1 FROM collab_item_reservations
          WHERE root_thread_id = excluded.root_thread_id
        ) THEN MIN(collab_root_worker_caps.max_workers, excluded.max_workers)
        ELSE excluded.max_workers
      END,
      updated_at = excluded.updated_at
  `);
  const rootCap = db.prepare(
    "SELECT max_workers FROM collab_root_worker_caps WHERE root_thread_id = ?",
  );
  const rootOccupancy = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM collab_agents
       WHERE root_thread_id = @root_thread_id
         AND retired_at IS NULL
         AND COALESCE(role, 'worker') != 'verifier')
      +
      (SELECT COUNT(*) FROM collab_item_reservations
       WHERE root_thread_id = @root_thread_id) AS n
  `);

  return {
    setCap(rootThreadId: string, maxWorkers: number): boolean {
      if (!Number.isFinite(maxWorkers) || maxWorkers < 0) return false;
      const now = Date.now();
      const txn = db.transaction(() => {
        writeRootCap.run({
          root_thread_id: rootThreadId,
          max_workers: Math.floor(maxWorkers),
          updated_at: now,
        });
      });
      txn.immediate();
      return true;
    },

    acquire(rootThreadId: string, itemId: string, maxWorkers: number): string | null {
      if (!Number.isFinite(maxWorkers) || maxWorkers < 1) return null;
      const slotLimit = Math.floor(maxWorkers);
      const token = `claim_${randomUUID()}`;
      const now = Date.now();
      const txn = db.transaction(() => {
        writeRootCap.run({
          root_thread_id: rootThreadId,
          max_workers: slotLimit,
          updated_at: now,
        });
        const result = acquireStmt.run({
          root_thread_id: rootThreadId,
          item_id: itemId,
          claim_token: token,
          created_at: now,
          expires_at: NO_EXPIRY,
          slot_limit: slotLimit,
        });
        return result.changes === 1 ? token : null;
      });
      return txn.immediate();
    },

    release(rootThreadId: string, itemId: string, token: string): boolean {
      return releaseStmt.run(rootThreadId, itemId, token).changes === 1;
    },

    /** Drop every reservation for the item. Explicit owner release only: a
     * reservation is otherwise held until its launch commits or is proven dead. */
    releaseItem(rootThreadId: string, itemId: string): number {
      return releaseItemStmt.run(rootThreadId, itemId).changes;
    },

    /** Insert the durable worker row and consume its reservation atomically. */
    commit(
      rootThreadId: string,
      itemId: string,
      token: string,
      insertWorker: () => void,
    ): boolean {
      const txn = db.transaction(() => {
        const held = reservation.get(rootThreadId, itemId) as
          | { claim_token: string; slot_limit: number }
          | undefined;
        if (!held || held.claim_token !== token) return false;
        // Recheck under the same IMMEDIATE writer lock that will persist the
        // child row. A worker inserted after acquisition (for example by an
        // old generation finishing a prior spawn) wins; this spawn fails
        // closed instead of becoming a second owner.
        if (liveWorker.get(rootThreadId, itemId)) return false;
        // The reservation already occupies one root slot, so replacing it
        // with the durable worker must not increase this total. Rechecking
        // under the writer lock catches a legacy/overlapping generation that
        // inserted a different worker after this reservation was acquired.
        const occupancy = rootOccupancy.get({
          root_thread_id: rootThreadId,
        }) as { n: number };
        const cap = rootCap.get(rootThreadId) as { max_workers: number } | undefined;
        if (!cap || occupancy.n > cap.max_workers) return false;
        insertWorker();
        if (releaseStmt.run(rootThreadId, itemId, token).changes !== 1) {
          throw new Error("scheduler item reservation disappeared during commit");
        }
        return true;
      });
      return txn.immediate();
    },

    /**
     * The fence's own unit of account: every non-retired worker row for the root
     * plus every live reservation — exactly what `acquireStmt` and the
     * `collab_agents_root_capacity_*` triggers count.
     *
     * Slot math MUST read this and never a projection of host statuses. The
     * projection drops rows whose slice is already closed and rows that never
     * had one (intake couriers, discovered children), while the fence counts
     * them, so anything planned from the projection is a spawn that can never
     * be admitted.
     */
    occupancy(rootThreadId: string): number {
      const row = rootOccupancy.get({ root_thread_id: rootThreadId }) as
        | { n: number }
        | undefined;
      return row?.n ?? 0;
    },

    isHeld(rootThreadId: string, itemId: string, exceptToken?: string): boolean {
      if (liveWorker.get(rootThreadId, itemId)) return true;
      const held = reservation.get(rootThreadId, itemId) as
        | { claim_token: string }
        | undefined;
      return Boolean(held && (!exceptToken || held.claim_token !== exceptToken));
    },

    claimants(rootThreadId: string, itemId: string): string[] {
      const held = reservation.get(rootThreadId, itemId) as
        | { claim_token: string }
        | undefined;
      return held ? [held.claim_token] : [];
    },
  };
}

export type ItemReservationStore = ReturnType<typeof createItemReservationStore>;
