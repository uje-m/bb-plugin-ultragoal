import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { GoalDecision } from "../contract.js";

interface DecisionRow {
  id: string;
  thread_id: string;
  question: string;
  context: string | null;
  options: string | null;
  status: "open" | "answered" | "withdrawn";
  answer: string | null;
  created_at: number;
  answered_at: number | null;
  delivered_at: number | null;
}

function rowToDecision(row: DecisionRow): GoalDecision {
  let options: string[] = [];
  try {
    const parsed = row.options ? JSON.parse(row.options) : [];
    if (Array.isArray(parsed)) options = parsed.filter((entry) => typeof entry === "string");
  } catch {
    options = [];
  }
  return {
    id: row.id,
    question: row.question,
    context: row.context,
    options,
    status: row.status,
    answer: row.answer,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}

function newId(): string {
  return `dec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * A decision row whose owner key is not the goal that owns it. Raised instead
 * of handing back a decision no goal's projection can read.
 *
 * `persistedOwner === null` means the owner key names no goal row at all;
 * otherwise the row was persisted under a different thread than the owner the
 * caller resolved.
 */
export class DecisionOwnerMismatchError extends Error {
  constructor(
    readonly owner: string,
    readonly decisionId: string,
    readonly persistedOwner: string | null,
  ) {
    super(
      persistedOwner === null
        ? `No UltraGoal row on ${owner} owns owner decision ${decisionId}; refusing to report an unreadable decision as open`
        : `Owner decision ${decisionId} was persisted under ${persistedOwner} instead of goal ${owner}`,
    );
    this.name = "DecisionOwnerMismatchError";
  }
}

/**
 * Owner decisions live under the thread id of the goal row that owns them.
 *
 * Rows persisted by an earlier generation under a caller-derived key that names
 * no goal row are inert by design: no goal's projection, read-back, or
 * completion gate can reach them, and this store neither authors nor migrates
 * them. A one-shot rekey is refused deliberately — a row nobody could read back
 * is not evidence that a goal raised it, and rekeying it onto a goal would
 * invent an owner gate that goal never had. They cannot gate completion because
 * `ultragoal_finish` lists by the goal's own id, so stale rows stay dead weight.
 */
export function createDecisionStore(bb: BbPluginApi) {
  const db = bb.storage.database();
  const byThread = db.prepare(
    "SELECT * FROM goal_decisions WHERE thread_id = ? ORDER BY created_at ASC",
  );
  const byId = db.prepare("SELECT * FROM goal_decisions WHERE thread_id = ? AND id = ?");
  const persistedOwnerOf = db.prepare("SELECT thread_id FROM goal_decisions WHERE id = ?");
  // An owner decision belongs to a goal row. Checking the persisted key against
  // the goals table — not against the insert argument — is what refuses a
  // caller-derived owner key the owning goal would never read.
  const ownerIsGoal = db.prepare("SELECT 1 FROM goals WHERE thread_id = ?");
  const insert = db.prepare(`
    INSERT INTO goal_decisions (id, thread_id, question, context, options, status, answer, created_at, answered_at)
    VALUES (@id, @thread_id, @question, @context, @options, @status, @answer, @created_at, @answered_at)
  `);
  // Persist and prove in one transaction: a refused owner key leaves no open
  // row behind for some unrelated thread to hold.
  const persistOwned = db.transaction((row: DecisionRow, insertRow: boolean): void => {
    if (!ownerIsGoal.get(row.thread_id)) {
      throw new DecisionOwnerMismatchError(row.thread_id, row.id, null);
    }
    if (insertRow) insert.run(row);
    const persistedOwner = (
      persistedOwnerOf.get(row.id) as { thread_id: string } | undefined
    )?.thread_id;
    if (persistedOwner !== row.thread_id) {
      throw new DecisionOwnerMismatchError(row.thread_id, row.id, persistedOwner ?? null);
    }
  });
  // The open-status guard lives in the UPDATE, so the check and the write are
  // one atomic statement: a competing resolution that arrives second matches no
  // row and changes nothing, with no read-then-write window in JavaScript.
  const resolveStmt = db.prepare(`
    UPDATE goal_decisions SET status = @status, answer = @answer, answered_at = @answered_at
    WHERE thread_id = @thread_id AND id = @id AND status = 'open'
  `);
  const clearStmt = db.prepare("DELETE FROM goal_decisions WHERE thread_id = ?");
  const markDeliveredStmt = db.prepare(
    "UPDATE goal_decisions SET delivered_at = @delivered_at WHERE thread_id = @thread_id AND id = @id",
  );

  return {
    request(
      threadId: string,
      input: { question: string; context?: string | null; options?: string[] },
    ): GoalDecision {
      // The same question asked twice is one decision.
      const normalized = input.question.trim().toLowerCase().replace(/\s+/g, " ");
      const existing = (byThread.all(threadId) as DecisionRow[]).find(
        (row) =>
          row.status === "open" &&
          row.question.trim().toLowerCase().replace(/\s+/g, " ") === normalized,
      );
      const row: DecisionRow = existing ?? {
        id: newId(),
        thread_id: threadId,
        question: input.question.trim(),
        context: input.context?.trim() || null,
        options: input.options && input.options.length > 0 ? JSON.stringify(input.options) : null,
        status: "open",
        answer: null,
        created_at: Date.now(),
        answered_at: null,
        delivered_at: null,
      };
      persistOwned(row, !existing);
      return rowToDecision(row);
    },

    get(threadId: string, id: string): GoalDecision | null {
      const row = byId.get(threadId, id) as DecisionRow | undefined;
      return row ? rowToDecision(row) : null;
    },

    list(threadId: string, status?: GoalDecision["status"]): GoalDecision[] {
      const rows = (byThread.all(threadId) as DecisionRow[]).map(rowToDecision);
      return status ? rows.filter((decision) => decision.status === status) : rows;
    },

    /** Answered decisions whose steer to the root never landed. `delivered_at`
     * is the source of truth; the pulse retries these until one lands. */
    listUndelivered(threadId: string): GoalDecision[] {
      return (byThread.all(threadId) as DecisionRow[])
        .filter((row) => row.status === "answered" && row.delivered_at == null)
        .map(rowToDecision);
    },

    markDelivered(threadId: string, id: string): void {
      markDeliveredStmt.run({ thread_id: threadId, id, delivered_at: Date.now() });
    },

    /**
     * Resolve an open decision; the first valid resolution wins atomically.
     * An identical retry or a conflicting resolution writes nothing and returns
     * the row as committed — the FIRST resolution's status and answer — because
     * callers rely on the non-null shape and read `null` as "no such decision"
     * (applyDecisionAnswer returns false, resolve_decision reports "decision
     * not found", the CLI prints "Decision not found"). An id no row owns
     * still resolves to null.
     */
    resolve(
      threadId: string,
      id: string,
      status: "answered" | "withdrawn",
      answer: string,
    ): GoalDecision | null {
      resolveStmt.run({
        thread_id: threadId,
        id,
        status,
        answer: answer.trim() || null,
        answered_at: Date.now(),
      });
      return this.get(threadId, id);
    },

    clear(threadId: string): void {
      clearStmt.run(threadId);
    },
  };
}

export type DecisionStore = ReturnType<typeof createDecisionStore>;
