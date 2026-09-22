import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatGoalCard, goalToolResponse, MAX_STATUS_DECISIONS } from "./status.ts";
import { makeLargeGoal } from "./test-goal.ts";

function undeliveredDecisions(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `dec_lost_${index}`,
    question: `Question ${index}?`,
    context: null,
    options: [],
    status: "answered" as const,
    answer: `Answer ${index}`,
    createdAt: index,
    deliveredAt: null,
  }));
}

describe("bounded goal reads", () => {
  it("defaults ultragoal_state to the first 40 open work items with a continuation cursor", () => {
    const parsed = JSON.parse(goalToolResponse(makeLargeGoal())) as any;
    assert.deepEqual(parsed.goal.planSummary, {
      total: 1_000,
      open: 200,
      pending: 190,
      inProgress: 10,
      completed: 800,
    });
    assert.equal(parsed.goal.plan.length, 40);
    assert.equal(parsed.goal.planPage.status, "open");
    assert.equal(parsed.goal.planPage.nextCursor, 40);
    assert.equal(parsed.goal.agents.length, 10);
    assert.doesNotMatch(JSON.stringify(parsed.goal.plan), /COMPLETED_BODY_/);
  });

  it("pages completed work explicitly without exporting the full plan", () => {
    const parsed = JSON.parse(
      goalToolResponse(makeLargeGoal(), false, [], {
        planStatus: "completed",
        planCursor: 790,
        planLimit: 25,
      }),
    ) as any;
    assert.equal(parsed.goal.plan.length, 10);
    assert.equal(parsed.goal.plan[0].item_id, "itm_0790");
    assert.equal(parsed.goal.planPage.nextCursor, null);
  });

  it("keeps CLI status bounded to a working set", () => {
    const card = formatGoalCard(makeLargeGoal());
    assert.match(card, /Plan: 800\/1000 complete; 10 in progress; 190 pending/);
    assert.match(card, /160 more open work item\(s\) omitted/);
    assert.doesNotMatch(card, /COMPLETED_BODY_/);
    assert.ok(card.length < 30_000, `status card was ${card.length} chars`);
  });

  it("reports an answered-but-undelivered decision instead of an empty board", () => {
    const goal = makeLargeGoal();
    goal.decisions = [];
    goal.undeliveredDecisions = [
      {
        id: "dec_lost",
        question: "Authorize the launch?",
        context: null,
        options: ["Yes", "No"],
        status: "answered",
        answer: "Yes",
        createdAt: 1,
        deliveredAt: null,
      },
    ];
    const parsed = JSON.parse(goalToolResponse(goal)) as any;
    assert.deepEqual(parsed.goal.openDecisions, []);
    assert.deepEqual(parsed.goal.pendingDeliveryDecisions, [
      { decision_id: "dec_lost", question: "Authorize the launch?", answer: "Yes" },
    ]);
    const card = formatGoalCard(goal);
    assert.match(card, /DELIVERY PENDING: \[dec_lost\]/);
    assert.doesNotMatch(card, /DELIVERED/);
    assert.doesNotMatch(card, /answered-but-undelivered decision\(s\) omitted/);
  });

  it("bounds the pending-delivery projection and says truthfully how many were omitted", () => {
    const goal = makeLargeGoal();
    goal.decisions = [];
    goal.undeliveredDecisions = undeliveredDecisions(30);
    const parsed = JSON.parse(goalToolResponse(goal)) as any;
    assert.ok(MAX_STATUS_DECISIONS < 30);
    assert.equal(parsed.goal.pendingDeliveryDecisions.length, MAX_STATUS_DECISIONS);
    for (const entry of parsed.goal.pendingDeliveryDecisions) {
      assert.match(entry.decision_id, /^dec_lost_\d+$/);
      assert.match(entry.question, /^Question \d+\?$/);
      assert.match(entry.answer, /^Answer \d+$/);
    }
    const card = formatGoalCard(goal);
    assert.equal((card.match(/DELIVERY PENDING: \[/g) ?? []).length, MAX_STATUS_DECISIONS);
    assert.match(card, /10 more answered-but-undelivered decision\(s\) omitted/);
  });

  it("only claims answered-but-undelivered omissions above the cap", () => {
    const goal = makeLargeGoal();
    goal.decisions = [];
    goal.undeliveredDecisions = undeliveredDecisions(MAX_STATUS_DECISIONS);
    const card = formatGoalCard(goal);
    assert.equal((card.match(/DELIVERY PENDING: \[/g) ?? []).length, MAX_STATUS_DECISIONS);
    assert.doesNotMatch(card, /answered-but-undelivered decision\(s\) omitted/);
  });
});
