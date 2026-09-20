import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { GoalDecision } from "../contract.js";

/**
 * An owner answer is delivered only when the root has actually been told.
 * Recording the answer used to be the whole transaction: the one best-effort
 * steer was dropped when the thread refused it (a 409 while another decision
 * card was still open, an in-flight submit), `openDecisions` went empty, and
 * the orchestrator read a clean board while its workers sat blocked on a
 * ruling the owner had already made. Delivery is therefore durable — the
 * answer stays undelivered until a steer lands, and the pulse sweep retries —
 * and its policy lives here so it can be exercised without a live thread.
 */

export type PendingDecision = Pick<GoalDecision, "id" | "question" | "answer">;

/** Exact text the root receives. Stable and decision-specific so a timeline
 * scan can tell that this answer already landed. */
export function decisionAnswerMarker(decisionId: string): string {
  return `OWNER DECISION ANSWERED (${decisionId})`;
}

export function decisionAnswerMessage(decision: PendingDecision): string {
  return `${decisionAnswerMarker(decision.id)}: "${decision.question}" -> ${
    decision.answer ?? ""
  }. Act on this now and resolve any dependent work.`;
}

/**
 * Decision ids whose answer already appears in the root's timeline.
 *
 * Dedupe only: `delivered_at` is the source of truth, so a scan miss (an
 * unreadable timeline) costs one redundant steer, never a lost answer. A scan
 * hit means the steer landed before the plugin could record it — for example a
 * send that timed out after the thread accepted it.
 */
export function decisionIdsInTimeline(
  rows: readonly unknown[],
  candidateIds: readonly string[],
): Set<string> {
  const seen = new Set<string>();
  if (rows.length === 0 || candidateIds.length === 0) return seen;
  const text = rows
    .map((row) => (typeof row === "string" ? row : JSON.stringify(row)))
    .join("\n");
  for (const id of candidateIds) {
    if (text.includes(decisionAnswerMarker(id))) seen.add(id);
  }
  return seen;
}

export type RootWakeupState = "pending" | "queued" | "dispatched" | "unknown";

