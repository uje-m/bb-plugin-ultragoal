import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  budgetLimitPrompt,
  continuationPrompt,
  MAX_PLAN_INSTRUCTION_CHARS,
  MAX_PROMPT_CHARS,
  objectiveUpdatedPrompt,
  planInstruction,
  progressPrompt,
  workerQualityBrief,
} from "./prompts.ts";
import { makeLargeGoal } from "./test-goal.ts";

function makeWorstCaseGoal() {
  const goal = makeLargeGoal();
  goal.objective = `Objective marker: ${"expanded requirement detail ".repeat(220)}`;
  goal.decisions = Array.from({ length: 25 }, (_, index) => ({
    id: `dec_${String(index).padStart(3, "0")}`,
    question: `Owner choice ${index}?`,
    context: null,
    options: ["yes", "no"],
    status: "open" as const,
    answer: null,
    createdAt: index,
    deliveredAt: null,
  }));
  return goal;
}

describe("bounded UltraGoal prompts", () => {
  it("keeps a 1,000-item plan at or below 6KB without completed bodies", () => {
    const instruction = planInstruction(makeLargeGoal());
    assert.ok(instruction.length <= MAX_PLAN_INSTRUCTION_CHARS);
    assert.equal(MAX_PLAN_INSTRUCTION_CHARS, 6_000);
    assert.doesNotMatch(instruction, /COMPLETED_BODY_/);
    assert.match(instruction, /1000 total; 800 completed; 10 in progress; 100 ready; 90 blocked/);
    assert.match(instruction, /open work item\(s\) omitted/);
    assert.match(instruction, /ultragoal_state with plan_status\/plan_cursor\/plan_limit/);
  });

  it("keeps automatic wake-ups compact and operational", () => {
    const goal = makeLargeGoal();
    const continuation = continuationPrompt(goal);
    const progress = progressPrompt(goal);
    assert.ok(continuation.length <= MAX_PROMPT_CHARS, `continuation was ${continuation.length} chars`);
    assert.ok(progress.length < 8_000, `progress was ${progress.length} chars`);
    assert.doesNotMatch(continuation, /COMPLETED_BODY_/);
    assert.doesNotMatch(progress, /COMPLETED_BODY_/);
    assert.doesNotMatch(progress, /PUSH the remote/i);
    assert.match(progress, /does not merge branches or push remotes/i);
    assert.match(workerQualityBrief("integration"), /Workers never push/);
    assert.doesNotMatch(workerQualityBrief("integration"), /pushing origin is solely/i);
    assert.match(continuation, /compact wake-up, not a new goal/);
  });

  it("holds every automatically rendered prompt inside the request limit", () => {
    // BB's server rejects request bodies above ~8000 characters, and the old
    // surfaces had no shared bound: a 6,000-character objective rendered
    // continuationPrompt at ~13.6k, so the wake-up never reached the model.
    const goal = makeWorstCaseGoal();
    const longBranch = `factory/${"overlong-branch-name-".repeat(60)}`;
    const rendered: Array<[string, string]> = [
      ["continuationPrompt", continuationPrompt(goal)],
      ["progressPrompt", progressPrompt(goal)],
      ["budgetLimitPrompt", budgetLimitPrompt(goal)],
      ["objectiveUpdatedPrompt", objectiveUpdatedPrompt(goal)],
      ["workerQualityBrief", workerQualityBrief(longBranch)],
    ];
    assert.ok(MAX_PROMPT_CHARS <= 8_000, `bound was ${MAX_PROMPT_CHARS}`);
    for (const [name, text] of rendered) {
      assert.ok(text.length <= MAX_PROMPT_CHARS, `${name} was ${text.length} chars`);
    }
    for (const text of [continuationPrompt(goal), progressPrompt(goal)]) {
      assert.match(text, /Objective marker: /);
      assert.match(text, /objective truncated to fit the request limit/);
    }
    for (const text of [budgetLimitPrompt(goal), objectiveUpdatedPrompt(goal)]) {
      assert.match(text, /Objective marker: /);
    }
  });

  it("keeps the DECISIONS line and every decision id when the objective is trimmed", () => {
    // The objective is untrusted data and is trimmed first; a decision marker
    // sliced away to make room for it is a failed round, not a compact one.
    const goal = makeWorstCaseGoal();
    for (const text of [continuationPrompt(goal), progressPrompt(goal)]) {
      const decisionsLine = text.split("\n").find((line) => line.startsWith("DECISIONS:"));
      assert.ok(decisionsLine, "the DECISIONS line survives compaction");
      assert.match(decisionsLine, /25 owner decision\(s\) await the user/);
      for (const decision of goal.decisions) {
        assert.match(decisionsLine, new RegExp(decision.id));
      }
    }
  });

  it("sends routine questions to the owning root without creating owner decisions", () => {
    const goal = makeLargeGoal();
    const continuation = continuationPrompt(goal);
    const progress = progressPrompt(goal);
    for (const brief of [workerQualityBrief("integration"), workerQualityBrief(null)]) {
      for (const literal of [
        "owning root",
        "ultragoal_send_message",
        "no owner decision",
        "request_decision",
      ]) {
        assert.match(brief, new RegExp(literal));
      }
    }
    for (const literal of [
      "owning root",
      "ultragoal_send_message",
      "request_decision",
      "not an owner decision",
      "timeout",
      "approval",
    ]) {
      assert.match(continuation, new RegExp(literal));
    }
    assert.match(continuation, /routine/i);
    assert.match(progress, /owning root/);
    assert.match(progress, /routine/i);
  });
});

