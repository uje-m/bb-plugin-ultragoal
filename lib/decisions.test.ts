import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createFakePluginHost,
  makeThreadResponse,
  type CreateFakePluginHostOptions,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import type { GoalSnapshot } from "../contract.js";
import { createCollabStore } from "./collab.ts";
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

  it("files a childless worker's decision under the goal root its own state projects", async () => {
    const root = "thr_decision_owner_root";
    const childless = "thr_decision_childless";
    const host = registeredHost({
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            status: "idle",
            parentThreadId: threadId === childless ? root : null,
          }),
      },
    });
    const db = host.bb.storage.database();
    await startGoal(host, root, "Prove a childless worker's decision is owned by its goal root");

    // No collab row recorded this child's tree, so the caller-derived key is the
    // child itself while the goal its own tool surface resolves is the root.
    // That difference is the defect: keying by the caller-derived id files the
    // decision where the goal's projection never reads it.
    const collab = createCollabStore(host.bb);
    assert.equal(collab.rootId(childless), childless);
    assert.notEqual(collab.rootId(childless), root);

    const decisionId = await requestDecision(
      host,
      childless,
      "Does a childless worker's question land under the goal root?",
    );
    const row = db
      .prepare("SELECT thread_id, status FROM goal_decisions WHERE id = ?")
      .get(decisionId) as { thread_id: string; status: string };
    assert.equal(row.thread_id, root, "the decision must be owned by the goal row, not the caller");
    assert.equal(row.status, "open");

    const rootState = await callTool(host, "ultragoal_state", {}, root);
    assert.equal(rootState.isError, false, rootState.text);
    assert.deepEqual(openDecisionIds(rootState.text), [decisionId]);

    // The child reads the same board through the same resolution.
    const childState = await callTool(host, "ultragoal_state", {}, childless);
    assert.equal(childState.isError, false, childState.text);
    assert.deepEqual(openDecisionIds(childState.text), [decisionId]);
  });

  it("never shadows a thread's own unfinished goal with an ancestor's", async () => {
    const root = "thr_shadow_root";
    const child = "thr_shadow_child";
    const host = registeredHost({
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            status: "idle",
            parentThreadId: threadId === child ? root : null,
          }),
      },
    });
    const db = host.bb.storage.database();
    // Child first, parent second: ultragoal_start keys a thread with no goal of
    // its own by the caller-derived root, and no collab row records the child's
    // tree, so both threads end up owning an unfinished goal. The child's own
    // goal is then the one its tools and decisions must stay on.
    await startGoal(host, child, "Prove a child's own goal is never shadowed by its parent");
    await startGoal(host, root, "Prove the parent's goal does not retarget the child");

    const decisionId = await requestDecision(
      host,
      child,
      "Does the shadowed thread's decision stay on its own goal?",
    );
    const row = db
      .prepare("SELECT thread_id, status FROM goal_decisions WHERE id = ?")
      .get(decisionId) as { thread_id: string; status: string };
    assert.equal(row.thread_id, child, "the caller's own goal must own its decision");
    assert.equal(row.status, "open");

    const childState = await callTool(host, "ultragoal_state", {}, child);
    assert.equal(childState.isError, false, childState.text);
    assert.match(childState.text, /never shadowed by its parent/);
    assert.deepEqual(openDecisionIds(childState.text), [decisionId]);
    const rootState = await callTool(host, "ultragoal_state", {}, root);
    assert.equal(rootState.isError, false, rootState.text);
    assert.match(rootState.text, /does not retarget the child/);
    assert.deepEqual(openDecisionIds(rootState.text), []);

    // The completion gate must read the child's own decision, not the parent's
    // clean board, which would complete the wrong goal while this one is open.
    const gated = await callTool(
      host,
      "ultragoal_finish",
      { status: "complete", summary: "A summary long enough to pass the completion length check." },
      child,
    );
    assert.equal(gated.isError, true, gated.text);
    assert.match(gated.text, new RegExp(decisionId));

    const resolved = await callTool(
      host,
      "resolve_decision",
      { decision: decisionId, resolution: "answered", answer: "Stay on the child's own goal." },
      child,
    );
    assert.equal(resolved.isError, false, resolved.text);
    const finished = await callTool(
      host,
      "ultragoal_finish",
      { status: "complete", summary: "Only the caller's own goal is completed by this finish." },
      child,
    );
    assert.equal(finished.isError, false, finished.text);
    const statusOf = (threadId: string) =>
      (db.prepare("SELECT status FROM goals WHERE thread_id = ?").get(threadId) as {
        status: string;
      }).status;
    assert.equal(statusOf(child), "complete");
    assert.equal(statusOf(root), "active");
  });

  it("files a parentless worker's decision under the tree root its own row recorded", async () => {
    const host = registeredHost();
    const db = host.bb.storage.database();
    const root = "thr_decision_parentless_root";
    const worker = "thr_decision_parentless";
    await startGoal(host, root, "Prove a row with no parent still names the goal tree it belongs to");
    // parent_thread_id is nullable, so the recorded root_thread_id is the only
    // tree reference this row carries. The caller-derived key is the worker
    // itself while the tree root it recorded is the goal.
    db.prepare(`
      INSERT INTO collab_agents (
        thread_id, root_thread_id, parent_thread_id, task_name, created_at,
        display_name, item_id, role
      ) VALUES (?, ?, NULL, '/root/parentless-worker', 1, 'Parentless Worker', NULL, 'worker')
    `).run(worker, root);
    assert.equal(createCollabStore(host.bb).rootId(worker), root);

    const decisionId = await requestDecision(
      host,
      worker,
      "Does a parentless worker's question land under the recorded tree root?",
    );
    const row = db
      .prepare("SELECT thread_id, status FROM goal_decisions WHERE id = ?")
      .get(decisionId) as { thread_id: string; status: string };
    assert.equal(row.thread_id, root, "the recorded tree root must own the decision");
    assert.equal(row.status, "open");

    const rootState = await callTool(host, "ultragoal_state", {}, root);
    assert.equal(rootState.isError, false, rootState.text);
    assert.deepEqual(openDecisionIds(rootState.text), [decisionId]);

    // resolve_decision reads and writes through the same owner key.
    const resolved = await callTool(
      host,
      "resolve_decision",
      { decision: decisionId, resolution: "answered", answer: "Yes, under the recorded root." },
      worker,
    );
    assert.equal(resolved.isError, false, resolved.text);
    const after = await callTool(host, "ultragoal_state", {}, root);
    assert.equal(after.isError, false, after.text);
    assert.deepEqual(openDecisionIds(after.text), []);
  });

  it("refuses to return a decision row the goal cannot read back", () => {
    const host = registeredHost();
    const db = host.bb.storage.database();
    const owner = "thr_decision_guard";
    // The store only accepts an owner key that names a goal row, so give this
    // thread a real goal and let the trigger hijack the persisted key instead.
    db.prepare("UPDATE goals SET thread_id = ? WHERE thread_id = 'thr_sentinel'").run(owner);
    db.exec(`
      CREATE TRIGGER decision_owner_hijack AFTER INSERT ON goal_decisions
      BEGIN
        UPDATE goal_decisions SET thread_id = 'thr_not_the_goal' WHERE id = NEW.id;
      END;
    `);
    const decisions = createDecisionStore(host.bb);
    assert.throws(
      () => decisions.request(owner, { question: "Who owns this row?" }),
      (error: unknown) => {
        assert.ok(error instanceof DecisionOwnerMismatchError);
        assert.equal(error.persistedOwner, "thr_not_the_goal");
        return true;
      },
    );
    // The refused write is rolled back whole: no row under the goal and none
    // under the hijack key either.
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM goal_decisions").get() as { n: number }).n,
      0,
      "a refused owner key must leave no open decision row behind",
    );
  });

  it("rejects an owner key that names no goal row", () => {
    const host = registeredHost();
    const decisions = createDecisionStore(host.bb);
    assert.throws(
      () => decisions.request("thr_not_a_goal", { question: "Does a goal-less key persist?" }),
      (error: unknown) => {
        assert.ok(error instanceof DecisionOwnerMismatchError);
        assert.equal(error.persistedOwner, null);
        return true;
      },
    );
    assert.equal(
      (
        host.bb.storage.database().prepare("SELECT COUNT(*) AS n FROM goal_decisions").get() as {
          n: number;
        }
      ).n,
      0,
    );
  });

  it("refuses to resolve a decision once its goal row is gone, naming the decision", async () => {
    const host = registeredHost();
    const root = "thr_decision_orphan";
    await startGoal(host, root, "Prove a decision cannot be answered after its goal row is cleared");
    const decisionId = await requestDecision(host, root, "Answer this before the goal is cleared?");
    host.bb.storage.database().prepare("DELETE FROM goals WHERE thread_id = ?").run(root);

    const resolved = await callTool(
      host,
      "resolve_decision",
      { decision: decisionId, resolution: "answered", answer: "The goal is gone." },
      root,
    );
    assert.equal(resolved.isError, true);
    assert.match(resolved.text, new RegExp(decisionId));
    // The refusal changed nothing: the decision is still open, not silently
    // answered against a goal that no longer exists.
    assert.equal(
      (
        host.bb.storage.database().prepare("SELECT status FROM goal_decisions WHERE id = ?").get(
          decisionId,
        ) as { status: string } | undefined
      )?.status,
      "open",
    );
  });
});

