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
