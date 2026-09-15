import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createFakePluginHost,
  type CreateFakePluginHostOptions,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import type { GoalSnapshot } from "../contract.js";
import { DecisionOwnerMismatchError, createDecisionStore } from "./decisions.ts";
import { progressPrompt } from "./prompts.ts";

const hosts: FakePluginHost[] = [];

const isToolError = (result: unknown): boolean =>
  typeof result === "object" && result !== null && "isError" in result
    ? (result as { isError?: boolean }).isError === true
    : false;

afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()!.harness.lifecycle.dispose();
});

function registeredHost(sdk?: CreateFakePluginHostOptions["sdk"]) {
  const host = createFakePluginHost({
    pluginId: `ultragoal-decisions-${hosts.length}`,
    agentSkillIds: ["ultragoal"],
    sdk,
  });
  hosts.push(host);
  // Keep this registration test isolated from the developer machine's
  // optional ~/.bb/plugins/goal legacy database import. A sentinel row makes
  // createGoalStore skip that one-time import while still running migrations.
  host.bb.storage.database().exec(`
    CREATE TABLE goals (
      thread_id TEXT PRIMARY KEY,
      objective TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      turn_count INTEGER NOT NULL,
      max_turns INTEGER NOT NULL,
      max_minutes INTEGER NOT NULL,
      last_continue_at INTEGER,
      last_assistant_hash TEXT
    );
    INSERT INTO goals VALUES ('thr_sentinel', 'test', 'complete', NULL, 1, 1, 1, 0, 0, 0, NULL, NULL);
  `);
  plugin(host.bb);
  return host;
}

async function callTool(
  host: FakePluginHost,
  name: string,
  input: unknown,
  threadId: string,
): Promise<{ isError: boolean; text: string }> {
  const result = await host.harness.behavior.callAgentTool(name, input, { threadId });
  if (typeof result === "string") return { isError: false, text: result };
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return {
    isError: isToolError(result),
    text: content.map((part) => part.text ?? "").join("\n"),
  };
}

async function startGoal(host: FakePluginHost, threadId: string, objective: string): Promise<void> {
  const started = await callTool(host, "ultragoal_start", { objective }, threadId);
  assert.equal(started.isError, false, started.text);
}

async function requestDecision(
  host: FakePluginHost,
  threadId: string,
  question: string,
): Promise<string> {
  const requested = await callTool(
    host,
    "request_decision",
    { question, context: "Ownership is under test.", options: ["yes", "no"] },
    threadId,
  );
  assert.equal(requested.isError, false, requested.text);
  const parsed = JSON.parse(requested.text) as { decision_id: string; status: string };
  assert.match(parsed.decision_id, /^dec_/);
  assert.equal(parsed.status, "open");
  return parsed.decision_id;
}

function openDecisionIds(text: string): string[] {
  const parsed = JSON.parse(text) as { goal: { openDecisions: Array<{ decision_id: string }> } };
  return parsed.goal.openDecisions.map((decision) => decision.decision_id);
}

