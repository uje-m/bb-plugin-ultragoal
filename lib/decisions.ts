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
  };
}

function newId(): string {
  return `dec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * A decision row whose persisted owner key is not the goal that created it.
 * Raised instead of returning a decision the owning goal cannot read back.
 */
export class DecisionOwnerMismatchError extends Error {
  constructor(
    readonly owner: string,
    readonly decisionId: string,
    readonly persistedOwner: string | null,
  ) {
    super(
      persistedOwner === null
        ? `Owner decision ${decisionId} was not persisted under goal ${owner}`
        : `Owner decision ${decisionId} was persisted under ${persistedOwner} instead of goal ${owner}`,
    );
    this.name = "DecisionOwnerMismatchError";
  }
}

export function createDecisionStore(bb: BbPluginApi) {
  const db = bb.storage.database();
  const byThread = db.prepare(
    "SELECT * FROM goal_decisions WHERE thread_id = ? ORDER BY created_at ASC",
  );
  const byId = db.prepare("SELECT * FROM goal_decisions WHERE thread_id = ? AND id = ?");
  const persistedOwnerOf = db.prepare("SELECT thread_id FROM goal_decisions WHERE id = ?");
  const insert = db.prepare(`
    INSERT INTO goal_decisions (id, thread_id, question, context, options, status, answer, created_at, answered_at)
    VALUES (@id, @thread_id, @question, @context, @options, @status, @answer, @created_at, @answered_at)
  `);
  const resolveStmt = db.prepare(`
    UPDATE goal_decisions SET status = @status, answer = @answer, answered_at = @answered_at
    WHERE thread_id = @thread_id AND id = @id
  `);
  const clearStmt = db.prepare("DELETE FROM goal_decisions WHERE thread_id = ?");

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
      };
      if (!existing) insert.run(row);
      // Owner decisions are keyed by the goal that owns them: the row handed
      // back must be the row that same key reads, so the persisted owner is
      // proved here rather than assumed from the insert argument.
      const persistedOwner = (
        persistedOwnerOf.get(row.id) as { thread_id: string } | undefined
      )?.thread_id;
      if (persistedOwner !== threadId) {
        throw new DecisionOwnerMismatchError(threadId, row.id, persistedOwner ?? null);
      }
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

    resolve(
      threadId: string,
      id: string,
      status: "answered" | "withdrawn",
      answer: string,
    ): GoalDecision | null {
      const existing = this.get(threadId, id);
      if (!existing) return null;
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