describe("worker quality brief plumbing", () => {
  it("names the goal's resolved integration branch instead of assuming main", () => {
    // Field case: this brief hardcoded `main`, but in omegacode `main` is a
    // passive upstream tracker and `integration` is the maintained base. Two
    // workers were sent at the wrong branch; both were careful enough to
    // refuse, and a third would have rebased a candidate onto foreign history.
    const brief = workerQualityBrief("integration");
    assert.match(brief, /`integration`/);
    assert.doesNotMatch(brief, /rebase onto `main`/);
  });

  it("tells a worker with no resolved branch to read it, never to guess main", () => {
    // The silent-failure mode: when the root environment cannot be read the
    // brief must escalate to "go look it up", not fall back to a branch name.
    const brief = workerQualityBrief(null);
    assert.match(brief, /never assume `main`/i);
    assert.doesNotMatch(brief, /rebase onto `main`/);
    // And it must not send them somewhere they cannot look: a managed worktree
    // cannot read the root thread's checkout, which is why the name is
    // normally resolved server-side. Fail closed instead.
    assert.match(brief, /slice_blocked/);
  });

  it("leaves no unrendered placeholder in either arm", () => {
    // render() substitutes a missing key with "", so a renamed placeholder
    // would blank the branch name rather than fail loudly.
    assert.doesNotMatch(workerQualityBrief("integration"), /\{\{/);
    assert.doesNotMatch(workerQualityBrief(null), /\{\{/);
  });

  it("pins the battery to the exact command and forbids a bare substitute", () => {
    // Three workers ran a bare `npm test` because the repo's qualified battery
    // lived only in the orchestrator's head. Default scheduling fails under
    // load and its retries are inconclusive, so a shortened run is not a
    // receipt and must not be cited as one.
    const brief = workerQualityBrief("integration");
    assert.match(brief, /exact command/i);
    assert.match(brief, /npm test/);
    assert.match(brief, /not evidence/i);
    assert.match(brief, /never be cited as one/);
    // Fail closed. A rule that only bites when the repo's docs happen to pin a
    // command is no rule here: omegacode's docs pin the unqualified `npm test`,
    // which is the hole all three workers fell through. Absent a pinned
    // command the worker reports the gap; it never promotes a default run.
    assert.match(brief, /you have not established it/);
  });

  it("makes host load a precondition of starting a battery", () => {
    // 2026-09-14: three simultaneous batteries drove this host to loadavg 95.6
    // with 64 concurrent node --test processes and starved a live Prove-phase
    // battery for 29 minutes.
    const brief = workerQualityBrief("integration");
    assert.match(brief, /\/proc\/loadavg/);
    assert.match(brief, /~12/);
    // Scoped to parallel batteries on purpose. This host idles around 20-30,
    // so a threshold that also covered a three-second single-process suite
    // would be ignored within a day, taking the rule that matters with it.
    assert.match(brief, /process per CPU/);
  });

  it("judges a command by its own flags, not by the authority that named it", () => {
    // The residual half of the same hole. The rule delegates to the repo's
    // agent docs, and omegacode's CLAUDE.md pins `npm test` with no scheduling
    // limit — so "run the one the docs name, verbatim" hands the violating
    // command back as a receipt and the fail-closed arm is never reached. A
    // rule that delegates to a source inherits that source's wrongness unless
    // it also says what makes a command qualified.
    const brief = workerQualityBrief("integration");
    assert.match(brief, /forks a process per CPU and names no scheduling limit/);
    assert.match(brief, /however authoritative/i);
    // The fail-closed arm has to be reachable when a source DID name one.
    assert.match(brief, /cannot be repaired that way/);
  });

  it("lets a worker add the absent scheduling limit rather than stall on it", () => {
    // The arm the rule above creates. A repo whose only defect is the missing
    // limit — its script already covers the right scope — could otherwise
    // produce no test receipt at all, and a fail-closed rule that forbids
    // every run quietly becomes a fail-silent one: no gate is ever cited and
    // nobody notices it stopped being run.
    const brief = workerQualityBrief("integration");
    assert.match(brief, /qualify it yourself/);
    // Self-qualification adds the limit; it never trims the battery, which is
    // the shortened substitute the same paragraph forbids two sentences on.
    assert.match(brief, /same scope/);
    assert.match(brief, /nothing dropped/);
  });
});