describe("owner decision ownership", () => {
  it("shows the decision id request_decision returned in the goal's own state and prompt", async () => {
    const host = registeredHost();
    const root = "thr_decision_agreement";
    await startGoal(host, root, "Prove owner decisions land in the projection that reads them");
    // The DECISIONS tail line renders with the working-set plan, so the goal
    // needs one real work item for the prompt assertion below.
    const patched = await callTool(
      host,
      "ultragoal_patch",
      { plan: [{ step: "Keep the decision projection authoritative", status: "pending" }] },
      root,
    );
    assert.equal(patched.isError, false, patched.text);
    const decisionId = await requestDecision(host, root, "Ship the migration in this goal?");

    const state = await callTool(host, "ultragoal_state", {}, root);
    assert.equal(state.isError, false, state.text);
    assert.deepEqual(openDecisionIds(state.text), [decisionId]);

    const rpc = (await host.harness.behavior.callRpc("getGoal", { threadId: root })) as {
      goal: GoalSnapshot;
    };
    assert.deepEqual(rpc.goal.decisions.map((decision) => decision.id), [decisionId]);
    const decisionsLine = progressPrompt(rpc.goal)
      .split("\n")
      .find((line) => line.startsWith("DECISIONS:"));
    assert.ok(decisionsLine, "the progress prompt renders a DECISIONS line");
    assert.match(decisionsLine, new RegExp(decisionId));
  });

  it("keeps the decision open across a plugin generation and closes it only on resolution", async () => {
    const host = registeredHost();
    const root = "thr_decision_reload";
    await startGoal(host, root, "Prove an owner decision survives a plugin reload");
    const decisionId = await requestDecision(
      host,
      root,
      "Is the durable decision still open after reload?",
    );

    const reloaded = await host.harness.lifecycle.reload(plugin);
    hosts.push(reloaded);

    const before = await callTool(reloaded, "ultragoal_state", {}, root);
    assert.equal(before.isError, false, before.text);
    assert.deepEqual(openDecisionIds(before.text), [decisionId]);

    const resolved = await callTool(
      reloaded,
      "resolve_decision",
      { decision: decisionId, resolution: "answered", answer: "Yes, it survived the reload." },
      root,
    );
    assert.equal(resolved.isError, false, resolved.text);

    const after = await callTool(reloaded, "ultragoal_state", {}, root);
    assert.equal(after.isError, false, after.text);
    assert.deepEqual(openDecisionIds(after.text), []);
  });

  it("refuses completion while the decision is open and allows it after the answer", async () => {
    const host = registeredHost();
    const root = "thr_decision_gate";
    await startGoal(host, root, "Prove the completion gate reads the goal's own decisions");
    const decisionId = await requestDecision(
      host,
      root,
      "May the goal be completed before this answer?",
    );

    const refused = await callTool(
      host,
      "ultragoal_finish",
      {
        status: "complete",
        summary: "A substantive delivery summary long enough to pass the minimum length check.",
      },
      root,
    );
    assert.equal(refused.isError, true);
    assert.match(refused.text, /owner decision/);
    assert.match(refused.text, new RegExp(decisionId));

    const resolved = await callTool(
      host,
      "resolve_decision",
      { decision: decisionId, resolution: "answered", answer: "Yes, complete it." },
      root,
    );
    assert.equal(resolved.isError, false, resolved.text);

    const finished = await callTool(
      host,
      "ultragoal_finish",
      {
        status: "complete",
        summary: "The answered decision unblocked completion of this durable UltraGoal run.",
      },
      root,
    );
    assert.equal(finished.isError, false, finished.text);
    assert.equal(
      (
        host.bb.storage.database()
          .prepare("SELECT status FROM goals WHERE thread_id = ?")
          .get(root) as { status: string }
      ).status,
      "complete",
    );
  });

  it("stores root and worker decisions under the goal's own thread id", async () => {
    const host = registeredHost();
    const db = host.bb.storage.database();
    const root = "thr_decision_owner";
    await startGoal(host, root, "Prove the write owner and the projection owner are one key");
    db.prepare(`
      INSERT INTO collab_agents (
        thread_id, root_thread_id, parent_thread_id, task_name, created_at,
        display_name, item_id, role
      ) VALUES ('thr_decision_worker', ?, ?, '/root/decision-worker', 1,
        'Decision Worker', NULL, 'worker')
    `).run(root, root);

    const rootDecisionId = await requestDecision(host, root, "Does the root question land here?");
    const rootRow = db
      .prepare("SELECT thread_id, status FROM goal_decisions WHERE id = ?")
      .get(rootDecisionId) as { thread_id: string; status: string };
    assert.equal(rootRow.thread_id, root);
    assert.equal(rootRow.status, "open");

    const workerDecisionId = await requestDecision(
      host,
      "thr_decision_worker",
      "Does a worker's question land under the goal root?",
    );
    const workerRow = db
      .prepare("SELECT thread_id FROM goal_decisions WHERE id = ?")
      .get(workerDecisionId) as { thread_id: string };
    assert.equal(workerRow.thread_id, root);

    const state = await callTool(host, "ultragoal_state", {}, root);
    assert.equal(state.isError, false, state.text);
    assert.deepEqual(openDecisionIds(state.text).sort(), [rootDecisionId, workerDecisionId].sort());
  });

  it("refuses to return a decision row the goal cannot read back", () => {
    const host = registeredHost();
    const db = host.bb.storage.database();
    // A store writing a caller-derived key persists the row under a thread the
    // goal never reads. The owner guard must refuse that row instead of handing
    // back an id the goal's own projection can never show.
    db.exec(`
      CREATE TRIGGER decision_owner_hijack AFTER INSERT ON goal_decisions
      BEGIN
        UPDATE goal_decisions SET thread_id = 'thr_not_the_goal' WHERE id = NEW.id;
      END;
    `);
    const decisions = createDecisionStore(host.bb);
    assert.throws(
      () => decisions.request("thr_decision_guard", { question: "Who owns this row?" }),
      DecisionOwnerMismatchError,
    );
    assert.equal(
      db
        .prepare("SELECT id FROM goal_decisions WHERE thread_id = 'thr_decision_guard'")
        .get() as { id: string } | undefined,
      undefined,
    );
  });
});