describe("owner decision delivery", () => {
  const deliveredAtOf = (host: FakePluginHost, id: string): number | null =>
    (
      host.bb.storage.database()
        .prepare("SELECT delivered_at FROM goal_decisions WHERE id = ?")
        .get(id) as { delivered_at: number | null } | undefined
    )?.delivered_at ?? null;

  it("marks the root's own resolution delivered and delivers a worker's relay only once the root is steered", async () => {
    const root = "thr_delivery_root";
    const worker = "thr_delivery_relay";
    let steerRefusal: string | null = null;
    const host = registeredHost({
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            status: "active",
            parentThreadId: threadId === worker ? root : null,
          }),
        send: async () => {
          if (steerRefusal) throw new Error(steerRefusal);
          return { ok: true };
        },
      },
    });
    const drain = async () => {
      for (let index = 0; index < 5; index += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    await startGoal(host, root, "Prove delivery is recorded only after the root is steered");

    // The root answered a ruling it asked itself: it already holds the answer
    // in-band, so the resolution IS the delivery and no steer is owed.
    const inBand = await requestDecision(host, root, "Does the root's own resolution deliver itself?");
    const resolvedInBand = await callTool(
      host,
      "resolve_decision",
      { decision: inBand, resolution: "answered", answer: "Yes" },
      root,
    );
    assert.equal(resolvedInBand.isError, false, resolvedInBand.text);
    assert.notEqual(
      deliveredAtOf(host, inBand),
      null,
      "the root holds an answer it resolved itself, so it is delivered",
    );

    // A worker relaying the owner's answer does not give the root the answer.
    // This one still has a card open, so the thread refuses every steer and the
    // answer must stay durably undelivered rather than read as a clean board.
    const openCard = await requestDecision(host, root, "Is a second card still open?");
    const relayed = await requestDecision(host, worker, "Does a worker's relay reach the root?");
    const relay = await callTool(
      host,
      "resolve_decision",
      { decision: relayed, resolution: "answered", answer: "Relayed yes" },
      worker,
    );
    assert.equal(relay.isError, false, relay.text);
    await drain();
    assert.equal(
      deliveredAtOf(host, relayed),
      null,
      "a worker's relay must not be marked delivered before the root is steered",
    );
    assert.equal(deliveredAtOf(host, openCard), null, "an unanswered card is never delivered");

    const stalled = JSON.parse(
      (await callTool(host, "ultragoal_state", {}, root)).text,
    ) as {
      goal: {
        openDecisions: Array<{ decision_id: string }>;
        pendingDeliveryDecisions: Array<{ decision_id: string; answer: string | null }>;
      };
    };
    assert.deepEqual(
      stalled.goal.openDecisions.map((decision) => decision.decision_id),
      [openCard],
      "the open card is the only thing the board reports as waiting",
    );
    assert.deepEqual(stalled.goal.pendingDeliveryDecisions, [
      { decision_id: relayed, question: "Does a worker's relay reach the root?", answer: "Relayed yes" },
    ]);

    // The steer starts working and the second answer is recorded from the CLI:
    // the sweep retries BOTH durable rows, so the relay the root never received
    // reaches it on the retry instead of being stranded as an answered row.
    steerRefusal = "thread is awaiting user interaction";
    const cliRefused = await host.harness.behavior.runCli([
      "decide",
      openCard,
      "Answered while delivery was down",
      "--thread",
      root,
    ]);
    assert.equal(cliRefused.exitCode, 0, cliRefused.stderr ?? "");
    assert.equal(
      deliveredAtOf(host, relayed),
      null,
      "a refused steer leaves every answer durable and undelivered",
    );

    steerRefusal = null;
    const cli = await host.harness.behavior.runCli(["decide", openCard, "Retry landed", "--thread", root]);
    assert.equal(cli.exitCode, 0, cli.stderr ?? "");
    assert.notEqual(
      deliveredAtOf(host, relayed),
      null,
      "the retried relay must be recorded as delivered once the root is steered",
    );
    assert.notEqual(deliveredAtOf(host, openCard), null);
    const settledBoard = JSON.parse(
      (await callTool(host, "ultragoal_state", {}, root)).text,
    ) as { goal: { pendingDeliveryDecisions: unknown[] } };
    assert.deepEqual(settledBoard.goal.pendingDeliveryDecisions, []);
  });
});