/** One root's single outstanding automatic notification. */
export interface RootWakeup {
  threadId: string;
  state: RootWakeupState;
  summary: string;
  /** Monotonic count of coalesced events; never decremented. */
  revision: number;
  /** The highest revision an applied settle covered. */
  settledRevision: number;
  queueMessageId: string | null;
  queueUpdatedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type WakeupOutcome =
  | { kind: "queued"; messageId: string; queueUpdatedAt: number }
  | { kind: "dispatched" }
  | { kind: "unknown" };

export interface RootWakeupStore {
  note(threadId: string, summary: string, now: number): RootWakeup;
  get(threadId: string): RootWakeup | null;
  outstanding(threadId: string): RootWakeup | null;
  listOutstanding(): RootWakeup[];
  settle(
    threadId: string,
    expectedRevision: number,
    outcome: WakeupOutcome,
    now: number,
  ): RootWakeup | null;
}

interface WakeupRow {
  thread_id: string;
  state: string;
  summary: string;
  revision: number;
  settled_revision: number;
  queue_message_id: string | null;
  queue_updated_at: number | null;
  created_at: number;
  updated_at: number;
}

function rowToWakeup(row: WakeupRow): RootWakeup {
  return {
    threadId: row.thread_id,
    state: row.state as RootWakeupState,
    summary: row.summary,
    revision: row.revision,
    settledRevision: row.settled_revision,
    queueMessageId: row.queue_message_id,
    queueUpdatedAt: row.queue_updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The durable per-root wakeup ledger behind automatic root notifications.
 *
 * Continuation, progress, and decision-triggered notifications used to append
 * one chat message per event, so a burst of a hundred events queued a hundred
 * messages and a re-derived send could be created twice. One row per root is
 * the coalescing identity: `revision` counts events, `settledRevision` records
 * what an applied send covered, and a queued BB result keeps the message id it
 * was created with so a later update edits that row instead of minting a
 * second copy. The ledger is the only durable state; nothing here reads or
 * writes a notification, queue, or timeline — V3 feeds and drains it through
 * `reconcileWakeup`.
 *
 * Owned here rather than in the shared migration list, which records progress
 * by array index and has silently skipped an appended statement before.
 */
export function createRootWakeupStore(
  db: ReturnType<BbPluginApi["storage"]["database"]>,
): RootWakeupStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS goal_root_wakeups (
      thread_id TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      summary TEXT NOT NULL,
      revision INTEGER NOT NULL,
      settled_revision INTEGER NOT NULL,
      queue_message_id TEXT,
      queue_updated_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  // Coalesce in one statement: the first note creates the row, every later one
  // bumps the revision and replaces the summary. A dispatched row goes back to
  // pending because the send that landed covered only the work noted before it;
  // a queued or unknown row keeps its state so a queued identity is never
  // re-created and uncertainty is never silently cleared.
  const noteStmt = db.prepare(`
    INSERT INTO goal_root_wakeups (
      thread_id, state, summary, revision, settled_revision,
      queue_message_id, queue_updated_at, created_at, updated_at
    ) VALUES (
      @thread_id, 'pending', @summary, 1, 0, NULL, NULL, @now, @now
    )
    ON CONFLICT(thread_id) DO UPDATE SET
      revision = goal_root_wakeups.revision + 1,
      summary = excluded.summary,
      updated_at = excluded.updated_at,
      state = CASE
        WHEN goal_root_wakeups.state = 'dispatched' THEN 'pending'
        ELSE goal_root_wakeups.state
      END
    RETURNING *
  `);
  const readStmt = db.prepare("SELECT * FROM goal_root_wakeups WHERE thread_id = ?");
  const readOutstandingStmt = db.prepare(
    "SELECT * FROM goal_root_wakeups WHERE thread_id = ? AND revision > settled_revision",
  );
  const readAllOutstandingStmt = db.prepare(
    "SELECT * FROM goal_root_wakeups WHERE revision > settled_revision ORDER BY thread_id",
  );
  // The compare-and-set lives in the UPDATE itself: a read-then-write window in
  // JS could settle a revision a newer note already superseded. `@kind` is the
  // outcome kind, so one statement covers all three: dispatched/queued record
  // their state only when they settled the newest revision (otherwise the newer
  // event leaves the row pending), unknown never advances settled_revision, and
  // only a queued outcome replaces the stored message identity.
  const settleStmt = db.prepare(`
    UPDATE goal_root_wakeups SET
      state = CASE
        WHEN @kind = 'unknown' THEN 'unknown'
        WHEN revision = @expected_revision THEN @kind
        ELSE 'pending'
      END,
      settled_revision = CASE
        WHEN @kind = 'unknown' THEN settled_revision
        ELSE @expected_revision
      END,
      queue_message_id = CASE
        WHEN @kind = 'queued' THEN @queue_message_id
        ELSE queue_message_id
      END,
      queue_updated_at = CASE
        WHEN @kind = 'queued' THEN @queue_updated_at
        ELSE queue_updated_at
      END,
      updated_at = @now
    WHERE thread_id = @thread_id
      AND settled_revision < @expected_revision
      AND revision >= @expected_revision
    RETURNING *
  `);

  function read(threadId: string): RootWakeup | null {
    const row = readStmt.get(threadId) as WakeupRow | undefined;
    return row ? rowToWakeup(row) : null;
  }

  return {
    note(threadId: string, summary: string, now: number): RootWakeup {
      const text = summary.trim();
      if (!text) throw new Error("a wakeup summary must not be blank");
      return rowToWakeup(noteStmt.get({ thread_id: threadId, summary: text, now }) as WakeupRow);
    },

    get(threadId: string): RootWakeup | null {
      return read(threadId);
    },

    outstanding(threadId: string): RootWakeup | null {
      const row = readOutstandingStmt.get(threadId) as WakeupRow | undefined;
      return row ? rowToWakeup(row) : null;
    },

    listOutstanding(): RootWakeup[] {
      return (readAllOutstandingStmt.all() as WakeupRow[]).map(rowToWakeup);
    },

    settle(
      threadId: string,
      expectedRevision: number,
      outcome: WakeupOutcome,
      now: number,
    ): RootWakeup | null {
      let messageId: string | null = null;
      let queueUpdatedAt: number | null = null;
      if (outcome.kind === "queued") {
        // Refuse a half identity rather than storing a message id that no queue
        // row can match, which would turn a held queued wakeup into a resend.
        messageId = outcome.messageId.trim();
        if (!messageId) throw new Error("a queued wakeup outcome needs a non-blank message id");
        if (!Number.isFinite(outcome.queueUpdatedAt)) {
          throw new Error("a queued wakeup outcome needs a finite queue timestamp");
        }
        queueUpdatedAt = outcome.queueUpdatedAt;
      }
      const applied = settleStmt.get({
        thread_id: threadId,
        expected_revision: expectedRevision,
        kind: outcome.kind,
        queue_message_id: messageId,
        queue_updated_at: queueUpdatedAt,
        now,
      }) as WakeupRow | undefined;
      return applied ? rowToWakeup(applied) : null;
    },
  };
}

export interface DecisionDeliveryResult {
  delivered: number;
  alreadyDelivered: number;
  pending: number;
}

/**
 * Deliver every answered-but-undelivered decision. `send` returns false when
 * the root cannot take a turn right now; the sweep stops there and the next
 * pulse retries from the durable rows, so a refused steer is never lost.
 */
export async function deliverAnsweredDecisions(input: {
  pending: readonly PendingDecision[];
  seenInTimeline: ReadonlySet<string>;
  send: (decision: PendingDecision, message: string) => Promise<boolean>;
  markDelivered: (decision: PendingDecision) => void;
}): Promise<DecisionDeliveryResult> {
  const result: DecisionDeliveryResult = { delivered: 0, alreadyDelivered: 0, pending: 0 };
  for (const decision of input.pending) {
    if (input.seenInTimeline.has(decision.id)) {
      input.markDelivered(decision);
      result.alreadyDelivered += 1;
      continue;
    }
    if (!(await input.send(decision, decisionAnswerMessage(decision)))) {
      result.pending = input.pending.length - result.delivered - result.alreadyDelivered;
      break;
    }
    input.markDelivered(decision);
    result.delivered += 1;
  }
  return result;
}
