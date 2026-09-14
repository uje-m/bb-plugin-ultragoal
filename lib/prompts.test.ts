import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  continuationPrompt,
  MAX_PLAN_INSTRUCTION_CHARS,
  planInstruction,
  progressPrompt,
  workerQualityBrief,
} from "./prompts.ts";
import { makeLargeGoal } from "./test-goal.ts";

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
    assert.ok(continuation.length < 8_500, `continuation was ${continuation.length} chars`);
    assert.ok(progress.length < 8_000, `progress was ${progress.length} chars`);
    assert.doesNotMatch(continuation, /COMPLETED_BODY_/);
    assert.doesNotMatch(progress, /COMPLETED_BODY_/);
    assert.doesNotMatch(progress, /PUSH the remote/i);
    assert.match(progress, /does not merge branches or push remotes/i);
    assert.match(workerQualityBrief("integration"), /Workers never push/);
    assert.doesNotMatch(workerQualityBrief("integration"), /pushing origin is solely/i);
    assert.match(continuation, /compact wake-up, not a new goal/);
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
});