describe("owner decision resolution", () => {
  // The store only persists a decision under an owner key that names a goal
  // row, so each fixture renames the sentinel goal to its own owner thread and
  // drives the resolution seam directly: no server tool, no CLI.
  function storeOnOwner() {
    const host = registeredHost();
    const owner = `thr_resolution_${hosts.length}`;
    host.bb.storage
      .database()
      .prepare("UPDATE goals SET thread_id = ? WHERE thread_id = 'thr_sentinel'")
      .run(owner);
    return { host, owner, decisions: createDecisionStore(host.bb) };
  }

  it("keeps the first answer when a conflicting answer arrives", () => {
    const { owner, decisions } = storeOnOwner();
    const requested = decisions.request(owner, {
      question: "Which answer wins?",
      options: ["first", "second"],
    });
    const first = decisions.resolve(owner, requested.id, "answered", "first");
    assert.equal(first?.status, "answered");
    assert.equal(first?.answer, "first");

    const conflicting = decisions.resolve(owner, requested.id, "answered", "second");
    assert.equal(conflicting?.status, "answered", "the committed status is unchanged");
    assert.equal(conflicting?.answer, "first", "the first answer wins, not the conflicting one");
    assert.equal(decisions.get(owner, requested.id)?.answer, "first");
  });

  it("leaves a committed answer intact when a withdrawal arrives later", () => {
    const { owner, decisions } = storeOnOwner();
    const requested = decisions.request(owner, { question: "Answer before it is withdrawn?" });
    decisions.resolve(owner, requested.id, "answered", "keep this answer");

    const withdrawn = decisions.resolve(owner, requested.id, "withdrawn", "moot now");
    assert.equal(withdrawn?.status, "answered");
    assert.equal(withdrawn?.answer, "keep this answer");
    assert.deepEqual(
      decisions.list(owner).map((decision) => [decision.status, decision.answer]),
      [["answered", "keep this answer"]],
    );
  });

  it("keeps a committed withdrawal when an answer arrives later", () => {
    const { owner, decisions } = storeOnOwner();
    const requested = decisions.request(owner, { question: "Withdrawn before it is answered?" });
    const withdrawn = decisions.resolve(owner, requested.id, "withdrawn", "no longer needed");
    assert.equal(withdrawn?.status, "withdrawn");

    const later = decisions.resolve(owner, requested.id, "answered", "answer after the withdrawal");
    assert.equal(later?.status, "withdrawn");
    assert.equal(later?.answer, "no longer needed");
    assert.deepEqual(
      decisions.listUndelivered(owner),
      [],
      "a withdrawal is never an owner answer awaiting delivery",
    );
  });

  it("returns the committed decision without rewriting the row on a retry or a conflict", () => {
    const { host, owner, decisions } = storeOnOwner();
    const db = host.bb.storage.database();
    const requested = decisions.request(owner, { question: "Retry the same answer?" });
    const committed = decisions.resolve(owner, requested.id, "answered", "the answer");

    // Physical writes only: a guarded UPDATE that matches no row fires this
    // trigger zero times, so it proves the resolved row was not rewritten.
    db.exec(`
      CREATE TABLE decision_writes (n INTEGER NOT NULL);
      INSERT INTO decision_writes VALUES (0);
      CREATE TRIGGER count_decision_writes AFTER UPDATE ON goal_decisions
      BEGIN
        UPDATE decision_writes SET n = n + 1;
      END;
    `);

    assert.deepEqual(
      decisions.resolve(owner, requested.id, "answered", "the answer"),
      committed,
      "an identical retry returns the committed decision",
    );
    assert.deepEqual(
      decisions.resolve(owner, requested.id, "answered", "a different answer"),
      committed,
    );
    assert.deepEqual(decisions.resolve(owner, requested.id, "withdrawn", "moot"), committed);
    assert.equal(
      (db.prepare("SELECT n FROM decision_writes").get() as { n: number }).n,
      0,
      "a retry or a conflict must not write the resolved row again",
    );
  });

  it("resolves an unknown decision id to null", () => {
    const { owner, decisions } = storeOnOwner();
    assert.equal(decisions.resolve(owner, "dec_missing", "answered", "no such decision"), null);
    assert.equal(decisions.resolve(owner, "dec_missing", "withdrawn", "no such decision"), null);
    assert.deepEqual(decisions.list(owner), [], "a null resolution persists no row");
  });
});
