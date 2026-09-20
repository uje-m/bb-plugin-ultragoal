import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { createItemStore } from "./items.ts";
import { createItemReservationStore, createLaunchAttemptStore } from "./item-reservations.ts";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function connections() {
  const dir = mkdtempSync(join(tmpdir(), "ultragoal-claims-"));
  dirs.push(dir);
  const path = join(dir, "data.db");
  const first = new Database(path);
  first.pragma("journal_mode = WAL");
  first.pragma("busy_timeout = 5000");
  first.exec(`
    CREATE TABLE collab_agents (
      thread_id TEXT PRIMARY KEY,
      root_thread_id TEXT NOT NULL,
      item_id TEXT,
      role TEXT,
      retired_at INTEGER
    );
    CREATE TABLE collab_item_reservations (
      root_thread_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      claim_token TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      slot_limit INTEGER NOT NULL,
      PRIMARY KEY (root_thread_id, item_id)
    );
    CREATE TABLE collab_root_worker_caps (
      root_thread_id TEXT PRIMARY KEY,
      max_workers INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TRIGGER collab_agents_one_live_item_insert
      BEFORE INSERT ON collab_agents
      WHEN NEW.retired_at IS NULL
        AND NEW.item_id IS NOT NULL
        AND COALESCE(NEW.role, 'worker') != 'verifier'
        AND EXISTS (
          SELECT 1 FROM collab_agents
          WHERE root_thread_id = NEW.root_thread_id
            AND item_id = NEW.item_id
            AND retired_at IS NULL
            AND COALESCE(role, 'worker') != 'verifier'
        )
      BEGIN
        SELECT RAISE(ABORT, 'work item already has a live worker');
      END;
    CREATE TRIGGER collab_agents_root_capacity_insert
      BEFORE INSERT ON collab_agents
      WHEN NEW.retired_at IS NULL
        AND COALESCE(NEW.role, 'worker') != 'verifier'
        AND EXISTS (
          SELECT 1 FROM collab_root_worker_caps WHERE root_thread_id = NEW.root_thread_id
        )
        AND (
          (SELECT COUNT(*) FROM collab_agents
           WHERE root_thread_id = NEW.root_thread_id
             AND retired_at IS NULL
             AND COALESCE(role, 'worker') != 'verifier')
          +
          (SELECT COUNT(*) FROM collab_item_reservations
           WHERE root_thread_id = NEW.root_thread_id
             AND expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
             AND (NEW.item_id IS NULL OR item_id != NEW.item_id))
        ) >= (SELECT max_workers FROM collab_root_worker_caps
              WHERE root_thread_id = NEW.root_thread_id)
      BEGIN
        SELECT RAISE(ABORT, 'root worker capacity is full');
      END;
    CREATE TRIGGER collab_agents_root_capacity_update
      BEFORE UPDATE OF root_thread_id, role, retired_at ON collab_agents
      WHEN NEW.retired_at IS NULL
        AND COALESCE(NEW.role, 'worker') != 'verifier'
        AND EXISTS (
          SELECT 1 FROM collab_root_worker_caps WHERE root_thread_id = NEW.root_thread_id
        )
        AND (
          (SELECT COUNT(*) FROM collab_agents
           WHERE root_thread_id = NEW.root_thread_id
             AND thread_id != OLD.thread_id
             AND retired_at IS NULL
             AND COALESCE(role, 'worker') != 'verifier')
          +
          (SELECT COUNT(*) FROM collab_item_reservations
           WHERE root_thread_id = NEW.root_thread_id
             AND expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
             AND (NEW.item_id IS NULL OR item_id != NEW.item_id))
        ) >= (SELECT max_workers FROM collab_root_worker_caps
              WHERE root_thread_id = NEW.root_thread_id)
      BEGIN
        SELECT RAISE(ABORT, 'root worker capacity is full');
      END;
  `);
  const second = new Database(path);
  second.pragma("journal_mode = WAL");
  second.pragma("busy_timeout = 5000");
  return { first, second };
}

const hosts: FakePluginHost[] = [];
const REAL_NOW = Date.now;
const T0 = 1_800_000_000_000;

const settle = async (rounds: number): Promise<void> => {
  for (let n = 0; n < rounds; n += 1) await new Promise<void>((r) => setImmediate(r));
};

afterEach(async () => {
  Date.now = REAL_NOW;
  while (hosts.length > 0) await hosts.pop()!.harness.lifecycle.dispose();
});

/** A reservation held by a dead generation plus the store a fresh generation
 * builds for the same database (empty process-local in-flight set). */
function held(rootThreadId: string, itemId: string) {
  const { first, second } = connections();
  const dead = createItemReservationStore(first);
  const attempts = createLaunchAttemptStore(first);
  const reservations = createItemReservationStore(second);
  const token = dead.acquire(rootThreadId, itemId, 2);
  assert.ok(token);
  return { first, second, reservations, attempts, token: token! };
}

describe("durable scheduler item reservations", () => {
  it("allows only one pre-spawn owner across independent SQLite connections", () => {
    const { first, second } = connections();
    try {
      const oldGeneration = createItemReservationStore(first);
      const newGeneration = createItemReservationStore(second);
      const token = oldGeneration.acquire("thr_root", "itm_shared", 1);
      assert.ok(token);
      assert.equal(newGeneration.acquire("thr_root", "itm_shared", 1), null);

      assert.equal(
        oldGeneration.commit("thr_root", "itm_shared", token, () => {
          first.prepare(`
            INSERT INTO collab_agents (thread_id, root_thread_id, item_id, role)
            VALUES ('thr_worker', 'thr_root', 'itm_shared', 'worker')
          `).run();
        }),
        true,
      );
      assert.throws(
        () => second.prepare(`
          INSERT INTO collab_agents (thread_id, root_thread_id, item_id, role)
          VALUES ('thr_late_old_generation', 'thr_root', 'itm_shared', 'worker')
        `).run(),
        /already has a live worker|root worker capacity is full/,
        "an old generation that passed its pre-spawn check cannot land a duplicate after commit",
      );
      assert.equal(newGeneration.acquire("thr_root", "itm_shared", 1), null);
      assert.equal(
        (first.prepare("SELECT COUNT(*) AS n FROM collab_agents").get() as { n: number }).n,
        1,
      );
    } finally {
      first.close();
      second.close();
    }
  });

  it("enforces maxWorkers across different items and plugin generations", () => {
    const { first, second } = connections();
    try {
      const oldGeneration = createItemReservationStore(first);
      const newGeneration = createItemReservationStore(second);
      const firstToken = oldGeneration.acquire("thr_root", "itm_a", 1);
      assert.ok(firstToken);
      assert.equal(newGeneration.acquire("thr_root", "itm_a", 1), null);
      assert.equal(
        newGeneration.acquire("thr_root", "itm_b", 1),
        null,
        "a reservation for item A must consume the root's only worker slot",
      );
      assert.equal(
        oldGeneration.commit("thr_root", "itm_a", firstToken, () => {
          first.prepare(`
            INSERT INTO collab_agents (thread_id, root_thread_id, item_id, role)
            VALUES ('thr_a', 'thr_root', 'itm_a', 'worker')
          `).run();
        }),
        true,
      );
      assert.throws(
        () => second.prepare(`
          INSERT INTO collab_agents (thread_id, root_thread_id, item_id, role)
          VALUES ('thr_b', 'thr_root', 'itm_b', 'worker')
        `).run(),
        /root worker capacity is full/,
        "a v0.17.14 spawn returning after item A commits must be rejected at storage",
      );
      assert.equal(newGeneration.acquire("thr_root", "itm_b", 1), null);
      assert.deepEqual(
        first.prepare(
          "SELECT thread_id, item_id FROM collab_agents WHERE retired_at IS NULL ORDER BY thread_id",
        ).all(),
        [{ thread_id: "thr_a", item_id: "itm_a" }],
      );
    } finally {
      first.close();
      second.close();
    }
  });

  it("fails an expired reservation closed when another worker lands before commit", () => {
    const { first, second } = connections();
    try {
      const reservation = createItemReservationStore(first);
      const token = reservation.acquire("thr_root", "itm_rescue", 1);
      assert.ok(token);
      second.prepare(`
        UPDATE collab_item_reservations SET expires_at = 0
        WHERE root_thread_id = 'thr_root' AND item_id = 'itm_rescue'
      `).run();
      second.prepare(`
        INSERT INTO collab_agents (thread_id, root_thread_id, item_id, role)
        VALUES ('thr_winner', 'thr_root', 'itm_rescue', 'worker')
      `).run();
      let inserted = false;
      assert.equal(
        reservation.commit("thr_root", "itm_rescue", token, () => {
          inserted = true;
        }),
        false,
      );
      assert.equal(inserted, false);
      assert.equal(
        (first.prepare("SELECT thread_id FROM collab_agents").get() as { thread_id: string }).thread_id,
        "thr_winner",
      );
    } finally {
      first.close();
      second.close();
    }
  });

  it("fences a legacy different-item insert while a reservation is in flight", () => {
    const { first, second } = connections();
    try {
      const reservation = createItemReservationStore(first);
      const token = reservation.acquire("thr_root", "itm_reserved", 1);
      assert.ok(token);
      assert.throws(
        () => second.prepare(`
          INSERT INTO collab_agents (thread_id, root_thread_id, item_id, role)
          VALUES ('thr_legacy', 'thr_root', 'itm_other', 'worker')
        `).run(),
        /root worker capacity is full/,
      );
      assert.equal(
        reservation.commit("thr_root", "itm_reserved", token, () => {
          first.prepare(`
            INSERT INTO collab_agents (thread_id, root_thread_id, item_id, role)
            VALUES ('thr_reserved', 'thr_root', 'itm_reserved', 'worker')
          `).run();
        }),
        true,
      );
      assert.deepEqual(
        first.prepare("SELECT thread_id, item_id FROM collab_agents").all(),
        [{ thread_id: "thr_reserved", item_id: "itm_reserved" }],
      );
    } finally {
      first.close();
      second.close();
    }
  });

  it("lets a legacy child that lands first consume the slot and rejects the new reservation", () => {
    const { first, second } = connections();
    try {
      second.prepare(`
        INSERT INTO collab_agents (thread_id, root_thread_id, item_id, role)
        VALUES ('thr_legacy_first', 'thr_root', 'itm_b', 'worker')
      `).run();
      const reservation = createItemReservationStore(first);
      assert.equal(reservation.acquire("thr_root", "itm_a", 1), null);
      assert.deepEqual(
        first.prepare("SELECT thread_id, item_id FROM collab_agents").all(),
        [{ thread_id: "thr_legacy_first", item_id: "itm_b" }],
      );
    } finally {
      first.close();
      second.close();
    }
  });

  it("fences revival or adoption updates after the root slot is full", () => {
    const { first, second } = connections();
    try {
      const reservations = createItemReservationStore(first);
      const token = reservations.acquire("thr_root", "itm_a", 1);
      assert.ok(token);
      assert.equal(
        reservations.commit("thr_root", "itm_a", token, () => {
          first.prepare(`
            INSERT INTO collab_agents (thread_id, root_thread_id, item_id, role)
            VALUES ('thr_a', 'thr_root', 'itm_a', 'worker')
          `).run();
        }),
        true,
      );
      second.prepare(`
        INSERT INTO collab_agents (thread_id, root_thread_id, item_id, role, retired_at)
        VALUES ('thr_b', 'thr_root', NULL, 'worker', 1)
      `).run();
      assert.throws(
        () => second.prepare(`
          UPDATE collab_agents SET retired_at = NULL, item_id = 'itm_b'
          WHERE thread_id = 'thr_b'
        `).run(),
        /root worker capacity is full/,
      );
      assert.deepEqual(
        first.prepare(`
          SELECT thread_id, item_id FROM collab_agents
          WHERE retired_at IS NULL ORDER BY thread_id
        `).all(),
        [{ thread_id: "thr_a", item_id: "itm_a" }],
      );
    } finally {
      first.close();
      second.close();
    }
  });

  it("quarantines a held reservation while its launch attempt is unresolved", () => {
    const f = held("thr_root", "itm_maybe");
    try {
      assert.equal(f.attempts.begin("thr_root", "itm_maybe", 1_000), true);
      assert.deepEqual(f.reservations.reclaimUnheld("thr_root"), []);
      assert.deepEqual(f.reservations.claimants("thr_root", "itm_maybe"), [f.token]);
    } finally {
      f.first.close();
      f.second.close();
    }
  });

  it("quarantines an exhausted (blocked) attempt instead of reclaiming it", () => {
    const f = held("thr_root", "itm_blocked");
    try {
      for (const now of [1_000, 16_000, 76_000, 376_000]) {
        assert.equal(f.attempts.begin("thr_root", "itm_blocked", now), true);
      }
      const row = f.first.prepare(
        "SELECT blocked_at FROM collab_launch_attempts WHERE root_thread_id = 'thr_root' AND item_id = 'itm_blocked'",
      ).get() as { blocked_at: number | null };
      assert.notEqual(row.blocked_at, null);
      assert.deepEqual(f.reservations.reclaimUnheld("thr_root"), []);
      assert.deepEqual(f.reservations.claimants("thr_root", "itm_blocked"), [f.token]);
    } finally {
      f.first.close();
      f.second.close();
    }
  });

  it("reclaims an attempt-free dead generation exactly once", () => {
    const f = held("thr_root", "itm_dead");
    try {
      assert.deepEqual(f.reservations.reclaimUnheld("thr_root"), ["itm_dead"]);
      assert.deepEqual(f.reservations.claimants("thr_root", "itm_dead"), []);
      assert.deepEqual(f.reservations.reclaimUnheld("thr_root"), []);
    } finally {
      f.first.close();
      f.second.close();
    }
  });

  it("retains a reservation whose item has a live non-verifier worker", () => {
    const f = held("thr_root", "itm_live");
    try {
      f.first.prepare(
        "INSERT INTO collab_agents (thread_id, root_thread_id, item_id, role) VALUES ('thr_live', 'thr_root', 'itm_live', 'worker')",
      ).run();
      assert.deepEqual(f.reservations.reclaimUnheld("thr_root"), []);
      assert.deepEqual(f.reservations.claimants("thr_root", "itm_live"), [f.token]);
    } finally {
      f.first.close();
      f.second.close();
    }
  });

  it("reclaims once the owner clears the quarantined attempt", () => {
    const f = held("thr_root", "itm_cleared");
    try {
      assert.equal(f.attempts.begin("thr_root", "itm_cleared", 1_000), true);
      assert.deepEqual(f.reservations.reclaimUnheld("thr_root"), []);
      f.attempts.clear("thr_root", "itm_cleared");
      assert.deepEqual(f.reservations.reclaimUnheld("thr_root"), ["itm_cleared"]);
      assert.deepEqual(f.reservations.reclaimUnheld("thr_root"), []);
    } finally {
      f.first.close();
      f.second.close();
    }
  });

  it("ensures the attempt table when the reservation store is built first", () => {
    const { first, second } = connections();
    try {
      // lib/collab.ts:234 builds this store without ever building the attempt store.
      const reservations = createItemReservationStore(second);
      const dead = createItemReservationStore(first);
      const token = dead.acquire("thr_root", "itm_first", 2);
      const control = dead.acquire("thr_root", "itm_control", 2);
      assert.ok(token);
      assert.ok(control);
      assert.equal(createLaunchAttemptStore(first).begin("thr_root", "itm_first", 1_000), true);
      assert.deepEqual(reservations.reclaimUnheld("thr_root"), ["itm_control"]);
      assert.deepEqual(reservations.claimants("thr_root", "itm_first"), [token]);
    } finally {
      first.close();
      second.close();
    }
  });

  it("keeps a possibly-dispatched launch quarantined across a reload and a pulse", async () => {
    const spawns: string[] = [];
    const rootId = "thr_quarantine";
    const thread = (threadId: string) =>
      makeThreadResponse({
        id: threadId, projectId: "proj", providerId: "codex", environmentId: null,
        parentThreadId: threadId === rootId ? null : rootId, status: "active" as never,
      });
    const host = createFakePluginHost({
      pluginId: `ultragoal-quarantine-${hosts.length}`,
      sdk: {
        threads: {
          get: async ({ threadId }: { threadId: string }) => thread(threadId),
          list: () => [],
          timeline: () => ({ rows: [] as never[] }),
          output: () => ({ output: null }),
          send: async () => ({ ok: true }),
          archive: async () => ({}),
          update: async ({ threadId }: { threadId: string }) => thread(threadId),
          interactions: { list: async () => [], resolve: async () => ({}) },
          stop: async () => ({ ok: true }),
          events: { list: async () => [] as never[] },
          spawn: async ({ prompt }: { prompt?: string }) => {
            spawns.push(prompt ?? "");
            return thread(`thr_spawn_${spawns.length}`);
          },
        },
      } as never,
    });
    hosts.push(host);
    let db = host.bb.storage.database();
    db.exec(`CREATE TABLE goals (
        thread_id TEXT PRIMARY KEY, objective TEXT NOT NULL, status TEXT NOT NULL, reason TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER NOT NULL,
        turn_count INTEGER NOT NULL, max_turns INTEGER NOT NULL, max_minutes INTEGER NOT NULL,
        last_continue_at INTEGER, last_assistant_hash TEXT
      );
      INSERT INTO goals VALUES ('thr_sentinel', 'test', 'complete', NULL, 1, 1, 1, 0, 0, 0, NULL, NULL);`);
    plugin(host.bb);
    db.prepare(
      `UPDATE goals SET thread_id = ?, status = 'active', max_workers = 1, last_continue_at = ?,
         verify_enabled = 0, progress_update_minutes = 0 WHERE thread_id = 'thr_sentinel'`,
    ).run(rootId, Date.now());
    const item = createItemStore(host.bb).add(rootId, "Slice: possibly dispatched", "in_progress", {
      files: ["src/a.ts"], deps: [], check: null,
    });
    assert.ok(item);
    const token = createItemReservationStore(db).acquire(rootId, item.id, 1);
    assert.ok(token);
    assert.equal(createLaunchAttemptStore(db).begin(rootId, item.id, T0), true);
    const attemptSql =
      "SELECT attempt_count, first_attempt_at, last_attempt_at, next_due_at, blocked_at FROM collab_launch_attempts WHERE root_thread_id = ? AND item_id = ?";
    const attemptBefore = db.prepare(attemptSql).get(rootId, item.id);

    const reloaded = await host.harness.lifecycle.reload(plugin);
    hosts.push(reloaded);
    db = reloaded.bb.storage.database();
    Date.now = () => T0 + 20_000;
    const service = reloaded.harness.behavior.runService("progress-pulse");
    await settle(10);
    service.controller.abort();
    await service.done;
    await settle(80);
    Date.now = REAL_NOW;

    assert.deepEqual(spawns, [], "no second worker for a possibly-dispatched launch");
    assert.deepEqual(
      db.prepare(
        "SELECT item_id, claim_token FROM collab_item_reservations WHERE root_thread_id = ?",
      ).all(rootId),
      [{ item_id: item.id, claim_token: token }],
    );
    assert.deepEqual(db.prepare(attemptSql).get(rootId, item.id), attemptBefore);
  });
});
