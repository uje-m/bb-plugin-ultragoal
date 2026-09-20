import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createFakePluginHost,
  makeThreadResponse,
  type CreateFakePluginHostOptions,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { createFindingStore } from "./findings.ts";
import { createItemStore } from "./items.ts";
import { createItemReservationStore } from "./item-reservations.ts";

const hosts: FakePluginHost[] = [];

const isToolError = (result: unknown): boolean =>
  typeof result === "object" && result !== null && "isError" in result
    ? (result as { isError?: boolean }).isError === true
    : false;

// ultragoal_state answers with a JSON string while most tools answer with a
// content block; both carry the tool's text payload.
const toolText = (result: unknown): string =>
  typeof result === "string"
    ? result
    : ((result as { content?: Array<{ text?: string }> }).content ?? [])
        .map((part) => part.text ?? "")
        .join("\n");

afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()!.harness.lifecycle.dispose();
});

function registeredHost(
  sdk?: CreateFakePluginHostOptions["sdk"],
  experimentalCallHostRpc?: CreateFakePluginHostOptions["experimental_callHostRpc"],
) {
  const host = createFakePluginHost({
    pluginId: `ultragoal-tools-${hosts.length}`,
    agentSkillIds: ["ultragoal"],
    sdk,
    experimental_callHostRpc: experimentalCallHostRpc,
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

function registeredTools() {
  const host = registeredHost();
  return new Map(
    host.harness.inspection.registrations.agentTools.map((tool) => [tool.name, tool]),
  );
}

// One goal root and its intake surface for the cursor/queue/claim cases below.
// Extra roots share the same seam: `threads.timeline` and `threads.spawn` route
// by the parent root, so a single pulse sweeps each root with its own rows and
// dispatch state. Only observable behavior is exposed: courier prompts, the
// durable cursor and the inspection log — never the shape of the intake pass
// itself.
type IntakeRootState = {
  rows: Array<Record<string, unknown>>;
  spawned: Array<{ id: string; prompt: string }>;
  spawnCalls: number;
  gate: Promise<void> | null;
  refusal: string | null;
};

function intakeRoot(rootId: string, extraRootIds: string[] = []) {
  const rootStates = new Map<string, IntakeRootState>(
    [rootId, ...extraRootIds].map((id) => [
      id,
      { rows: [], spawned: [], spawnCalls: 0, gate: null, refusal: null },
    ]),
  );
  // The primary root keeps the plain `state` handle the single-root cases use.
  const state = rootStates.get(rootId)!;
  const rootState = (id: string) => {
    const value = rootStates.get(id);
    if (!value) throw new Error(`unknown intake root ${id}`);
    return value;
  };
  const parents = new Map<string, string>();
  let spawns = 0;
  const host = registeredHost({
    threads: {
      get: async ({ threadId }) =>
        makeThreadResponse({
          id: threadId,
          projectId: "proj",
          providerId: "codex",
          // No environment: the spawn must not depend on live host worktree
          // provisioning, which the fake host cannot perform.
          environmentId: null,
          parentThreadId: parents.get(threadId) ?? (rootStates.has(threadId) ? null : rootId),
          status: "active",
        }),
      list: () => [],
      timeline: ({ threadId }) => ({
        rows: (rootStates.get(threadId)?.rows ?? []) as never[],
      }),
      spawn: async (args) => {
        const target = rootStates.get(String(args.parentThreadId ?? ""));
        if (!target) throw new Error(`unexpected intake spawn for ${String(args.parentThreadId)}`);
        target.spawnCalls += 1;
        if (target.gate) await target.gate;
        if (target.refusal) throw new Error(target.refusal);
        spawns += 1;
        const id = `thr_intake_${spawns}`;
        target.spawned.push({ id, prompt: args.prompt ?? "" });
        parents.set(id, String(args.parentThreadId ?? rootId));
        return makeThreadResponse({
          id,
          projectId: "proj",
          providerId: "codex",
          environmentId: null,
          parentThreadId: String(args.parentThreadId ?? rootId),
          status: "active",
        });
      },
      output: () => ({ output: null }),
      stop: () => ({ ok: true }),
      send: () => ({ ok: true }),
      update: ({ threadId }) => makeThreadResponse({ id: threadId }),
      interactions: { list: async () => [], resolve: async () => ({}) },
    },
  });
  const db = host.bb.storage.database();
  // last_continue_at is fresh so the pulse's own progress check-in is not due:
  // these cases measure the intake retry, not the steady-state steering.
  db.prepare(
    "UPDATE goals SET thread_id = ?, status = 'active', max_workers = 1, last_continue_at = ? WHERE thread_id = 'thr_sentinel'",
  ).run(rootId, Date.now());
  // Every extra root is its own active goal row; one pulse sweeps all of them.
  for (const extraRootId of extraRootIds) {
    db.prepare(
      `INSERT INTO goals (thread_id, objective, status, reason, created_at, updated_at, started_at,
        turn_count, max_turns, max_minutes, last_continue_at, last_assistant_hash, intake_row_id, max_workers)
       SELECT ?, objective || ' extra', 'active', reason, created_at, updated_at, started_at,
        turn_count, max_turns, max_minutes, ?, last_assistant_hash, NULL, 1
       FROM goals WHERE thread_id = ?`,
    ).run(extraRootId, Date.now(), rootId);
  }
  const cursor = (threadId = rootId) =>
    (
      db.prepare("SELECT intake_row_id FROM goals WHERE thread_id = ?").get(threadId) as {
        intake_row_id: string | null;
      }
    ).intake_row_id;
  const setCap = (maxWorkers: number, threadId = rootId) => {
    db.prepare("UPDATE goals SET max_workers = ? WHERE thread_id = ?").run(maxWorkers, threadId);
  };
  const logs = () => host.harness.inspection.logEntries.map((entry) => entry.message);
  /** Let every detached continuation reach its next await before asserting. */
  const settle = async () => {
    for (let index = 0; index < 40; index += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };
  const ownerRow = (id: string, text: string) => ({
    kind: "conversation",
    role: "user",
    id,
    text,
  });
  const ownerEvent = async (threadId = rootId) => {
    const result = await host.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ id: threadId, status: "active" }),
    });
    await settle();
    return result;
  };
  /** One deterministic sweep of the 20s progress pulse (no timers in tests). */
  const pulse = async () => {
    const service = host.harness.behavior.runService("progress-pulse");
    await settle();
    service.controller.abort();
    await service.done;
    await settle();
  };
  const never = () => new Promise<void>(() => {});
  return { host, state, rootState, cursor, setCap, logs, settle, ownerRow, ownerEvent, pulse, never };
}

describe("large-plan agent tool contracts", () => {
  it("accepts paged ultragoal_state reads and caps them at 100 rows", () => {
    const tool = registeredTools().get("ultragoal_state")!;
    assert.equal(tool.parse({}).ok, true);
    assert.equal(
      tool.parse({ plan_status: "completed", plan_cursor: 900, plan_limit: 100 }).ok,
      true,
    );
    assert.equal(tool.parse({ plan_limit: 101 }).ok, false);
  });

  it("accepts patch-style ultragoal_patch batches and rejects oversized calls", () => {
    const tool = registeredTools().get("ultragoal_patch")!;
    assert.equal(tool.parse({ plan: [], remove_item_ids: ["itm_old"] }).ok, true);
    const item = { step: "A self-contained scalable slice", status: "pending" };
    assert.equal(tool.parse({ plan: Array.from({ length: 200 }, () => item) }).ok, true);
    assert.equal(tool.parse({ plan: Array.from({ length: 201 }, () => item) }).ok, false);
  });

  it("namespaces every collaboration tool and exposes no global alias", () => {
    const names = new Set(registeredTools().keys());
    for (const name of [
      "spawn_agent",
      "send_message",
      "followup_task",
      "list_agents",
      "wait_agent",
      "interrupt_agent",
      "release_slice",
      "retire_agent",
    ]) {
      assert.equal(names.has(name), false, `global alias must not be registered: ${name}`);
      assert.equal(names.has(`ultragoal_${name}`), true, `namespaced tool missing: ${name}`);
    }
  });

  it("lets only the pane RPC write standing worker rules", async () => {
    const host = registeredHost();
    await host.harness.behavior.callAgentTool(
      "ultragoal_start",
      { objective: "Keep standing rules under explicit user control" },
      { threadId: "thr_rules" },
    );
    const cli = await host.harness.behavior.runCli([
      "brief",
      "an agent tried to inject this",
      "--thread",
      "thr_rules",
    ]);
    assert.equal(cli.exitCode, 1);
    assert.match(cli.stderr ?? "", /Unknown goal command: brief/);

    const result = await host.harness.behavior.callRpc("setStandingBriefFromPane", {
      threadId: "thr_rules",
      text: "Use the repository's shared database and never start a private one.",
    }) as { goal?: { standingBrief?: { provenance?: string; text?: string } | null } | null };
    assert.equal(result.goal?.standingBrief?.provenance, "user-pane");
    assert.match(result.goal?.standingBrief?.text ?? "", /shared database/);
    const row = host.bb.storage.database().prepare(
      "SELECT provenance, updated_at FROM goal_worker_briefs WHERE thread_id = 'thr_rules'",
    ).get() as { provenance: string; updated_at: number };
    assert.equal(row.provenance, "user-pane");
    assert.ok(row.updated_at > 0);
  });

  const context = (providerId: string, threadId: string, parentThreadId: string | null = null) => ({
    thread: { id: threadId, title: "UltraGoal root", parentThreadId, sourceThreadId: null },
    project: { id: "proj", kind: "standard" as const, name: "Project", gitRemoteUrl: null },
    environment: {
      id: "env",
      name: null,
      path: "/tmp/project",
      workspaceProvisionType: "unmanaged" as const,
      branchName: "main",
    },
    host: { id: "host", name: "Host" },
    provider: {
      id: providerId,
      model: providerId === "codex" ? "gpt-5.6-sol" : "openrouter/stealth/ox-alpha",
      capabilities: { supportsNativeUserQuestion: true },
    },
    origin: { kind: null, pluginId: null },
  });

  it("gives every provider only the canonical UltraGoal skill and root controls", async () => {
    const host = registeredHost();
    const canonical = ["ultragoal_start", "ultragoal_state", "ultragoal_patch", "ultragoal_finish"];
    const removed = ["create_goal", "get_goal", "update_plan", "update_goal"];
    const registered = new Set(
      host.harness.inspection.registrations.agentTools.map((tool) => tool.name),
    );
    for (const name of canonical) assert.ok(registered.has(name), `tool registry missing ${name}`);
    for (const name of removed) assert.ok(!registered.has(name), `tool registry still contains ${name}`);
    const providers = [
      ["codex", "thr_codex"],
      ["cursor", "thr_cursor"],
      ["acp-opencode", "thr_opencode"],
      ["claude-code", "thr_claude"],
      ["pi", "thr_pi"],
    ] as const;
    const configured = new Map<string, Awaited<ReturnType<typeof host.harness.behavior.resolveAgentConfiguration>>>();
    for (const [providerId, threadId] of providers) {
      const result = await host.harness.behavior.resolveAgentConfiguration(
        context(providerId, threadId),
      );
      configured.set(providerId, result);
      const names = result.tools.map((tool) => tool.name);
      for (const name of canonical) assert.ok(names.includes(name), `${providerId} missing ${name}`);
      assert.equal(result.skills.length, 1, `${providerId} missing the unified UltraGoal skill`);
      for (const name of removed) {
        assert.ok(!names.includes(name), `${providerId} must not receive removed control ${name}`);
      }
    }
    const codex = configured.get("codex")!;
    assert.equal(codex.instructions, null);
    assert.equal(
      (host.bb.storage.database().prepare(
        "SELECT COUNT(*) AS n FROM goals WHERE thread_id = 'thr_codex'",
      ).get() as { n: number }).n,
      0,
      "configuration alone must not create an UltraGoal",
    );
  });

  it("routes canonical start/state/patch/finish through the plugin database on Codex", async () => {
    const host = registeredHost();
    const started = await host.harness.behavior.callAgentTool(
      "ultragoal_start",
      { objective: "Prove canonical UltraGoal controls mutate only plugin state" },
      { threadId: "thr_codex" },
    );
    assert.equal(isToolError(started), false);
    const stored = host.bb.storage.database().prepare(
      "SELECT objective, status FROM goals WHERE thread_id = 'thr_codex'",
    ).get() as { objective: string; status: string };
    assert.equal(stored.objective, "Prove canonical UltraGoal controls mutate only plugin state");
    assert.equal(stored.status, "active");

    const patched = await host.harness.behavior.callAgentTool(
      "ultragoal_patch",
      {
        plan: [
          {
            step: "Canonical work",
            status: "pending",
            deps: [],
            files: ["src/canonical.ts"],
            check: "npm test",
          },
        ],
      },
      { threadId: "thr_codex" },
    );
    assert.equal(isToolError(patched), false);
    const itemCount = host.bb.storage.database()
      .prepare("SELECT COUNT(*) AS n FROM goal_items WHERE thread_id = 'thr_codex'")
      .get() as { n: number };
    assert.equal(itemCount.n, 1);

    const state = await host.harness.behavior.callAgentTool(
      "ultragoal_state",
      { plan_status: "all", plan_limit: 100 },
      { threadId: "thr_codex" },
    );
    assert.equal(isToolError(state), false);

    const premature = await host.harness.behavior.callAgentTool(
      "ultragoal_finish",
      {
        status: "complete",
        summary: "This deliberately premature summary must be rejected while canonical work remains open.",
      },
      { threadId: "thr_codex" },
    );
    assert.equal(isToolError(premature), true);
    const item = host.bb.storage.database()
      .prepare("SELECT id FROM goal_items WHERE thread_id = 'thr_codex'")
      .get() as { id: string };
    const completed = await host.harness.behavior.callAgentTool(
      "ultragoal_patch",
      { plan: [{ id: item.id, step: "Canonical work", status: "completed" }] },
      { threadId: "thr_codex" },
    );
    assert.equal(isToolError(completed), false);

    const finished = await host.harness.behavior.callAgentTool(
      "ultragoal_finish",
      {
        status: "complete",
        summary: "Canonical UltraGoal controls wrote the plugin database and passed the fake-host integration test.",
      },
      { threadId: "thr_codex" },
    );
    assert.equal(isToolError(finished), false);
    assert.equal(
      (host.bb.storage.database().prepare(
        "SELECT status FROM goals WHERE thread_id = 'thr_codex'",
      ).get() as { status: string }).status,
      "complete",
    );
  });

  it("pins the decision id request_decision returns in ultragoal_state, from the root and a childless worker", async () => {
    const threadId = "thr_decision_contract";
    const childThreadId = "thr_decision_contract_child";
    const host = registeredHost({
      threads: {
        get: async ({ threadId: queried }) =>
          makeThreadResponse({
            id: queried,
            status: "idle",
            parentThreadId: queried === childThreadId ? threadId : null,
          }),
      },
    });
    const started = await host.harness.behavior.callAgentTool(
      "ultragoal_start",
      { objective: "Pin the request_decision contract at the registered tool boundary" },
      { threadId },
    );
    assert.equal(isToolError(started), false);

    const requested = await host.harness.behavior.callAgentTool(
      "request_decision",
      { question: "Does the tool surface read back the decision it persisted?" },
      { threadId },
    );
    assert.equal(isToolError(requested), false);
    const decisionId = (JSON.parse(toolText(requested)) as { decision_id: string }).decision_id;
    assert.match(decisionId, /^dec_/);

    // A worker with no collab row resolves its goal through the provider parent.
    // The registered tool must key its decision by that goal, not by the id the
    // caller happens to report.
    const childRequested = await host.harness.behavior.callAgentTool(
      "request_decision",
      { question: "Does a childless worker's decision reach the goal's own state?" },
      { threadId: childThreadId },
    );
    assert.equal(isToolError(childRequested), false, toolText(childRequested));
    const childDecisionId = (JSON.parse(toolText(childRequested)) as { decision_id: string })
      .decision_id;
    assert.match(childDecisionId, /^dec_/);

    const state = await host.harness.behavior.callAgentTool("ultragoal_state", {}, { threadId });
    assert.equal(isToolError(state), false);
    const openDecisions = (JSON.parse(toolText(state)) as {
      goal: { openDecisions: Array<{ decision_id: string }> };
    }).goal.openDecisions.map((decision) => decision.decision_id);
    assert.ok(
      openDecisions.includes(decisionId),
      `ultragoal_state must project the decision request_decision returned: ${decisionId}`,
    );
    assert.ok(
      openDecisions.includes(childDecisionId),
      `ultragoal_state must project a childless worker's decision: ${childDecisionId}`,
    );
    const childOwner = host.bb.storage.database()
      .prepare("SELECT thread_id FROM goal_decisions WHERE id = ?")
      .get(childDecisionId) as { thread_id: string };
    assert.equal(childOwner.thread_id, threadId);
  });

  it("keys every goal-scoped tool for a childless worker to the goal configure briefs it for", async () => {
    const root = "thr_goal_key_root";
    const childless = "thr_goal_key_worker";
    const host = registeredHost({
      threads: {
        get: async ({ threadId: queried }) =>
          makeThreadResponse({
            id: queried,
            status: "idle",
            parentThreadId: queried === childless ? root : null,
          }),
      },
    });
    const started = await host.harness.behavior.callAgentTool(
      "ultragoal_start",
      { objective: "Prove one resolver keys every goal-scoped tool for a childless worker" },
      { threadId: root },
    );
    assert.equal(isToolError(started), false, toolText(started));

    // The childless worker is briefed as a worker off its provider parent, so
    // configure offers the plan and finding tools the resolver must key to that
    // goal. Asserting the pairing here keeps the briefing and the writes from
    // drifting apart: a worker told to file a slice must be able to file it.
    const configured = await host.harness.behavior.resolveAgentConfiguration(
      context("codex", childless, root),
    );
    const names = configured.tools.map((tool) => tool.name);
    assert.ok(names.includes("add_slice"), "a childless worker is briefed as a worker");
    assert.ok(names.includes("report_finding"));

    const items = createItemStore(host.bb);
    const created = await host.harness.behavior.callAgentTool(
      "add_slice",
      { step: "Key the childless worker's slice to the goal that briefed it." },
      { threadId: childless },
    );
    assert.equal(isToolError(created), false, toolText(created));
    assert.deepEqual(
      items.list(root).map((item) => item.step),
      ["Key the childless worker's slice to the goal that briefed it."],
    );

    const patched = await host.harness.behavior.callAgentTool(
      "ultragoal_patch",
      { plan: [{ step: "A childless worker's remaining plan write lands here.", status: "pending" }] },
      { threadId: childless },
    );
    assert.equal(isToolError(patched), false, toolText(patched));
    assert.deepEqual(
      items.list(root).map((item) => item.step).sort(),
      [
        "A childless worker's remaining plan write lands here.",
        "Key the childless worker's slice to the goal that briefed it.",
      ].sort(),
    );

    // The tree already owns an unfinished goal, so the same resolution refuses
    // a second one on the child instead of starting a goal the root never reads.
    const restarted = await host.harness.behavior.callAgentTool(
      "ultragoal_start",
      { objective: "A childless worker must not create a goal beside the tree's" },
      { threadId: childless },
    );
    assert.equal(isToolError(restarted), true, toolText(restarted));
    assert.match(toolText(restarted), /unfinished UltraGoal/);
    assert.equal(
      (host.bb.storage.database()
        .prepare("SELECT COUNT(*) AS n FROM goals WHERE thread_id IN (?, ?)")
        .get(root, childless) as { n: number }).n,
      1,
      "the tree keeps exactly one goal row",
    );

    const reported = await host.harness.behavior.callAgentTool(
      "report_finding",
      {
        title: "A childless worker's finding must be owned by the goal too",
        file: "server.ts:1",
        evidence: "Every goal-scoped write resolves through the same goal row.",
        fix_files: ["server.ts"],
      },
      { threadId: childless },
    );
    assert.equal(isToolError(reported), false, toolText(reported));
    // register_finding arms staffing with `void scheduleReady(...)`, so drain
    // that turn before this test's database closes under it.
    for (let index = 0; index < 8; index += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const findingId = (JSON.parse(toolText(reported)) as { finding_id: string }).finding_id;
    const owner = host.bb.storage.database()
      .prepare("SELECT thread_id FROM goal_findings WHERE id = ?")
      .get(findingId) as { thread_id: string };
    assert.equal(owner.thread_id, root, "findings must be keyed by the goal, not the caller");
  });

  it("reconstructs a transferred Codex root with canonical tools and live instructions", async () => {
    const host = registeredHost();
    host.bb.storage.database().prepare(
      "UPDATE goals SET thread_id = 'thr_target', status = 'active' WHERE thread_id = 'thr_sentinel'",
    ).run();
    const configured = await host.harness.behavior.resolveAgentConfiguration(
      context("codex", "thr_target"),
    );
    const names = configured.tools.map((tool) => tool.name);
    assert.ok(names.includes("ultragoal_start"));
    assert.ok(names.includes("ultragoal_state"));
    assert.ok(names.includes("ultragoal_patch"));
    assert.ok(names.includes("ultragoal_finish"));
    assert.ok(!names.includes("create_goal"));
    assert.ok(!names.includes("get_goal"));
    assert.ok(!names.includes("update_plan"));
    assert.ok(!names.includes("update_goal"));
    assert.equal(configured.skills.length, 1);
    assert.match(configured.instructions ?? "", /canonical ultragoal_\* controls/);
  });

  it("reaches intake with add_slice and keeps verifiers off the plan", async () => {
    const host = registeredHost();
    const db = host.bb.storage.database();
    db.prepare(
      "UPDATE goals SET thread_id='thr_slice_root', status='active', max_workers=4 WHERE thread_id='thr_sentinel'",
    ).run();
    // Intake is a goal-tree child holding no slice of its own, so the worker
    // branch of bb.agents.configure is the only surface that can reach it. The
    // plugin's own intake prompt orders one add_slice call per owner feature
    // request: registering the tool without exposing it there drops every such
    // request silently, with no error anywhere.
    db.prepare(`
      INSERT INTO collab_agents (
        thread_id, root_thread_id, parent_thread_id, task_name, created_at,
        display_name, item_id, role
      ) VALUES ('thr_slice_intake', 'thr_slice_root', 'thr_slice_root', '/root/intake', 1,
        'Intake Courier', NULL, 'worker')
    `).run();
    const intake = await host.harness.behavior.resolveAgentConfiguration(
      context("codex", "thr_slice_intake"),
    );
    assert.ok(
      intake.tools.map((tool) => tool.name).includes("add_slice"),
      "intake and workers must be able to file the slice their brief demands",
    );

    const items = createItemStore(host.bb);
    const filed = await host.harness.behavior.callAgentTool(
      "add_slice",
      { step: "Owner request: surface the plan filter in the UltraGoal pane." },
      { threadId: "thr_slice_intake" },
    );
    assert.equal(isToolError(filed), false);
    assert.deepEqual(
      items.list("thr_slice_root").map((item) => item.step),
      ["Owner request: surface the plan filter in the UltraGoal pane."],
    );

    // Verifiers share the worker tool list, and their brief forbids rewriting
    // the parent plan, so the role gate has to live in execute like
    // slice_done's - exposure alone would hand plan writes to a verifier.
    db.prepare(`
      INSERT INTO collab_agents (
        thread_id, root_thread_id, parent_thread_id, task_name, created_at,
        display_name, item_id, role
      ) VALUES ('thr_slice_verifier', 'thr_slice_root', 'thr_slice_root', '/root/verifier', 2,
        'Verifier', NULL, 'verifier')
    `).run();
    const refused = await host.harness.behavior.callAgentTool(
      "add_slice",
      { step: "A verifier must never be able to append plan work." },
      { threadId: "thr_slice_verifier" },
    );
    assert.equal(isToolError(refused), true);
    assert.equal(items.list("thr_slice_root").length, 1, "a verifier write must not reach the plan");

    // The root plans through ultragoal_patch; a second plan-mutation surface
    // there would be a parallel source of truth for the same table.
    const root = await host.harness.behavior.resolveAgentConfiguration(
      context("codex", "thr_slice_root"),
    );
    assert.ok(
      !root.tools.map((tool) => tool.name).includes("add_slice"),
      "the root must keep ultragoal_patch as its only plan-mutation surface",
    );
  });

  it("staffs intake with add_slice on an owner message, and defers while the root is full", async () => {
    // The intake courier is the plugin's own child: maybeIntakeUserMessage reads
    // the goal thread's timeline on every thread.active and staffs a triage
    // agent for the newest owner message. The test above covers what a courier
    // may DO once it exists; this one covers the spawn itself, because two
    // regressions there are invisible everywhere else — a cursor advanced for a
    // message no courier ever read drops the owner's request for good, and a
    // courier staffed while the root is full is refused by the capacity fence
    // only AFTER its child thread exists.
    let rows: Array<Record<string, unknown>> = [];
    let spawnRefusal: string | null = null;
    const spawned: Array<{ id: string; prompt: string }> = [];
    const host = registeredHost({
      threads: {
        get: ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            projectId: "proj",
            providerId: "codex",
            // No environment: the spawn must not depend on live host worktree
            // provisioning, which the fake host cannot perform.
            environmentId: null,
            parentThreadId: threadId === "thr_intake_root" ? null : "thr_intake_root",
            status: "active",
          }),
        list: () => [],
        timeline: ({ threadId }) => ({
          rows: threadId === "thr_intake_root" ? (rows as never[]) : [],
        }),
        spawn: (args) => {
          if (spawnRefusal) throw new Error(spawnRefusal);
          const id = `thr_intake_${spawned.length + 1}`;
          spawned.push({ id, prompt: args.prompt ?? "" });
          return makeThreadResponse({
            id,
            projectId: "proj",
            providerId: "codex",
            environmentId: null,
            parentThreadId: "thr_intake_root",
            status: "active",
          });
        },
        output: () => ({ output: null }),
        stop: () => ({ ok: true }),
        update: ({ threadId }) => makeThreadResponse({ id: threadId }),
        interactions: { list: async () => [], resolve: async () => ({}) },
      },
    });
    const db = host.bb.storage.database();
    db.prepare(
      "UPDATE goals SET thread_id = 'thr_intake_root', status = 'active', max_workers = 1 WHERE thread_id = 'thr_sentinel'",
    ).run();
    const cursor = () =>
      (
        db.prepare("SELECT intake_row_id FROM goals WHERE thread_id = 'thr_intake_root'").get() as {
          intake_row_id: string | null;
        }
      ).intake_row_id;
    const settle = async () => {
      for (let index = 0; index < 20; index += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    const ownerRow = (id: string, text: string) => ({
      kind: "conversation",
      role: "user",
      id,
      text,
    });
    const active = () => ({
      thread: makeThreadResponse({ id: "thr_intake_root", status: "active" }),
    });

    // The first owner message only baselines the durable cursor: replaying a
    // goal's whole history on its first active event would staff one courier
    // per historical message.
    rows = [ownerRow("row_1", "kick off")];
    await host.harness.behavior.emitThreadEvent("thread.active", active());
    await settle();
    // Compare emptiness by length: assert.deepEqual is typed `asserts actual is T`,
    // so its [] expectation would narrow `spawned` to never[] for the rest of the
    // test and every later `spawned[0].id` would stop typechecking.
    assert.equal(spawned.length, 0, "baselining must not staff an intake courier");
    assert.equal(cursor(), "row_1", "the baseline cursor must be durable");

    // A full root defers the courier and leaves the owner's message queued: the
    // fence refuses the courier's durable row after its child already exists,
    // and a cursor moved past a message nobody read is a request dropped for
    // good, with no error anywhere.
    rows = [...rows, ownerRow("row_2", "Owner request: add the /to-tickets plan to the PWA work")];
    db.prepare("UPDATE goals SET max_workers = 0 WHERE thread_id = 'thr_intake_root'").run();
    await host.harness.behavior.emitThreadEvent("thread.active", active());
    await settle();
    assert.equal(spawned.length, 0, "a full root must not staff an intake courier");
    assert.equal(cursor(), "row_1", "a deferred owner message stays queued, never skipped");

    // Capacity returns: the same message staffs the courier, whose brief is the
    // only thing that names the filing tool it must call.
    db.prepare("UPDATE goals SET max_workers = 1 WHERE thread_id = 'thr_intake_root'").run();
    await host.harness.behavior.emitThreadEvent("thread.active", active());
    await settle();
    assert.equal(spawned.length, 1, "an owner request must staff exactly one intake courier");
    assert.match(
      spawned[0].prompt,
      /add_slice call/,
      "the courier's brief orders an add_slice call",
    );
    assert.match(
      spawned[0].prompt,
      /add the \/to-tickets plan to the PWA work/,
      "the courier must be handed the owner's own words",
    );
    assert.equal(cursor(), "row_2", "the cursor advances only once the courier exists");

    // A spawn that fails must not consume the message either — the cursor
    // tracks the courier, not the message. This is the other half of #36: the
    // pre-fence code advanced the cursor first, so a spawn that threw lost the
    // owner's request with no error the owner could ever see, and no later pass
    // would retry it.
    spawnRefusal = "the host refused the intake spawn";
    // Room for the retry's courier: the first one already occupies a slot.
    db.prepare("UPDATE goals SET max_workers = 2 WHERE thread_id = 'thr_intake_root'").run();
    rows = [...rows, ownerRow("row_3", "Owner request: retire the stale PWA branch")];
    await host.harness.behavior.emitThreadEvent("thread.active", active());
    await settle();
    assert.equal(spawned.length, 1, "a failed spawn must not add a courier");
    assert.equal(cursor(), "row_2", "a failed spawn leaves the owner's message queued");

    spawnRefusal = null;
    await host.harness.behavior.emitThreadEvent("thread.active", active());
    await settle();
    assert.equal(spawned.length, 2, "the retried message must staff the courier");
    assert.equal(cursor(), "row_3", "the retry advances the cursor once the courier exists");

    // The spawned courier — not an injected row — is the surface that must
    // carry add_slice, and its call must land on the root's plan.
    const intake = await host.harness.behavior.resolveAgentConfiguration(
      context("codex", spawned[0].id),
    );
    assert.ok(
      intake.tools.map((tool) => tool.name).includes("add_slice"),
      "the brief orders add_slice, so the spawned courier must be able to call it",
    );
    const items = createItemStore(host.bb);
    const filed = await host.harness.behavior.callAgentTool(
      "add_slice",
      { step: "Owner request: add the /to-tickets plan to the PWA work" },
      { threadId: spawned[0].id },
    );
    assert.equal(isToolError(filed), false);
    assert.deepEqual(
      items.list("thr_intake_root").map((item) => item.step),
      ["Owner request: add the /to-tickets plan to the PWA work"],
    );

    // add_slice publishes and kicks the scheduler on a floating promise; drain
    // it here so the fake host is not disposed under a live database write.
    await settle();
  });

  it("defers every queued owner row on a full root and keeps the cursor on the last admitted row", async () => {
    const { state, cursor, setCap, logs, ownerRow, ownerEvent } = intakeRoot("thr_queue_full");

    state.rows = [ownerRow("row_1", "kick off")];
    await ownerEvent();
    assert.equal(state.spawned.length, 0, "baselining must not staff an intake courier");
    assert.equal(cursor(), "row_1");

    // Two owner rows arrive while the root is full. Neither may be lost, read as
    // triaged, or silently superseded by the newer row.
    state.rows = [
      ...state.rows,
      ownerRow("row_2", "Owner request: first queued request"),
      ownerRow("row_3", "Owner request: second queued request"),
    ];
    setCap(0);
    await ownerEvent();
    assert.equal(state.spawned.length, 0, "a full root must not staff an intake courier");
    assert.equal(cursor(), "row_1", "a deferred owner row must stay queued");
    assert.ok(
      logs().includes("Intake pass on thr_queue_full: deferred"),
      `a deferred pass must expose its outcome by name: ${JSON.stringify(logs())}`,
    );
    assert.ok(
      logs().some(
        (message) => message.includes("capacity is full") && message.includes("row_2 stays queued"),
      ),
      `the first queued row must be named as still queued: ${JSON.stringify(logs())}`,
    );
  });

  it("drains every queued owner row in order from the progress pulse once capacity returns", async () => {
    const { state, cursor, setCap, logs, ownerRow, ownerEvent, pulse } = intakeRoot("thr_queue_drain");

    state.rows = [ownerRow("row_1", "kick off")];
    await ownerEvent();
    state.rows = [
      ...state.rows,
      ownerRow("row_2", "Owner request: first queued request"),
      ownerRow("row_3", "Owner request: second queued request"),
    ];
    setCap(0);
    await ownerEvent();
    assert.equal(state.spawned.length, 0, "a full root must not staff an intake courier");

    // Capacity returns and the owner goes quiet: the progress pulse is the only
    // remaining retry path, and it must triage EVERY queued row.
    setCap(3);
    await pulse();
    assert.equal(
      state.spawned.length,
      2,
      `every queued owner row must be triaged: ${JSON.stringify(logs())}`,
    );
    assert.match(state.spawned[0]!.prompt, /owner request: first queued request/i);
    assert.match(state.spawned[1]!.prompt, /owner request: second queued request/i);
    assert.equal(cursor(), "row_3", "the cursor advances to the last admitted owner row");
    assert.ok(
      logs().includes("Intake pass on thr_queue_drain: admitted"),
      `an admitted pass must name the root in its outcome line: ${JSON.stringify(logs())}`,
    );
  });

  it("staffs exactly one courier when two intake passes overlap", async () => {
    const { state, cursor, logs, settle, ownerRow, ownerEvent, pulse } = intakeRoot("thr_overlap");

    state.rows = [ownerRow("row_1", "kick off")];
    await ownerEvent();
    state.rows = [...state.rows, ownerRow("row_2", "Owner request: one courier only")];
    let release!: () => void;
    state.gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Two active events arrive while the first dispatch is still in flight: the
    // second pass must not dispatch the row the first pass already owns.
    await ownerEvent();
    await ownerEvent();
    assert.equal(
      state.spawnCalls,
      1,
      "an overlapping intake pass must not dispatch a row another pass owns",
    );
    assert.ok(
      logs().includes("Intake pass on thr_overlap: deferred"),
      `the overlapping pass must report the claim: ${JSON.stringify(logs())}`,
    );

    release();
    state.gate = null;
    await settle();
    await pulse();
    assert.equal(state.spawnCalls, 1, "one owner row means one dispatch, however the passes arrive");
    assert.equal(state.spawned.length, 1, "one owner row means one courier");
    assert.equal(cursor(), "row_2", "the cursor advances once, after the courier exists");
  });

  it("contains a refused intake spawn and retries the queued owner row exactly once", async () => {
    const { state, cursor, logs, ownerRow, ownerEvent } = intakeRoot("thr_refusal");
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      state.rows = [ownerRow("row_1", "kick off")];
      await ownerEvent();
      state.rows = [...state.rows, ownerRow("row_2", "Owner request: survive a refused spawn")];
      state.refusal = "the host refused the intake spawn";
      const event = await ownerEvent();
      assert.equal(
        (event.errors ?? []).length,
        0,
        "the detached intake pass must not reject into the event dispatch",
      );
      assert.equal(rejections.length, 0, "no intake rejection may escape the plugin boundary");
      assert.equal(state.spawned.length, 0, "a refused spawn must not add a courier");
      assert.equal(cursor(), "row_1", "a refused spawn leaves the owner row queued");
      assert.ok(
        logs().some(
          (message) => message.includes("Intake spawn failed") && message.includes("row_2 stays queued"),
        ),
        `a refusal must name the queued row: ${JSON.stringify(logs())}`,
      );

      state.refusal = null;
      await ownerEvent();
      assert.equal(state.spawned.length, 1, "the queued owner row must be retryable");
      assert.equal(state.spawnCalls, 2, "the retry dispatches exactly once more");
      assert.equal(cursor(), "row_2", "the retry advances the cursor once the courier exists");
      assert.equal(rejections.length, 0, "the retry must not leak a rejection either");
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("dispatches the newest owner row when the cursor row left the timeline window", async () => {
    const { state, cursor, ownerRow, ownerEvent } = intakeRoot("thr_rotated");

    state.rows = [ownerRow("row_1", "kick off")];
    await ownerEvent();
    assert.equal(cursor(), "row_1");

    state.rows = [];
    await ownerEvent();
    assert.equal(state.spawned.length, 0, "an empty timeline staffs nothing");

    // The cursor row is no longer in the window the host returns. Losing the row
    // must not hide the newest one: it is the only row this pass can attribute.
    state.rows = [ownerRow("row_9", "Owner request: after the window rotated")];
    await ownerEvent();
    assert.equal(state.spawned.length, 1, "the newest owner row is still attributable");
    assert.match(state.spawned[0]!.prompt, /after the window rotated/);
    assert.equal(cursor(), "row_9");
  });

  // Issue #34's two blockers were defects of a STALE-CLAIM TAKEOVER, and this
  // base deliberately has no takeover: a pass owns its claim to completion and
  // the 20s pulse only ever detaches it. The two cases below pin that shape, so
  // the rejected takeover fails them the moment it returns. The brief's
  // "failure-after-takeover" therefore maps onto the same sequence without a
  // takeover: a dispatch left outstanding past any staleness a takeover would
  // key on, with later owner events and a pulse arriving, is never re-dispatched
  // — and when it finally FAILS, the owner row stays retryable exactly once.
  // The "never-resolving iteration" companion pins the sweep side: a dispatch
  // that never settles cannot wedge the pulse for later roots.
  // Observables only: spawn calls, courier prompts, the durable intake_row_id
  // cursor and the inspection log — never the shape of the claim map.
  it("never takes over an outstanding dispatch and retries the owner row exactly once after its late failure", async () => {
    const { state, cursor, logs, settle, ownerRow, ownerEvent, pulse } =
      intakeRoot("thr_late_failure");
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      state.rows = [ownerRow("row_1", "kick off")];
      await ownerEvent();
      assert.equal(cursor(), "row_1", "the first owner row baselines the cursor");

      // A queued owner row arrives and its dispatch is held outstanding. The
      // claim is taken before the spawn, so every later pass must defer: a
      // takeover here is what consumed this row for good in the retired run.
      state.rows = [
        ...state.rows,
        ownerRow("row_2", "Owner request: survive a late dispatch failure"),
      ];
      let release!: () => void;
      state.gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const outstanding = await ownerEvent();
      assert.equal(state.spawnCalls, 1, "the queued row is dispatched once");
      assert.equal(cursor(), "row_1", "the cursor cannot move before the courier exists");

      // However long the dispatch stays outstanding — an owner event and a
      // pulse, with nothing settling it — no later pass may take the claim
      // over, dispatch the row a second time, or move the cursor past it.
      const deferred = await ownerEvent();
      await pulse();
      assert.equal(
        state.spawnCalls,
        1,
        "an outstanding dispatch must never be taken over or re-dispatched",
      );
      assert.equal(state.spawned.length, 0, "no courier exists while the dispatch is outstanding");
      assert.equal(cursor(), "row_1", "the queued row stays the cursor's next row");
      assert.ok(
        logs().includes("Intake pass on thr_late_failure: deferred"),
        `later passes must defer behind the claim: ${JSON.stringify(logs())}`,
      );

      // The outstanding dispatch fails LATE. The failure is contained, the row
      // is still queued, and the cursor cannot move.
      state.refusal = "the host refused the intake spawn (late)";
      release();
      state.gate = null;
      await settle();
      assert.equal(
        (outstanding.errors ?? []).length,
        0,
        "a late dispatch failure must not reject into the event that started it",
      );
      assert.equal(
        (deferred.errors ?? []).length,
        0,
        "a deferred pass must not reject into the event that triggered it",
      );
      assert.equal(rejections.length, 0, "no intake rejection may escape the plugin boundary");
      assert.ok(
        logs().some(
          (message) =>
            message.includes("Intake spawn failed") && message.includes("row_2 stays queued"),
        ),
        `a late failure must name the row as still queued: ${JSON.stringify(logs())}`,
      );
      assert.equal(cursor(), "row_1", "a late failure must not consume the queued row");

      // The very next pass retries it exactly once: one courier carrying the
      // queued row, one cursor advance, no leak.
      state.refusal = null;
      await pulse();
      assert.equal(state.spawnCalls, 2, "the late-failed dispatch is retried exactly once");
      assert.equal(state.spawned.length, 1, "exactly one courier is staffed");
      assert.match(
        state.spawned[0]!.prompt,
        /survive a late dispatch failure/i,
        "the retried courier carries the queued row",
      );
      assert.equal(cursor(), "row_2", "the cursor advances once, after the courier exists");
      assert.equal(rejections.length, 0, "the retry must not leak a rejection either");
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("keeps sweeping later roots while one root's dispatch never settles", async () => {
    const { state, rootState, cursor, setCap, logs, ownerRow, ownerEvent, pulse, never } =
      intakeRoot("thr_stuck_root", ["thr_later_root"]);

    // Root A baselines, then queues a row whose dispatch never settles. The
    // outstanding claim is exactly what a takeover would key on.
    state.rows = [ownerRow("a_1", "kick off")];
    await ownerEvent();
    state.rows = [...state.rows, ownerRow("a_2", "Owner request: never settles")];
    state.gate = never();
    await ownerEvent();
    assert.equal(state.spawnCalls, 1, "root A's dispatch is outstanding");

    // Root B baselines and defers its queued row while its own capacity is
    // full, so the pulse is its only retry path.
    const later = rootState("thr_later_root");
    later.rows = [ownerRow("b_1", "kick off")];
    await ownerEvent("thr_later_root");
    later.rows = [...later.rows, ownerRow("b_2", "Owner request: drain behind a stuck root")];
    setCap(0, "thr_later_root");
    await ownerEvent("thr_later_root");
    assert.equal(later.spawnCalls, 0, "root B defers while full");
    setCap(1, "thr_later_root");

    // One pulse must resolve — it never awaits an intake dispatch — and root
    // B's queued row staffs its courier in that same sweep. A wedged root A
    // would otherwise stop every later root's revival, progress, reconciliation
    // and accounting.
    await pulse();
    assert.equal(
      later.spawnCalls,
      1,
      `a never-settling root must not stop a later root's intake retry: ${JSON.stringify(logs())}`,
    );
    assert.equal(later.spawned.length, 1, "root B staffs exactly one courier");
    assert.match(later.spawned[0]!.prompt, /drain behind a stuck root/i);
    assert.equal(cursor("thr_later_root"), "b_2", "root B's cursor advances after its courier");
    assert.equal(
      state.spawnCalls,
      1,
      "root A is never taken over while its dispatch is outstanding",
    );
    assert.equal(cursor(), "a_1", "root A's queued row is retained, not consumed");
  });

  it("audits stale finding links on the first startup pulse", async () => {
    const host = registeredHost();
    const db = host.bb.storage.database();
    db.prepare(
      "UPDATE goals SET thread_id = 'thr_startup', status = 'paused' WHERE thread_id = 'thr_sentinel'",
    ).run();
    const items = createItemStore(host.bb);
    const findings = createFindingStore(host.bb);
    const item = items.add(
      "thr_startup",
      "Repair segment ownership in schema/src/segments.ts",
      "pending",
      { files: ["schema/src/segments.ts", "schema/migrations/generated"] },
    )!;
    const primary = findings.report("thr_startup", {
      title: "Segment baseline defect",
      file: "schema/migrations/generated/0041_baseline.sql:91",
      evidence: "The generated baseline exposes a source-model defect.",
      fixFiles: ["schema/migrations/generated"],
    }).finding;
    const stale = findings.report("thr_startup", {
      title: "Unrelated tenant foreign-key defect",
      file: "schema/migrations/generated",
      evidence: "A broad migration directory was incorrectly coalesced later.",
      fixFiles: ["schema/migrations/generated"],
    }).finding;
    db.prepare("UPDATE goal_findings SET created_at = ? WHERE id = ?").run(1, primary.id);
    db.prepare("UPDATE goal_findings SET created_at = ? WHERE id = ?").run(2, stale.id);
    assert.equal(findings.linkItem("thr_startup", primary.id, item.id), true);
    assert.equal(findings.linkItem("thr_startup", stale.id, item.id), true);

    const service = host.harness.behavior.runService("progress-pulse");
    service.controller.abort();
    await service.done;

    assert.equal(findings.get("thr_startup", primary.id)!.itemId, item.id);
    const repairedItemId = findings.get("thr_startup", stale.id)!.itemId;
    assert.ok(repairedItemId);
    assert.notEqual(repairedItemId, item.id);
    assert.equal(items.list("thr_startup").length, 2);
  });

  it("retains an active durable worker across reload before scheduling new backlog work", async () => {
    let spawnCalls = 0;
    const host = registeredHost({
      threads: {
        get: async ({ threadId }) => makeThreadResponse({
          id: threadId,
          projectId: "proj",
          providerId: "acp-opencode",
          environmentId: null,
          status: "active",
          parentThreadId: threadId === "thr_existing_worker" ? "thr_reload" : null,
        }),
        list: () => [],
        spawn: () => {
          spawnCalls += 1;
          return makeThreadResponse({ id: `thr_unexpected_${spawnCalls}` });
        },
        update: ({ threadId }) => makeThreadResponse({ id: threadId }),
        send: () => ({ ok: true }),
      },
    });
    const db = host.bb.storage.database();
    db.prepare(
      "UPDATE goals SET thread_id = 'thr_reload', status = 'active', max_workers = 1 WHERE thread_id = 'thr_sentinel'",
    ).run();
    const items = createItemStore(host.bb);
    const held = items.add(
      "thr_reload",
      "Repair the already-running reload-safe slice",
      "in_progress",
      { files: ["src/held.ts"], check: "npm test -- held" },
    )!;
    db.prepare("UPDATE goal_items SET updated_at = 1 WHERE id = ?").run(held.id);
    db.prepare(`
      INSERT INTO collab_agents (
        thread_id, root_thread_id, parent_thread_id, task_name, created_at,
        display_name, item_id, role
      ) VALUES ('thr_existing_worker', 'thr_reload', 'thr_reload', '/root/existing', 1,
        'Reload Keeper', ?, 'worker')
    `).run(held.id);

    const reloaded = await host.harness.lifecycle.reload(plugin);
    hosts.push(reloaded);
    const reported = await reloaded.harness.behavior.callAgentTool(
      "report_finding",
      {
        title: "A separate reload defect needs work",
        file: "src/new-reload-defect.ts:10",
        evidence: "The separate defect is real and should wait behind the retained worker.",
        fix_files: ["src/new-reload-defect.ts"],
        check: "npm test -- reload-defect",
      },
      { threadId: "thr_reload" },
    );
    assert.equal(isToolError(reported), false);
    for (let index = 0; index < 6; index += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const liveDb = reloaded.bb.storage.database();
    assert.equal(spawnCalls, 0, "cold-cache scheduling must not spawn over a live owner");
    assert.equal(
      (liveDb.prepare("SELECT COUNT(*) AS n FROM goal_items WHERE thread_id = 'thr_reload'").get() as { n: number }).n,
      2,
      "only the held item and the newly minted remediation item should exist",
    );
    const agents = liveDb.prepare(`
      SELECT thread_id, item_id FROM collab_agents
      WHERE root_thread_id = 'thr_reload' AND retired_at IS NULL
    `).all() as Array<{ thread_id: string; item_id: string | null }>;
    assert.deepEqual(agents, [{ thread_id: "thr_existing_worker", item_id: held.id }]);
    assert.equal(
      (liveDb.prepare("SELECT status FROM goal_items WHERE id = ?").get(held.id) as { status: string }).status,
      "in_progress",
    );
    assert.ok(
      reloaded.harness.inspection.sdk.callsTo("threads.get").some(
        (call) => (call[0] as { threadId?: string }).threadId === "thr_existing_worker",
      ),
      "reload hydration must refresh the durable holder",
    );
  });

  it("rolls a failed real scheduler spawn back to pending and releases its reservation", async () => {
    let spawnCalls = 0;
    const host = registeredHost({
      threads: {
        get: ({ threadId }) => makeThreadResponse({
          id: threadId,
          projectId: "proj",
          providerId: "acp-opencode",
          environmentId: "env_spawn_fail",
          status: "idle",
        }),
        list: () => [],
        spawn: () => {
          spawnCalls += 1;
          throw new Error("forced external spawn failure");
        },
        update: ({ threadId }) => makeThreadResponse({ id: threadId }),
      },
      environments: {
        get: async () => ({
          id: "env_spawn_fail",
          hostId: "host_spawn_fail",
          path: "/srv/spawn-fail",
          branchName: "main",
        }),
      },
    }, () => ({ status: "valid", repository: "/srv/spawn-fail", commit: "c".repeat(40) }));
    const db = host.bb.storage.database();
    db.prepare(
      "UPDATE goals SET thread_id='thr_spawn_fail', status='active', max_workers=1 WHERE thread_id='thr_sentinel'",
    ).run();

    const result = await host.harness.behavior.callAgentTool(
      "ultragoal_patch",
      {
        plan: [{
          step: "Exercise scheduler rollback after failed spawn",
          status: "pending",
          deps: [],
          files: ["src/spawn-failure.ts"],
          check: "npm test -- spawn-failure",
        }],
      },
      { threadId: "thr_spawn_fail" },
    );
    assert.equal(isToolError(result), false);
    for (let index = 0; index < 8; index += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(spawnCalls, 1);
    assert.equal(
      (db.prepare(
        "SELECT status FROM goal_items WHERE thread_id='thr_spawn_fail'",
      ).get() as { status: string }).status,
      "pending",
    );
    assert.equal(
      (db.prepare(
        "SELECT COUNT(*) AS n FROM collab_item_reservations WHERE root_thread_id='thr_spawn_fail'",
      ).get() as { n: number }).n,
      0,
    );
    assert.equal(
      (db.prepare(
        "SELECT COUNT(*) AS n FROM collab_agents WHERE root_thread_id='thr_spawn_fail' AND retired_at IS NULL",
      ).get() as { n: number }).n,
      0,
    );
  });

  it("durably suppresses an invalid tuple across duplicate ticks and reload until explicit revalidation", async () => {
    let resolution: "invalid" | "valid" = "invalid";
    let spawnCalls = 0;
    let validationCalls = 0;
    const spawnArgs: unknown[] = [];
    const commit = "a".repeat(40);
    const moved = "e".repeat(40);
    let refNowPointsTo = commit;
    const sdk = {
      threads: {
        get: ({ threadId }: { threadId: string }) => makeThreadResponse({
          id: threadId,
          projectId: "proj",
          providerId: "acp-opencode",
          environmentId: "env_invalid",
          status: "idle",
        }),
        list: () => [],
        spawn: (args: unknown) => {
          spawnCalls += 1;
          spawnArgs.push(args);
          return makeThreadResponse({ id: `thr_invalid_worker_${spawnCalls}` });
        },
        update: ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId }),
      },
      environments: {
        get: async () => ({
          id: "env_invalid",
          hostId: "host_source",
          path: "/srv/project",
          branchName: "release",
          mergeBaseBranch: "main",
        }),
      },
    } as CreateFakePluginHostOptions["sdk"];
    const host = registeredHost(sdk, () => {
      validationCalls += 1;
      if (resolution === "valid") {
        // The named ref moves right after the peel: every admitted spawn must
        // stay bound to the commit the host returned, never the ref's new tip.
        refNowPointsTo = moved;
      }
      return resolution === "valid"
        ? { status: "valid", repository: "/srv/project", commit }
        : { status: "invalid", repository: "/srv/project" };
    });
    const db = host.bb.storage.database();
    db.prepare(
      "UPDATE goals SET thread_id='thr_invalid', status='active', max_workers=1 WHERE thread_id='thr_sentinel'",
    ).run();

    await host.harness.behavior.callAgentTool(
      "ultragoal_patch",
      { plan: [{ step: "Invalid-base slice", status: "pending", deps: [], files: ["src/base.ts"] }] },
      { threadId: "thr_invalid" },
    );
    for (let index = 0; index < 10; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    const item = db.prepare(
      "SELECT id, status FROM goal_items WHERE thread_id='thr_invalid'",
    ).get() as { id: string; status: string };
    assert.equal(item.status, "pending");
    assert.equal(spawnCalls, 0);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM invalid_base_suppressions").get() as { n: number }).n,
      1,
    );
    const state = await host.harness.behavior.callAgentTool(
      "ultragoal_state",
      {},
      { threadId: "thr_invalid" },
    );
    assert.match(JSON.stringify(state), /missing or does not peel to a commit/);
    assert.match(JSON.stringify(state), new RegExp(`ultragoal revalidate ${item.id}`));

    await host.harness.behavior.callAgentTool(
      "ultragoal_patch",
      { plan: [{ id: item.id, step: "Invalid-base slice", status: "pending", deps: [], files: ["src/base.ts"] }] },
      { threadId: "thr_invalid" },
    );
    for (let index = 0; index < 8; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(spawnCalls, 0, "a duplicate scheduler tick must stay suppressed");

    const reloaded = await host.harness.lifecycle.reload(plugin);
    hosts.push(reloaded);
    await reloaded.harness.behavior.callAgentTool(
      "ultragoal_patch",
      { plan: [{ id: item.id, step: "Invalid-base slice", status: "pending", deps: [], files: ["src/base.ts"] }] },
      { threadId: "thr_invalid" },
    );
    for (let index = 0; index < 8; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(spawnCalls, 0, "plugin reload must not forget the invalid tuple");

    resolution = "valid";
    await reloaded.harness.behavior.callAgentTool(
      "ultragoal_patch",
      { plan: [{ id: item.id, step: "Invalid-base slice", status: "pending", deps: [], files: ["src/base.ts"] }] },
      { threadId: "thr_invalid" },
    );
    for (let index = 0; index < 8; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(spawnCalls, 0, "an unchanged tuple needs explicit operator revalidation");

    const retried = await reloaded.harness.behavior.runCli([
      "revalidate",
      item.id,
      "--thread",
      "thr_invalid",
    ]);
    assert.equal(retried.exitCode, 0, retried.stderr);
    for (let index = 0; index < 10; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(spawnCalls, 1);
    const args = spawnArgs[0] as {
      environment?: { hostId?: string; workspace?: { baseBranch?: { name?: string } } };
    };
    assert.equal(args.environment?.hostId, "host_source");
    assert.equal(args.environment?.workspace?.baseBranch?.name, commit);
    assert.equal(refNowPointsTo, moved, "the ref moved; the spawn stayed pinned to the validated commit");
    assert.ok(validationCalls >= 4, "each request is checked in the exact repository before suppression lookup");
  });

  it("runs one scheduling pass per tick, so a revalidated spawn binds the commit it peeled", async () => {
    const commit = "a".repeat(40);
    const moved = "e".repeat(40);
    let mode: "invalid" | "valid" = "invalid";
    let refNow = commit;
    let validationCalls = 0;
    let validCalls = 0;
    let spawnCalls = 0;
    const spawnArgs: unknown[] = [];
    const host = registeredHost(
      {
        threads: {
          get: ({ threadId }) => makeThreadResponse({
            id: threadId,
            projectId: "proj",
            providerId: "acp-opencode",
            environmentId: "env_one_pass",
            status: "idle",
          }),
          list: () => [],
          spawn: (args: unknown) => {
            spawnCalls += 1;
            spawnArgs.push(args);
            return makeThreadResponse({ id: `thr_one_pass_worker_${spawnCalls}` });
          },
          update: ({ threadId }) => makeThreadResponse({ id: threadId }),
        },
        environments: {
          get: async () => ({
            id: "env_one_pass",
            hostId: "host_source",
            path: "/srv/project",
            branchName: "release",
            mergeBaseBranch: "main",
          }),
        },
      } as CreateFakePluginHostOptions["sdk"],
      () => {
        validationCalls += 1;
        if (mode === "invalid") return { status: "invalid", repository: "/srv/project" };
        validCalls += 1;
        const peeled = refNow;
        // The ref moves right after this peel. An idle heal sweep that bought a
        // second pass for the same tick would peel the new tip, and the spawn
        // could no longer bind the commit its own validation returned.
        if (validCalls > 1) refNow = moved;
        return { status: "valid", repository: "/srv/project", commit: peeled };
      },
    );
    const db = host.bb.storage.database();
    db.prepare(
      "UPDATE goals SET thread_id='thr_one_pass', status='active', max_workers=1 WHERE thread_id='thr_sentinel'",
    ).run();
    await host.harness.behavior.callAgentTool(
      "ultragoal_patch",
      { plan: [{ step: "One-pass slice", status: "pending", deps: [], files: ["src/one-pass.ts"] }] },
      { threadId: "thr_one_pass" },
    );
    for (let index = 0; index < 10; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    const item = db.prepare(
      "SELECT id, status FROM goal_items WHERE thread_id='thr_one_pass'",
    ).get() as { id: string; status: string };
    assert.equal(item.status, "pending");
    assert.equal(spawnCalls, 0);
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM invalid_base_suppressions").get() as { n: number }).n,
      1,
      "the pass that re-validated the invalid tuple persisted it",
    );
    assert.equal(validationCalls, 1, "one trigger runs one scheduling pass");

    mode = "valid";
    await host.harness.behavior.callAgentTool(
      "ultragoal_patch",
      { plan: [{ id: item.id, step: "One-pass slice", status: "pending", deps: [], files: ["src/one-pass.ts"] }] },
      { threadId: "thr_one_pass" },
    );
    for (let index = 0; index < 8; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(validCalls, 1, "a suppressed tick validates the unchanged tuple exactly once");
    assert.equal(spawnCalls, 0, "an unchanged tuple stays suppressed");

    const retried = await host.harness.behavior.runCli([
      "revalidate",
      item.id,
      "--thread",
      "thr_one_pass",
    ]);
    assert.equal(retried.exitCode, 0, retried.stderr);
    for (let index = 0; index < 10; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(spawnCalls, 1);
    const args = spawnArgs[0] as {
      environment?: { workspace?: { baseBranch?: { name?: string } } };
    };
    assert.equal(args.environment?.workspace?.baseBranch?.name, commit);
    assert.equal(refNow, moved, "the ref moved after the peel; the spawn stayed pinned to it");
  });

  it("restaffs a slice reclaimed as an orphan by the snapshot that demoted it", async () => {
    let spawnCalls = 0;
    const host = registeredHost(
      {
        threads: {
          get: ({ threadId }) => makeThreadResponse({
            id: threadId,
            projectId: "proj",
            providerId: "acp-opencode",
            environmentId: "env_orphan",
            status: "idle",
          }),
          list: () => [],
          spawn: () => {
            spawnCalls += 1;
            return makeThreadResponse({ id: `thr_orphan_worker_${spawnCalls}` });
          },
          update: ({ threadId }) => makeThreadResponse({ id: threadId }),
        },
        environments: {
          get: async () => ({
            id: "env_orphan",
            hostId: "host_orphan",
            path: "/srv/orphan",
            branchName: "main",
          }),
        },
      } as CreateFakePluginHostOptions["sdk"],
      () => ({ status: "valid", repository: "/srv/orphan", commit: "d".repeat(40) }),
    );
    const db = host.bb.storage.database();
    db.prepare(
      "UPDATE goals SET thread_id='thr_orphan', status='active', max_workers=1 WHERE thread_id='thr_sentinel'",
    ).run();
    const items = createItemStore(host.bb);
    const orphan = items.add(
      "thr_orphan",
      "Slice whose worker vanished without a durable row",
      "in_progress",
      { files: ["src/orphan.ts"] },
    )!;
    // healStalls can also request a pass, but only for a durable row it retires.
    // An empty worker table keeps the reclaim under test the only reason to run.
    assert.equal(
      (db.prepare(
        "SELECT COUNT(*) AS n FROM collab_agents WHERE root_thread_id='thr_orphan'",
      ).get() as { n: number }).n,
      0,
    );

    const state = await host.harness.behavior.callAgentTool(
      "ultragoal_state",
      {},
      { threadId: "thr_orphan" },
    );
    assert.equal(isToolError(state), false, toolText(state));
    // The state pass reclaims the orphan and requests scheduling detached, so
    // poll for the restaff instead of asserting right after the awaited call.
    for (let index = 0; index < 60; index += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    assert.equal(spawnCalls, 1, "the snapshot that demoted the orphan must restaff it");
    assert.equal(items.list("thr_orphan").find((row) => row.id === orphan.id)!.status, "in_progress");
  });

  it("retries operational validation failures and automatically admits a changed ref", async () => {
    let requestedRef = "broken";
    let phase: "operational" | "invalid" | "valid" = "operational";
    let spawnCalls = 0;
    const commit = "b".repeat(40);
    const host = registeredHost(
      {
        threads: {
          get: ({ threadId }) => makeThreadResponse({
            id: threadId,
            projectId: "proj",
            providerId: "acp-opencode",
            environmentId: "env_retry",
            status: "idle",
          }),
          list: () => [],
          spawn: () => {
            spawnCalls += 1;
            return makeThreadResponse({ id: `thr_retry_worker_${spawnCalls}` });
          },
          update: ({ threadId }) => makeThreadResponse({ id: threadId }),
        },
        environments: {
          get: async () => ({
            id: "env_retry",
            hostId: "host_retry",
            path: "/srv/retry-project",
            branchName: requestedRef,
            mergeBaseBranch: "main",
          }),
        },
      } as CreateFakePluginHostOptions["sdk"],
      () => phase === "operational"
        ? { status: "operational_error", repository: "/srv/retry-project", reason: "host temporarily unavailable" }
        : phase === "invalid"
          ? { status: "invalid", repository: "/srv/retry-project" }
          : { status: "valid", repository: "/srv/retry-project", commit },
    );
    const db = host.bb.storage.database();
    db.prepare(
      "UPDATE goals SET thread_id='thr_retry', status='active', max_workers=1 WHERE thread_id='thr_sentinel'",
    ).run();
    await host.harness.behavior.callAgentTool(
      "ultragoal_patch",
      { plan: [{ step: "Retry validation", status: "pending", deps: [], files: ["src/retry.ts"] }] },
      { threadId: "thr_retry" },
    );
    for (let index = 0; index < 8; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    const item = db.prepare("SELECT id FROM goal_items WHERE thread_id='thr_retry'").get() as { id: string };
    assert.equal(spawnCalls, 0);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM invalid_base_suppressions").get() as { n: number }).n, 0);

    phase = "invalid";
    await host.harness.behavior.callAgentTool(
      "ultragoal_patch",
      { plan: [{ id: item.id, step: "Retry validation", status: "pending", deps: [], files: ["src/retry.ts"] }] },
      { threadId: "thr_retry" },
    );
    for (let index = 0; index < 8; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM invalid_base_suppressions").get() as { n: number }).n, 1);

    requestedRef = "fixed";
    phase = "valid";
    await host.harness.behavior.callAgentTool(
      "ultragoal_patch",
      { plan: [{ id: item.id, step: "Retry validation", status: "pending", deps: [], files: ["src/retry.ts"] }] },
      { threadId: "thr_retry" },
    );
    for (let index = 0; index < 10; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(spawnCalls, 1, "a changed ref must validate and admit without manual clearing");
  });

  it("stops and tombstones a legacy child that returns after the root slot commits", async () => {
    const stopped: string[] = [];
    let legacyPrompt = "";
    const legacyChild = makeThreadResponse({
      id: "thr_late_legacy_b",
      parentThreadId: "thr_capacity_root",
      projectId: "proj",
      providerId: "acp-opencode",
      environmentId: null,
      status: "active",
      title: "Late legacy B",
    });
    const host = registeredHost({
      threads: {
        get: ({ threadId }) =>
          threadId === legacyChild.id
            ? legacyChild
            : makeThreadResponse({
                id: threadId,
                projectId: "proj",
                providerId: "acp-opencode",
                environmentId: null,
                status: "idle",
              }),
        list: () => [legacyChild],
        timeline: ({ threadId }) => ({
          rows: threadId === legacyChild.id
            ? [{
                kind: "conversation",
                role: "user",
                text: legacyPrompt,
              }]
            : [],
        }),
        output: () => ({ output: null }),
        stop: ({ threadId }) => {
          stopped.push(threadId);
          return { ok: true };
        },
        update: ({ threadId }) => makeThreadResponse({ id: threadId }),
        interactions: { list: async () => [] },
      },
    });
    const db = host.bb.storage.database();
    db.prepare(
      "UPDATE goals SET thread_id='thr_capacity_root', status='active', max_workers=1 WHERE thread_id='thr_sentinel'",
    ).run();
    const items = createItemStore(host.bb);
    const itemA = items.add(
      "thr_capacity_root",
      "Current generation item A",
      "in_progress",
      { files: ["src/a.ts"] },
    )!;
    const itemB = items.add(
      "thr_capacity_root",
      "Old generation item B",
      "in_progress",
      { files: ["src/b.ts"] },
    )!;
    legacyPrompt = `SLICE (item_id=${itemB.id}): old generation B`;
    const reservations = createItemReservationStore(db);
    const token = reservations.acquire("thr_capacity_root", itemA.id, 1);
    assert.ok(token);
    assert.equal(
      reservations.commit("thr_capacity_root", itemA.id, token, () => {
        db.prepare(`
          INSERT INTO collab_agents (
            thread_id, root_thread_id, parent_thread_id, task_name, created_at,
            display_name, item_id, role
          ) VALUES (
            'thr_current_a', 'thr_capacity_root', 'thr_capacity_root', '/root/a', 1,
            'Current A', ?, 'worker'
          )
        `).run(itemA.id);
      }),
      true,
    );
    assert.throws(
      () => db.prepare(`
        INSERT INTO collab_agents (
          thread_id, root_thread_id, parent_thread_id, task_name, created_at,
          display_name, item_id, role
        ) VALUES (
          'thr_late_legacy_b', 'thr_capacity_root', 'thr_capacity_root', '/root/b', 2,
          'Legacy B', ?, 'worker'
        )
      `).run(itemB.id),
      /root worker capacity is full/,
    );

    await host.harness.behavior.emitThreadEvent("thread.active", { thread: legacyChild });
    for (let index = 0; index < 6; index += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    assert.deepEqual(stopped, ["thr_late_legacy_b"]);
    assert.equal(items.list("thr_capacity_root").find((item) => item.id === itemB.id)!.status, "pending");
    assert.deepEqual(
      db.prepare(`
        SELECT thread_id, item_id FROM collab_agents
        WHERE root_thread_id='thr_capacity_root' AND retired_at IS NULL
        ORDER BY thread_id
      `).all(),
      [{ thread_id: "thr_current_a", item_id: itemA.id }],
    );
    const tombstone = db.prepare(`
      SELECT item_id, retired_at FROM collab_agents WHERE thread_id='thr_late_legacy_b'
    `).get() as { item_id: string | null; retired_at: number };
    assert.equal(tombstone.item_id, null);
    assert.ok(tombstone.retired_at > 0);
  });

  it("repairs stale generated-migration links before ultragoal_patch completion checks", async () => {
    const host = registeredHost();
    const db = host.bb.storage.database();
    db.prepare(
      "UPDATE goals SET thread_id='thr_patch_repair', status='active', max_workers=0 WHERE thread_id='thr_sentinel'",
    ).run();
    const items = createItemStore(host.bb);
    const findings = createFindingStore(host.bb);
    const item = items.add(
      "thr_patch_repair",
      "Repair tax-rate domain behavior in schema/src/tax-rates.ts",
      "in_progress",
      { files: ["schema/src/tax-rates.ts"] },
    )!;
    const primary = findings.report("thr_patch_repair", {
      title: "Tax-rate primary defect",
      file: "schema/src/tax-rates.ts:10",
      evidence: "The domain source created this work item.",
      fixFiles: ["schema/src/tax-rates.ts"],
    }).finding;
    const stale = findings.report("thr_patch_repair", {
      title: "Unrelated tenant foreign-key defect",
      file: "schema/migrations/generated/0001_baseline.sql:30655",
      evidence: "A monolithic generated baseline line was falsely coalesced.",
      fixFiles: ["schema/migrations/generated/0001_baseline.sql"],
    }).finding;
    db.prepare("UPDATE goal_findings SET created_at=1 WHERE id=?").run(primary.id);
    db.prepare("UPDATE goal_findings SET created_at=2 WHERE id=?").run(stale.id);
    assert.equal(findings.linkItem("thr_patch_repair", primary.id, item.id), true);
    assert.equal(findings.linkItem("thr_patch_repair", stale.id, item.id), true);
    assert.equal(
      findings.resolve("thr_patch_repair", primary.id, "fixed", "primary fixed with proof")!.status,
      "fixed",
    );

    const result = await host.harness.behavior.callAgentTool(
      "ultragoal_patch",
      { plan: [{ id: item.id, step: item.step, status: "completed" }] },
      { threadId: "thr_patch_repair" },
    );
    assert.equal(isToolError(result), false);
    assert.equal(items.list("thr_patch_repair").find((entry) => entry.id === item.id)!.status, "completed");
    const repaired = findings.get("thr_patch_repair", stale.id)!;
    assert.equal(repaired.status, "open");
    assert.notEqual(repaired.itemId, item.id);
  });

  it("puts every coalesced defect in worker and verifier briefs and rejects partial evidence", async () => {
    const prompts: string[] = [];
    let spawnCount = 0;
    const host = registeredHost({
      threads: {
        get: async ({ threadId }) => makeThreadResponse({
          id: threadId,
          projectId: "proj",
          providerId: "acp-opencode",
          environmentId: "env_brief",
          status: threadId === "thr_brief" ? "idle" : "idle",
          parentThreadId: threadId.startsWith("thr_worker") ? "thr_brief" : null,
        }),
        list: () => [],
        spawn: (args) => {
          prompts.push(args.prompt ?? "");
          spawnCount += 1;
          return makeThreadResponse({
            id: spawnCount === 1 ? "thr_worker_brief" : "thr_verifier_brief",
            projectId: "proj",
            providerId: "acp-opencode",
            environmentId: null,
            parentThreadId: "thr_brief",
            status: "active",
          });
        },
        update: ({ threadId }) => makeThreadResponse({ id: threadId }),
        output: () => ({ output: "Worker finished the linked remediation." }),
        send: () => ({ ok: true }),
        timeline: () => ({ rows: [] }),
        interactions: { list: async () => [] },
      },
      environments: {
        get: async () => ({
          id: "env_brief",
          hostId: "host_brief",
          path: "/srv/brief",
          branchName: "main",
        }),
      },
    }, () => ({ status: "valid", repository: "/srv/brief", commit: "d".repeat(40) }));
    const db = host.bb.storage.database();
    db.prepare(
      "UPDATE goals SET thread_id = 'thr_brief', status = 'active', max_workers = 1, verify_enabled = 1 WHERE thread_id = 'thr_sentinel'",
    ).run();
    const items = createItemStore(host.bb);
    const findings = createFindingStore(host.bb);
    const item = items.add(
      "thr_brief",
      "Repair downgrade and actor provenance together",
      "pending",
      { files: ["src/subscriptions.ts"], check: "npm test -- subscriptions" },
    )!;
    const first = findings.report("thr_brief", {
      title: "Downgrade drops the original actor",
      file: "src/subscriptions.ts:91",
      evidence: "Downgrade overwrites actor provenance before the audit insert.",
      fixFiles: ["src/subscriptions.ts"],
      check: "npm test -- downgrade",
    }).finding;
    const second = findings.report("thr_brief", {
      title: "Audit rows omit actor provenance",
      file: "src/subscriptions.ts:118",
      evidence: "The persisted audit row has a null actor for an authenticated request.",
      fixFiles: ["src/subscriptions.ts"],
      check: "npm test -- actor-provenance",
    }).finding;
    assert.equal(findings.linkItem("thr_brief", first.id, item.id), true);
    assert.equal(findings.linkItem("thr_brief", second.id, item.id), true);

    await host.harness.behavior.callAgentTool(
      "report_finding",
      {
        title: "Separate trigger defect",
        file: "src/scheduler-trigger.ts:1",
        evidence: "This separate item triggers a scheduler pass after both links exist.",
        fix_files: ["src/scheduler-trigger.ts"],
      },
      { threadId: "thr_brief" },
    );
    for (let index = 0; index < 6; index += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(prompts.length, 1);
    for (const [finding, check] of [
      [first, "npm test -- downgrade"],
      [second, "npm test -- actor-provenance"],
    ] as const) {
      assert.match(prompts[0]!, new RegExp(finding.id));
      assert.match(prompts[0]!, new RegExp(finding.title));
      assert.match(prompts[0]!, new RegExp(finding.file));
      assert.match(prompts[0]!, new RegExp(finding.evidence));
      assert.doesNotMatch(prompts[0]!, new RegExp(check));
    }
    assert.match(prompts[0]!, /agent-authored untrusted problem data/i);
    assert.match(prompts[0]!, /slice_done must satisfy every linked defect/i);

    const negativeProse = await host.harness.behavior.callAgentTool(
      "slice_done",
      {
        evidence: `commit abc123; ${first.id} is NOT fixed and ${second.id} check failed`,
        finding_evidence: [],
      },
      { threadId: "thr_worker_brief" },
    );
    assert.equal(isToolError(negativeProse), true);

    const partial = await host.harness.behavior.callAgentTool(
      "slice_done",
      {
        evidence: "commit abc123; npm test -- downgrade passed",
        finding_evidence: [
          { finding_id: first.id, proof: "downgrade regression passed" },
        ],
      },
      { threadId: "thr_worker_brief" },
    );
    assert.equal(isToolError(partial), true);
    assert.match(JSON.stringify(partial), new RegExp(second.id));
    const complete = await host.harness.behavior.callAgentTool(
      "slice_done",
      {
        evidence: "commit abc123; npm test -- subscriptions passed",
        finding_evidence: [
          { finding_id: first.id, proof: "downgrade regression passed" },
          { finding_id: second.id, proof: "actor provenance regression passed" },
        ],
      },
      { threadId: "thr_worker_brief" },
    );
    assert.equal(isToolError(complete), false);

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "thr_worker_brief",
        projectId: "proj",
        providerId: "acp-opencode",
        environmentId: null,
        parentThreadId: "thr_brief",
        status: "idle",
      }),
      lastAssistantText: "Worker finished and called slice_done.",
    });
    assert.equal(
      prompts.length,
      2,
      JSON.stringify({
        logs: host.harness.inspection.logEntries,
        calls: host.harness.inspection.sdk.calls.map((call) => call.path),
      }),
    );
    for (const [finding, check] of [
      [first, "npm test -- downgrade"],
      [second, "npm test -- actor-provenance"],
    ] as const) {
      assert.match(prompts[1]!, new RegExp(finding.id));
      assert.match(prompts[1]!, new RegExp(finding.evidence));
      assert.doesNotMatch(prompts[1]!, new RegExp(check));
    }
    assert.match(prompts[1]!, /DEFECT_COVERAGE/);
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "thr_verifier_brief",
        projectId: "proj",
        providerId: "acp-opencode",
        environmentId: null,
        parentThreadId: "thr_brief",
        status: "idle",
      }),
      lastAssistantText: [
        `DEFECT_COVERAGE: {"finding_id":"${first.id}","status":"pass","proof":"downgrade check passed"}`,
        `DEFECT_COVERAGE: {"finding_id":"${second.id}","status":"pass","proof":"actor provenance check passed"}`,
        "VERIFY_PASS: initially looked good",
        "VERIFY_FAIL: contradictory trailing verdict",
      ].join("\n"),
    });
    assert.equal(
      items.list("thr_brief").find((entry) => entry.id === item.id)!.status,
      "in_progress",
      "ambiguous verifier output must not complete the work item",
    );
    assert.equal(
      (db.prepare(
        "SELECT last_verify_hash FROM collab_agents WHERE thread_id='thr_worker_brief'",
      ).get() as { last_verify_hash: string | null }).last_verify_hash,
      null,
      "an invalid verifier verdict must not suppress replacement verification",
    );
    let verifierRetries = host.harness.inspection.sdk.callsTo("threads.send").filter(
      (call) => (call[0] as { threadId?: string }).threadId === "thr_verifier_brief",
    );
    assert.equal(verifierRetries.length, 1);
    assert.match(JSON.stringify(verifierRetries[0]), /missing, malformed, or ambiguous/i);

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "thr_verifier_brief",
        projectId: "proj",
        providerId: "acp-opencode",
        environmentId: null,
        parentThreadId: "thr_brief",
        status: "idle",
      }),
      lastAssistantText: [
        `DEFECT_COVERAGE: {"finding_id":"${first.id}","status":"pass","proof":"downgrade check passed"}`,
        `${second.id} is NOT fixed; check failed`,
        "VERIFY_PASS: stale verifier thought the old scope passed",
      ].join("\n"),
    });
    assert.equal(
      items.list("thr_brief").find((entry) => entry.id === item.id)!.status,
      "in_progress",
      "a stale verifier pass must not close newly linked scope",
    );
    assert.equal(
      (db.prepare(
        "SELECT last_verify_hash FROM collab_agents WHERE thread_id='thr_worker_brief'",
      ).get() as { last_verify_hash: string | null }).last_verify_hash,
      null,
      "invalid verifier coverage must not suppress replacement verification",
    );
    verifierRetries = host.harness.inspection.sdk.callsTo("threads.send").filter(
      (call) => (call[0] as { threadId?: string }).threadId === "thr_verifier_brief",
    );
    assert.equal(verifierRetries.length, 2);
    assert.match(JSON.stringify(verifierRetries[1]), new RegExp(second.id));

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "thr_verifier_brief",
        projectId: "proj",
        providerId: "acp-opencode",
        environmentId: null,
        parentThreadId: "thr_brief",
        status: "idle",
      }),
      lastAssistantText: [
        `DEFECT_COVERAGE: {"finding_id":"${first.id}","status":"pass","proof":"downgrade check passed"}`,
        `DEFECT_COVERAGE: {"finding_id":"${second.id}","status":"pass","proof":"actor provenance check passed"}`,
        "VERIFY_PASS: all current linked defects passed",
      ].join("\n"),
    });
    assert.equal(items.list("thr_brief").find((entry) => entry.id === item.id)!.status, "completed");
    // ATTESTED, not fixed. The verifier proved the WORK; proving the work is not
    // showing the fix is live where the install consumes it, which is the merge's
    // job (see "squash-merges into the branch the worker environment declares",
    // where the same closure is promoted to fixed by the integration itself).
    assert.equal(findings.get("thr_brief", first.id)!.status, "fixed_unverified");
    assert.equal(findings.get("thr_brief", second.id)!.status, "fixed_unverified");
    // The event deliberately publishes/steers through fire-and-forget hooks;
    // let those bounded promises settle before the fake database is disposed.
    for (let index = 0; index < 8; index += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  });

  it("bounds invalid verifier protocol retries and leaves the item open for root handoff", async () => {
    const host = registeredHost({
      threads: {
        get: ({ threadId }) => makeThreadResponse({
          id: threadId,
          projectId: "proj",
          providerId: "acp-opencode",
          environmentId: null,
          parentThreadId: threadId === "thr_protocol_root" ? null : "thr_protocol_root",
          status: "idle",
        }),
        list: () => [],
        send: () => ({ ok: true }),
        stop: () => ({ ok: true }),
        output: () => ({ output: "Worker claims completion." }),
        timeline: () => ({ rows: [] }),
        interactions: { list: async () => [] },
      },
    });
    const db = host.bb.storage.database();
    db.prepare(
      "UPDATE goals SET thread_id='thr_protocol_root', status='active', max_workers=1, verify_enabled=1, auto_continue=1 WHERE thread_id='thr_sentinel'",
    ).run();
    const item = createItemStore(host.bb).add(
      "thr_protocol_root",
      "Keep malformed verifier output from stranding this work",
      "in_progress",
      { files: ["src/protocol.ts"] },
    )!;
    db.prepare(`
      INSERT INTO collab_agents (
        thread_id, root_thread_id, parent_thread_id, task_name, created_at,
        display_name, item_id, role, source_thread_id, last_verify_hash
      ) VALUES
        ('thr_protocol_worker', 'thr_protocol_root', 'thr_protocol_root', '/root/protocol', 10,
          'Protocol worker', ?, 'worker', NULL, 'stale-digest'),
        ('thr_protocol_verifier', 'thr_protocol_root', 'thr_protocol_root', '/root/protocol/verifier', 11,
          'Protocol verifier', ?, 'verifier', 'thr_protocol_worker', NULL)
    `).run(item.id, item.id);

    const malformedIdle = {
      thread: makeThreadResponse({
        id: "thr_protocol_verifier",
        projectId: "proj",
        providerId: "acp-opencode",
        environmentId: null,
        parentThreadId: "thr_protocol_root",
        status: "idle",
      }),
      lastAssistantText: "I inspected the work but omitted the required final verdict.",
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await host.harness.behavior.emitThreadEvent("thread.idle", malformedIdle);
    }
    for (let index = 0; index < 8; index += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    assert.equal(
      createItemStore(host.bb).list("thr_protocol_root").find((entry) => entry.id === item.id)!.status,
      "in_progress",
    );
    const workerState = db.prepare(
      "SELECT verify_fails, last_verify_hash FROM collab_agents WHERE thread_id='thr_protocol_worker'",
    ).get() as { verify_fails: number; last_verify_hash: string | null };
    assert.equal(workerState.verify_fails, 3);
    assert.equal(workerState.last_verify_hash, null);
    assert.notEqual(
      (db.prepare(
        "SELECT retired_at FROM collab_agents WHERE thread_id='thr_protocol_verifier'",
      ).get() as { retired_at: number | null }).retired_at,
      null,
    );
    const sends = host.harness.inspection.sdk.callsTo("threads.send");
    assert.equal(
      sends.filter((call) => (call[0] as { threadId?: string }).threadId === "thr_protocol_verifier").length,
      2,
      "the third protocol failure must hit the durable cap instead of retrying forever",
    );
    assert.ok(
      sends.some((call) => (call[0] as { threadId?: string }).threadId === "thr_protocol_root"),
      "the root must be awakened after the retry budget is exhausted",
    );
  });
});

describe("resolve_finding end to end", () => {
  const PLUGIN_REPO = "/Users/braedonsaunders/Documents/bb-plugin-ultragoal";

  function e2eHost() {
    // Stub the world the tool actually consults: a thread with an environment,
    // an environment with a host and a path, and a host RPC that knows exactly
    // one commit. d29990c is the commit that carried the fix; 2e4f7dd is the
    // token typed from memory that never existed.
    const host = createFakePluginHost({
      pluginId: `ultragoal-e2e-${hosts.length}`,
      agentSkillIds: ["ultragoal"],
      sdk: {
        threads: { get: async () => makeThreadResponse({ id: "thr_root", environmentId: "env_1" }) },
        environments: { get: async () => ({ id: "env_1", hostId: "host_1", path: PLUGIN_REPO }) },
      },
      // Top level, not inside sdk: this is the host entry the plugin asks.
      experimental_callHostRpc: (call: { input?: unknown }) => ({
        exists: (call.input as { token?: string } | undefined)?.token === "d29990c",
      }),
    } as never);
    hosts.push(host);
    host.bb.storage.database().exec(`
      CREATE TABLE goals (
        thread_id TEXT PRIMARY KEY, objective TEXT NOT NULL, status TEXT NOT NULL, reason TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER NOT NULL,
        turn_count INTEGER NOT NULL, max_turns INTEGER NOT NULL, max_minutes INTEGER NOT NULL,
        last_continue_at INTEGER, last_assistant_hash TEXT
      );
      INSERT INTO goals VALUES ('thr_sentinel', 'test', 'complete', NULL, 1, 1, 1, 0, 0, 0, NULL, NULL);
    `);
    plugin(host.bb);
    const findings = createFindingStore(host.bb);
    return { host, findings };
  }

  it("refuses a nonexistent commit and leaves the finding untouched", async () => {
    const { host, findings } = e2eHost();
    const rec = findings.report("thr_root", { title: "t", file: "a.ts:1", evidence: "e" });

    const result = await host.harness.behavior.callAgentTool(
      "resolve_finding",
      {
        finding: rec.finding.id,
        resolution: "fixed",
        evidence: "resolved against 2e4f7dd",
        repository: PLUGIN_REPO,
      },
      { threadId: "thr_root" },
    );

    const refused = result as { isError?: boolean; content?: unknown };
    assert.equal(refused.isError, true, "an unresolvable citation must fail closed");
    assert.match(JSON.stringify(refused.content), /2e4f7dd/);
    assert.equal(
      findings.get("thr_root", rec.finding.id)!.status,
      "open",
      "the finding must not change: a refused closure that still closes is no refusal",
    );
  });

  it("closes on a commit the named repository really contains", async () => {
    const { host, findings } = e2eHost();
    const rec = findings.report("thr_root", { title: "t", file: "b.ts:1", evidence: "e" });

    const result = await host.harness.behavior.callAgentTool(
      "resolve_finding",
      {
        finding: rec.finding.id,
        resolution: "fixed",
        evidence: "fixed in d29990c, tagged v0.26.0",
        repository: PLUGIN_REPO,
      },
      { threadId: "thr_root" },
    );

    assert.notEqual((result as { isError?: boolean }).isError, true, JSON.stringify(result));
    assert.equal(findings.get("thr_root", rec.finding.id)!.status, "fixed");
  });

  it("still closes when no commit is cited at all", async () => {
    // Plenty of legitimate resolutions are prose — "not a defect because…".
    // The guard must bite on bad citations, not on their absence.
    const { host, findings } = e2eHost();
    const rec = findings.report("thr_root", { title: "t", file: "c.ts:1", evidence: "e" });
    const result = await host.harness.behavior.callAgentTool(
      "resolve_finding",
      { finding: rec.finding.id, resolution: "not_a_defect", evidence: "the guard already covers this path" },
      { threadId: "thr_root" },
    );
    assert.notEqual((result as { isError?: boolean }).isError, true, JSON.stringify(result));
    assert.equal(findings.get("thr_root", rec.finding.id)!.status, "dismissed");
  });

  it("refuses when no repository was reachable to check the citation", async () => {
    // Not the same reason as "absent", but the same conclusion: an unchecked
    // SHA is not evidence, and letting it through is how an unverified
    // citation becomes a fixed finding.
    const host = createFakePluginHost({
      pluginId: `ultragoal-e2e-unreachable-${hosts.length}`,
      agentSkillIds: ["ultragoal"],
      sdk: {
        threads: { get: async () => makeThreadResponse({ id: "thr_root", environmentId: null }) },
      },
    } as never);
    hosts.push(host);
    host.bb.storage.database().exec(`
      CREATE TABLE goals (
        thread_id TEXT PRIMARY KEY, objective TEXT NOT NULL, status TEXT NOT NULL, reason TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER NOT NULL,
        turn_count INTEGER NOT NULL, max_turns INTEGER NOT NULL, max_minutes INTEGER NOT NULL,
        last_continue_at INTEGER, last_assistant_hash TEXT
      );
      INSERT INTO goals VALUES ('thr_sentinel', 'test', 'complete', NULL, 1, 1, 1, 0, 0, 0, NULL, NULL);
    `);
    plugin(host.bb);
    const findings = createFindingStore(host.bb);
    const rec = findings.report("thr_root", { title: "t", file: "d.ts:1", evidence: "e" });

    const result = await host.harness.behavior.callAgentTool(
      "resolve_finding",
      { finding: rec.finding.id, resolution: "fixed", evidence: "fixed in d29990c" },
      { threadId: "thr_root" },
    );

    assert.equal((result as { isError?: boolean }).isError, true);
    assert.equal(findings.get("thr_root", rec.finding.id)!.status, "open");
  });
});

describe("automatic slice integration", () => {
  /**
   * The merge target is a DECLARED field. `defaultBranch` describes the
   * project; it is not a statement about where this goal's work belongs, and
   * on the goals that run this plugin it names `main` — a passive upstream
   * tracker — while the base is `integration`. Measured on the host database
   * (`bb.db`, 2026-09-14): of the managed worktree environments carrying no
   * mergeBaseBranch, 100 have a defaultBranch that DIFFERS from the baseBranch
   * they were cut from, 47 of those `main` vs `integration`. Falling through to
   * defaultBranch squash-merges those slices onto unrelated history and records
   * "integrated" while doing it, so the corruption surfaces much later as an
   * unexplained conflict with nothing pointing back here.
   */
  interface FakeEnvironment {
    branchName: string | null;
    baseBranch: string | null;
    defaultBranch: string | null;
    mergeBaseBranch: string | null;
  }

  const spawnedWorker = () => makeThreadResponse({
    id: "thr_worker_int",
    projectId: "proj",
    providerId: "acp-opencode",
    environmentId: "env_worker_int",
    parentThreadId: "thr_int",
    status: "active",
  });

  async function runIntegration(environment: FakeEnvironment) {
    const hostRpcCalls: string[] = [];
    const host = createFakePluginHost({
      pluginId: `ultragoal-integration-${hosts.length}`,
      agentSkillIds: ["ultragoal"],
      experimental_callHostRpc: (call) => {
        hostRpcCalls.push(call.method);
        if (call.method === "branchAddsWork") return { adds: true };
        return { removed: false, freedBytes: 0, reason: "test" };
      },
      sdk: {
        threads: {
          get: async ({ threadId }) => makeThreadResponse({
            id: threadId,
            projectId: "proj",
            providerId: "acp-opencode",
            status: "idle",
            // Only the WORKER has the environment under test. The root thread
            // deliberately has none, so collab's own spawn-side refusal (which
            // reads the ROOT environment) cannot stand in for the consumer-side
            // behaviour this test is about.
            environmentId: threadId === "thr_worker_int" ? "env_worker_int" : null,
            parentThreadId: threadId === "thr_worker_int" ? "thr_int" : null,
          }),
          list: () => [],
          spawn: () => spawnedWorker(),
          fork: async () => spawnedWorker(),
          update: ({ threadId }) => makeThreadResponse({ id: threadId }),
          output: () => ({ output: "Worker finished the slice." }),
          send: () => ({ ok: true }),
          stop: () => ({ ok: true }),
          timeline: () => ({ rows: [] }),
          interactions: { list: async () => [] },
        },
        environments: {
          get: async ({ environmentId }) => ({
            id: environmentId,
            projectId: "proj",
            hostId: "host_test",
            path: "/tmp/ultragoal-integration-test",
            isGitRepo: true,
            isWorktree: true,
            managed: true,
            status: "ready",
            name: null,
            createdAt: 0,
            ...environment,
          }),
          squashMerge: () => ({ ok: true }),
        },
      },
    } satisfies CreateFakePluginHostOptions);
    hosts.push(host);
    const db = host.bb.storage.database();
    db.exec(`
      CREATE TABLE goals (
        thread_id TEXT PRIMARY KEY, objective TEXT NOT NULL, status TEXT NOT NULL, reason TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER NOT NULL,
        turn_count INTEGER NOT NULL, max_turns INTEGER NOT NULL, max_minutes INTEGER NOT NULL,
        last_continue_at INTEGER, last_assistant_hash TEXT
      );
      INSERT INTO goals VALUES ('thr_sentinel', 'test', 'complete', NULL, 1, 1, 1, 0, 0, 0, NULL, NULL);
    `);
    plugin(host.bb);
    db.prepare(
      "UPDATE goals SET thread_id = 'thr_int', status = 'active', max_workers = 1, verify_enabled = 0, auto_integrate_completed_slices = 1 WHERE thread_id = 'thr_sentinel'",
    ).run();

    const items = createItemStore(host.bb);
    const findings = createFindingStore(host.bb);
    const item = items.add("thr_int", "Land the slice on the goal's base branch", "pending", {
      files: ["src/integration.ts"],
    })!;
    const defect = findings.report("thr_int", {
      title: "The slice's defect",
      file: "src/integration.ts:1",
      evidence: "Closed on the worker's report, before any merge was attempted.",
      fixFiles: ["src/integration.ts"],
    }).finding;
    assert.equal(findings.linkItem("thr_int", defect.id, item.id), true);

    const spawned = await host.harness.behavior.callAgentTool(
      "ultragoal_spawn_agent",
      {
        task_name: "integration_worker",
        display_name: "The Base Branch Reckoning",
        item_id: item.id,
        message: `SLICE (item_id=${item.id}): Land the slice on the goal's base branch`,
      },
      { threadId: "thr_int" },
    );
    assert.equal(isToolError(spawned), false, JSON.stringify(spawned));

    const done = await host.harness.behavior.callAgentTool(
      "slice_done",
      {
        evidence: "commit deadbee; the slice's own check passed",
        finding_evidence: [{ finding_id: defect.id, proof: "regression added and passing" }],
      },
      { threadId: "thr_worker_int" },
    );
    assert.equal(isToolError(done), false, JSON.stringify(done));

    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({
        id: "thr_worker_int",
        projectId: "proj",
        providerId: "acp-opencode",
        environmentId: "env_worker_int",
        parentThreadId: "thr_int",
        status: "idle",
      }),
      lastAssistantText: "Worker finished and called slice_done.",
    });

    // queueIntegration is fire-and-forget: the lifecycle handler stores the
    // promise and returns. Drain it by waiting for the outcome row rather than
    // guessing a tick count, which is how this test would go flaky.
    let integration: { status: string; detail: string | null; branch: string | null } | undefined;
    for (let attempt = 0; attempt < 200 && !integration; attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      integration = db
        .prepare("SELECT status, detail, branch FROM goal_item_integrations WHERE thread_id = ? AND item_id = ?")
        .get("thr_int", item.id) as typeof integration;
    }
    // The register row is written BEFORE the findings reopen and the slice is
    // requeued. Nothing awaits between them today, so the row is a sound
    // trigger — but drain the rest of that turn anyway, or the day someone adds
    // an await this test starts failing intermittently and for the wrong reason.
    for (let settle = 0; settle < 20; settle += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return {
      host,
      hostRpcCalls,
      defectId: defect.id,
      itemId: item.id,
      findings,
      items,
      integration,
      squashMerges: host.harness.inspection.sdk.callsTo("environments.squashMerge"),
    };
  }

  it("squash-merges into the branch the worker environment declares", async () => {
    // Positive control. Without it, a fix that simply deleted the integration
    // path would pass the refusal test below.
    const run = await runIntegration({
      branchName: "bb/slice-one",
      baseBranch: "origin/main",
      defaultBranch: "main",
      mergeBaseBranch: "integration",
    });

    assert.equal(run.squashMerges.length, 1);
    assert.deepEqual(run.squashMerges[0], [
      { environmentId: "env_worker_int", mergeBaseBranch: "integration" },
    ]);
    assert.equal(run.integration?.status, "integrated");
    assert.match(run.integration?.detail ?? "", /integration/);
    assert.equal(run.findings.get("thr_int", run.defectId)!.status, "fixed");
  });

  it("refuses to merge, and strands the branch, when the worker environment names no merge base", async () => {
    // defaultBranch and baseBranch are both present and both wrong: `main` is
    // the project default and `origin/main` is a REMOTE ref that is not a merge
    // target at all (the host database holds base_branch values that are bare
    // SHAs). Neither may stand in for the declared merge base.
    const run = await runIntegration({
      branchName: "bb/slice-two",
      baseBranch: "origin/main",
      defaultBranch: "main",
      mergeBaseBranch: null,
    });

    assert.deepEqual(run.squashMerges, []);
    // The worktree holds the only copy of unmerged work. Reclaiming it here
    // would delete that work, silently and unrecoverably.
    assert.equal(run.hostRpcCalls.includes("reclaimWorktree"), false);
    // Nor may a null base be handed to the repository probe: "does this branch
    // add work relative to nothing" has no answer, and the fallback it would
    // stand in for is the one being removed.
    assert.equal(run.hostRpcCalls.includes("branchAddsWork"), false);
    assert.equal(run.integration?.status, "failed");
    assert.equal(run.integration?.branch, "bb/slice-two");
    assert.match(run.integration?.detail ?? "", /merge base/i);
    assert.match(run.integration?.detail ?? "", /env_worker_int/);
    // Closure happened on the worker's report, before this ran. Nothing landed,
    // so the register must stop claiming the defect is fixed.
    assert.equal(run.findings.get("thr_int", run.defectId)!.status, "open");
    const requeued = run.items.list("thr_int").find((row) => row.id === run.itemId)!;
    assert.equal(requeued.status, "pending");
    assert.match(requeued.step, /STRANDED WORK/);
  });
});

describe("cross-repo staffing provenance", () => {
  function crossRepoHost() {
    // The goal root stands in ONE project; a filer inside the tree stands in
    // another. That is the whole incident: staffing cuts the worker worktree
    // from the goal's project, so a finding filed against another repository
    // scopes its slice to files that checkout has never contained.
    const host = registeredHost({
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            projectId: threadId === "thr_foreign" ? "proj_ultragoal" : "proj_omegacode",
            providerId: "acp-opencode",
            environmentId: null,
            status: "idle",
          }),
        list: () => [],
        spawn: () =>
          makeThreadResponse({
            id: "thr_staffed",
            projectId: "proj_omegacode",
            providerId: "acp-opencode",
            environmentId: null,
            parentThreadId: "thr_root",
            status: "active",
          }),
        update: ({ threadId }) => makeThreadResponse({ id: threadId }),
        send: () => ({ ok: true }),
        timeline: () => ({ rows: [] }),
        interactions: { list: async () => [] },
      },
    });
    const db = host.bb.storage.database();
    db.prepare(
      "UPDATE goals SET thread_id = 'thr_root', status = 'active', max_workers = 2 WHERE thread_id = 'thr_sentinel'",
    ).run();
    // The filer is a goal-tree child holding no slice, so rootId() resolves the
    // finding to the goal while its own thread project stays the foreign one.
    db.prepare(`
      INSERT INTO collab_agents (
        thread_id, root_thread_id, parent_thread_id, task_name, created_at,
        display_name, item_id, role
      ) VALUES ('thr_foreign', 'thr_root', 'thr_root', '/root/filer', 1,
        'The Filer', NULL, 'worker')
    `).run();
    return host;
  }

  it("captures the filing thread's project and refuses to staff that slice here", async () => {
    // Both halves in one run, because either alone is inert: without capture
    // the refusal has nothing to compare, and without the refusal the capture
    // is a column nobody reads. Provenance is read host-side from the thread,
    // never from the tool's arguments, so a filer cannot name its own repo.
    const host = crossRepoHost();
    const findings = createFindingStore(host.bb);

    const filed = await host.harness.behavior.callAgentTool(
      "report_finding",
      {
        title: "A finding whose file lives outside the goal's project",
        file: "lib/collab.ts:750",
        evidence: "lib/collab.ts exists only in the plugin repository.",
      },
      { threadId: "thr_foreign" },
    );
    assert.equal(isToolError(filed), false, JSON.stringify(filed));
    // registerFinding schedules staffing with `void scheduleReady(...)`, so the
    // spawn attempt it arms is still in flight when the tool returns. Drain that
    // turn here, or it lands on the next test's already-closed database.
    for (let index = 0; index < 8; index += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const finding = findings.remediationQueue("thr_root")[0]!;
    assert.equal(
      finding.projectId,
      "proj_ultragoal",
      "the filing thread's project is captured without being passed in",
    );

    // Staff the slice the plugin itself minted for this finding — that is the
    // one whose brief carries the provenance, so a hand-made item would prove
    // nothing about the real path.
    const itemId = finding.itemId;
    assert.ok(itemId, "a new finding is assigned its own fix slice");

    const staffed = await host.harness.behavior.callAgentTool(
      "ultragoal_spawn_agent",
      {
        task_name: "fix_cross_repo",
        item_id: itemId,
        message: `SLICE (item_id=${itemId}): fix the staffing path`,
        fork_turns: "none",
      },
      { threadId: "thr_root", projectId: "proj_omegacode" },
    );
    assert.equal(isToolError(staffed), true, JSON.stringify(staffed));
    const refusal = JSON.stringify(staffed);
    assert.match(refusal, /proj_ultragoal/);
    assert.match(refusal, /proj_omegacode/);
  });
});

describe("reload-safe courier reconciliation", () => {
  /**
   * A goal root whose crew exists only as durable rows, and whose host answers a
   * per-thread status. This is the reload case #35 is about: no `thread.idle`
   * event is ever emitted, so only the pulse's durable sweep can retire a row.
   */
  function courierRoot(options: {
    rootId: string;
    reads?: Record<string, "idle" | "missing" | "unreadable" | "active">;
    rows?: Array<Record<string, unknown>>;
    maxWorkers?: number;
  }) {
    const reads = options.reads ?? {};
    const spawned: Array<{ id: string; prompt: string }> = [];
    const archived: string[] = [];
    const host = registeredHost({
      threads: {
        get: async ({ threadId }) => {
          if (threadId === options.rootId) {
            return makeThreadResponse({
              id: threadId,
              projectId: "proj",
              providerId: "codex",
              environmentId: null,
              parentThreadId: null,
              status: "active",
            });
          }
          const read = reads[threadId] ?? "active";
          if (read === "missing") {
            throw Object.assign(new Error("HTTP 404: thread not found"), {
              status: 404,
              code: "thread_not_found",
            });
          }
          if (read === "unreadable") throw new Error("host read failed");
          return makeThreadResponse({
            id: threadId,
            projectId: "proj",
            providerId: "codex",
            environmentId: null,
            parentThreadId: options.rootId,
            status: read,
          });
        },
        list: () => [],
        timeline: ({ threadId }) => ({
          rows: (threadId === options.rootId ? (options.rows ?? []) : []) as never[],
        }),
        spawn: async (args) => {
          const id = `thr_courier_${spawned.length + 1}`;
          spawned.push({ id, prompt: args.prompt ?? "" });
          return makeThreadResponse({
            id,
            projectId: "proj",
            providerId: "codex",
            environmentId: null,
            parentThreadId: options.rootId,
            status: "active",
          });
        },
        output: () => ({ output: null }),
        stop: () => ({ ok: true }),
        // Retirement archives the row it retires. An unstubbed sdk path throws
        // synchronously, which would abort the sweep's candidate loop rather
        // than let it reconcile the rest.
        archive: async ({ threadId }) => {
          archived.push(threadId);
          return { archivedThreadIds: [threadId], ok: true as const };
        },
        send: () => ({ ok: true }),
        update: ({ threadId }) => makeThreadResponse({ id: threadId }),
        interactions: { list: async () => [], resolve: async () => ({}) },
      },
    });
    const db = host.bb.storage.database();
    db.prepare(
      "UPDATE goals SET thread_id = ?, status = 'active', max_workers = ?, last_continue_at = ? WHERE thread_id = 'thr_sentinel'",
    ).run(options.rootId, options.maxWorkers ?? 4, Date.now());
    const seed = (args: {
      id: string;
      taskName: string;
      displayName: string | null;
      createdAt: number;
      role?: string;
    }) => {
      db.prepare(`
        INSERT INTO collab_agents (
          thread_id, root_thread_id, parent_thread_id, task_name, created_at,
          display_name, item_id, role
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
      `).run(
        args.id,
        options.rootId,
        options.rootId,
        args.taskName,
        args.createdAt,
        args.displayName,
        args.role ?? "worker",
      );
    };
    const rowsWhere = (sql: string) =>
      (
        db
          .prepare(
            `SELECT thread_id FROM collab_agents WHERE root_thread_id = ? AND ${sql} ORDER BY thread_id`,
          )
          .all(options.rootId) as Array<{ thread_id: string }>
      ).map((row) => row.thread_id);
    const liveRows = () => rowsWhere("retired_at IS NULL");
    const retiredRows = () => rowsWhere("retired_at IS NOT NULL");
    const occupancy = () =>
      createItemReservationStore(db).occupancy(options.rootId);
    const logs = () => host.harness.inspection.logEntries.map((entry) => entry.message);
    const settle = async () => {
      for (let index = 0; index < 40; index += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    /** One deterministic sweep of the 20s progress pulse (no timers in tests). */
    const pulse = async () => {
      const service = host.harness.behavior.runService("progress-pulse");
      await settle();
      service.controller.abort();
      await service.done;
      await settle();
    };
    return { host, db, spawned, archived, seed, liveRows, retiredRows, occupancy, logs, pulse };
  }

  it("retires a settled courier with no idle event and leaves an itemless non-courier alone", async () => {
    const root = courierRoot({
      rootId: "thr_courier_settled",
      reads: { thr_settled_courier: "idle", thr_itemless_child: "idle" },
    });
    root.seed({
      id: "thr_settled_courier",
      taskName: "/root/intake_courier_settled1",
      displayName: "Intake Courier",
      createdAt: 1,
    });
    // A discovered child is itemless too. It is not the plugin's courier, and
    // #19 forbids retiring it for being itemless.
    root.seed({
      id: "thr_itemless_child",
      taskName: "/root/discovered_child_9zz",
      displayName: "Discovered Child",
      createdAt: 1,
    });

    await root.pulse();

    assert.deepEqual(root.retiredRows(), ["thr_settled_courier"], "a settled courier is reconciled durably");
    assert.deepEqual(root.liveRows(), ["thr_itemless_child"], "an itemless non-courier worker is never swept");
    assert.ok(
      root.archived.includes("thr_settled_courier"),
      `the retired courier is archived too: ${JSON.stringify(root.archived)}`,
    );
    assert.ok(
      root.logs().some((message) => message.includes("Retired finished worker thr_settled_courier")),
      `the sweep says which row it retired: ${JSON.stringify(root.logs())}`,
    );
  });

  it("leaves a courier lookalike with another display name alone", async () => {
    const root = courierRoot({
      rootId: "thr_courier_lookalike",
      reads: { thr_lookalike: "idle" },
    });
    root.seed({
      id: "thr_lookalike",
      taskName: "/root/intake_courier_diagnostics",
      displayName: "Intake Courier Diagnostics",
      createdAt: 1,
    });

    await root.pulse();

    assert.deepEqual(root.liveRows(), ["thr_lookalike"], "a shared name prefix is not an identity");
    assert.deepEqual(root.retiredRows(), []);
  });

  it("retains a courier younger than its provisioning grace even when the host reads settled", async () => {
    const root = courierRoot({
      rootId: "thr_courier_fresh",
      reads: { thr_fresh_courier: "idle" },
    });
    root.seed({
      id: "thr_fresh_courier",
      taskName: "/root/intake_courier_fresh1",
      displayName: "Intake Courier",
      createdAt: Date.now(),
    });

    await root.pulse();

    assert.deepEqual(
      root.liveRows(),
      ["thr_fresh_courier"],
      "a settled status cannot tell provisioning from a finished triage",
    );
    assert.deepEqual(root.retiredRows(), []);
  });

  it("retires an authoritatively missing courier and retains a transiently unreadable one", async () => {
    const root = courierRoot({
      rootId: "thr_courier_authority",
      reads: { thr_unreadable_courier: "unreadable", thr_missing_courier: "missing" },
    });
    // The unreadable row is seeded first: its failed read must not abort the
    // sweep before the missing row behind it is confirmed and retired.
    root.seed({
      id: "thr_unreadable_courier",
      taskName: "/root/intake_courier_unread1",
      displayName: "Intake Courier",
      createdAt: 1,
    });
    root.seed({
      id: "thr_missing_courier",
      taskName: "/root/intake_courier_missing1",
      displayName: "Intake Courier",
      createdAt: 1,
    });

    await root.pulse();

    assert.deepEqual(
      root.retiredRows(),
      ["thr_missing_courier"],
      "a 404 is proof of absence; a failed read is not",
    );
    assert.deepEqual(root.liveRows(), ["thr_unreadable_courier"]);
  });

  it("frees the slot a settled courier held so the queued owner row staffs a new one", async () => {
    const ownerRow = (id: string, text: string) => ({
      kind: "conversation",
      role: "user",
      id,
      text,
    });
    const root = courierRoot({
      rootId: "thr_courier_capacity",
      reads: { thr_stale_courier: "idle" },
      rows: [ownerRow("row_1", "kick off"), ownerRow("row_2", "Owner request: file this")],
      maxWorkers: 1,
    });
    root.seed({
      id: "thr_stale_courier",
      taskName: "/root/intake_courier_stale2",
      displayName: "Intake Courier",
      createdAt: 1,
    });
    // Baseline the cursor on row_1: only rows after it dispatch.
    root.db.prepare("UPDATE goals SET intake_row_id = 'row_1' WHERE thread_id = ?").run("thr_courier_capacity");
    assert.equal(root.occupancy(), 1, "the settled courier holds the root's only slot");

    await root.pulse();

    assert.deepEqual(root.liveRows(), [], "the reconciled courier released its slot");
    assert.equal(root.occupancy(), 0, "capacity is free again once the row is retired");

    await root.pulse();

    assert.equal(
      root.spawned.length,
      1,
      `the queued owner row must staff a courier once the slot is free: ${JSON.stringify(root.logs())}`,
    );
    assert.match(root.spawned[0].prompt, /Owner request: file this/);
  });
});

describe("remediation retirement end to end", () => {
  it("retires only a plugin-minted finding item, never a pre-existing one a finding coalesced into", async () => {
    const host = registeredHost();
    const db = host.bb.storage.database();
    // max_workers 0 keeps this focused on retirement: no scheduler spawn runs.
    db.prepare(
      "UPDATE goals SET thread_id = 'thr_origin', status = 'active', max_workers = 0 WHERE thread_id = 'thr_sentinel'",
    ).run();
    const items = createItemStore(host.bb);
    const findings = createFindingStore(host.bb);

    // The CFP#37 shape: an owner-held slice with its own scope predates any
    // finding. A same-file defect coalesces onto it; dismissing that defect
    // must leave the owner's work exactly as it was.
    const declared = items.add("thr_origin", "Runtime telemetry isolation", "pending", {
      files: ["src/telemetry.ts"],
      check: "npm test -- telemetry",
    })!;
    // A downstream slice already depends on the owner row. Item removal purges
    // a deleted id from every dependent's deps, so this edge is part of what a
    // wrong retirement destroys.
    const dependent = items.add("thr_origin", "Telemetry consumer rollout", "pending", {
      deps: [declared.id],
      files: ["src/consumer.ts"],
    })!;
    // The regression item was owner-held, not merely pending.
    const held = await host.harness.behavior.runCli([
      "release", declared.id, "--hold", "--thread", "thr_origin",
    ]);
    assert.equal(held.exitCode, 0, held.stderr);
    const filed = await host.harness.behavior.runCli([
      "finding", "A same-file telemetry defect",
      "--file", "src/telemetry.ts:12",
      "--evidence", "The defect shares one concrete file with the declared slice.",
      "--fix-files", "src/telemetry.ts",
      "--thread", "thr_origin",
    ]);
    assert.equal(filed.exitCode, 0, filed.stderr);
    const coalesced = findings.list("thr_origin").find(
      (row) => row.title === "A same-file telemetry defect",
    )!;
    assert.equal(coalesced.itemId, declared.id);
    const before = db.prepare("SELECT * FROM goal_items WHERE id = ?").get(declared.id);
    const dependentBefore = db.prepare("SELECT * FROM goal_items WHERE id = ?").get(dependent.id);
    assert.deepEqual(
      items.list("thr_origin").find((row) => row.id === dependent.id)!.deps,
      [declared.id],
    );

    const dismissed = await host.harness.behavior.runCli([
      "resolve", coalesced.id, "--as", "not-a-defect",
      "--evidence", "Same-file overlap only; the owner requirement still stands.",
      "--thread", "thr_origin",
    ]);
    assert.equal(dismissed.exitCode, 0, dismissed.stderr);
    assert.doesNotMatch(dismissed.stdout ?? "", /retired its now-orphaned remediation item/);
    assert.deepEqual(db.prepare("SELECT * FROM goal_items WHERE id = ?").get(declared.id), before);
    assert.equal(items.origin("thr_origin", declared.id), null);
    assert.deepEqual(
      db.prepare("SELECT * FROM goal_items WHERE id = ?").get(dependent.id),
      dependentBefore,
    );
    assert.deepEqual(
      items.list("thr_origin").find((row) => row.id === dependent.id)!.deps,
      [declared.id],
      "the removed item's id must never be purged from a dependent's deps",
    );
    const stillHeld = await host.harness.behavior.runCli([
      "item", declared.id, "--thread", "thr_origin",
    ]);
    assert.equal(stillHeld.exitCode, 0, stillHeld.stderr);
    assert.match(stillHeld.stdout ?? "", /HELD out of scheduling/);

    // The CLI removal guard agrees with automatic retirement and says why.
    const refused = await host.harness.behavior.runCli([
      "item", declared.id, "--remove", "--thread", "thr_origin",
    ]);
    assert.equal(refused.exitCode, 1);
    assert.match(refused.stderr ?? "", /not a remediation item/);
    assert.ok(items.list("thr_origin").some((row) => row.id === declared.id));

    // A defect nothing owns still mints its own slice from both plugin seams,
    // and resolving each finding retires the slice it created.
    const dedicated = await host.harness.behavior.runCli([
      "finding", "A dedicated telemetry defect",
      "--file", "src/dedicated.ts:1",
      "--evidence", "Nothing in the plan owns this file.",
      "--fix-files", "src/dedicated.ts",
      "--thread", "thr_origin",
    ]);
    assert.equal(dedicated.exitCode, 0, dedicated.stderr);
    const owned = await host.harness.behavior.runCli([
      "finding", "An auditor-owned telemetry defect",
      "--file", "src/audited.ts:1",
      "--evidence", "Only this finding's own slice may repair it.",
      "--fix-files", "src/audited.ts",
      "--own-slice",
      "--thread", "thr_origin",
    ]);
    assert.equal(owned.exitCode, 0, owned.stderr);

    for (const title of ["A dedicated telemetry defect", "An auditor-owned telemetry defect"]) {
      const finding = findings.list("thr_origin").find((row) => row.title === title)!;
      assert.ok(finding.itemId, `${title} should have minted a slice`);
      assert.equal(items.origin("thr_origin", finding.itemId!), "finding");
    }

    // The auto-minted slice is the one a live worker can protect: a durable
    // claim owns it, so neither the resolution pass nor an explicit removal may
    // delete it from under them. A reservation is how the scheduler holds a
    // slice between claim and spawn, and itemClaimants already counts it.
    const dedicatedFinding = findings.list("thr_origin").find(
      (row) => row.title === "A dedicated telemetry defect",
    )!;
    const dedicatedItemId = dedicatedFinding.itemId!;
    db.prepare(`
      INSERT INTO collab_item_reservations (root_thread_id, item_id, claim_token, created_at, expires_at, slot_limit)
      VALUES ('thr_origin', ?, 'tok_dedicated_worker', ?, ?, 1)
    `).run(dedicatedItemId, Date.now(), Date.now() + 60 * 60 * 1000);

    const resolvedBusy = await host.harness.behavior.runCli([
      "resolve", dedicatedFinding.id, "--as", "not-a-defect",
      "--evidence", "Review found the behaviour is already covered.",
      "--thread", "thr_origin",
    ]);
    assert.equal(resolvedBusy.exitCode, 0, resolvedBusy.stderr);
    assert.doesNotMatch(resolvedBusy.stdout ?? "", /retired its now-orphaned remediation item/);
    assert.ok(items.list("thr_origin").some((row) => row.id === dedicatedItemId));

    const busyRefusal = await host.harness.behavior.runCli([
      "item", dedicatedItemId, "--remove", "--thread", "thr_origin",
    ]);
    assert.equal(busyRefusal.exitCode, 1);
    assert.match(busyRefusal.stderr ?? "", /staffed/);

    db.prepare("DELETE FROM collab_item_reservations WHERE claim_token = 'tok_dedicated_worker'").run();
    const removed = await host.harness.behavior.runCli([
      "item", dedicatedItemId, "--remove", "--thread", "thr_origin",
    ]);
    assert.equal(removed.exitCode, 0, removed.stderr);
    assert.match(removed.stdout ?? "", /Removed/);
    assert.equal(items.list("thr_origin").some((row) => row.id === dedicatedItemId), false);

    // The auditor's own slice needs no worker protection: nothing holds it, so
    // resolving its finding retires it automatically.
    const ownedFinding = findings.list("thr_origin").find(
      (row) => row.title === "An auditor-owned telemetry defect",
    )!;
    const ownedItemId = ownedFinding.itemId!;
    const resolvedOwned = await host.harness.behavior.runCli([
      "resolve", ownedFinding.id, "--as", "not-a-defect",
      "--evidence", "Review found the behaviour is already covered.",
      "--thread", "thr_origin",
    ]);
    assert.equal(resolvedOwned.exitCode, 0, resolvedOwned.stderr);
    assert.match(resolvedOwned.stdout ?? "", /retired its now-orphaned remediation item/);
    assert.equal(items.list("thr_origin").some((row) => row.id === ownedItemId), false);

    // Filing, resolving and retiring each publish/steer through bounded
    // fire-and-forget hooks; let them settle before the fake database is
    // disposed, or a late DB read surfaces as an unhandled rejection.
    for (let settle = 0; settle < 30; settle += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  });
});

describe("durable blocked slices", () => {
  const ROOT = "thr_durable_root";

  // A goal root whose crew exists as real SQLite rows and whose host answers a
  // per-thread status. Heal passes are driven through the awaited lifecycle path
  // production uses — a state read republishes and starts one — never directly.
  function durableHost(options?: {
    rootStatus?: "idle" | "active";
    workerStatus?: (threadId: string) => "idle" | "active";
    maxWorkers?: number;
    lastContinueAt?: number;
  }) {
    const spawned: string[] = [];
    const archived: string[] = [];
    const statusOf = options?.workerStatus ?? (() => "idle" as const);
    let spawnCount = 0;
    const threadResponse = (threadId: string, status: "idle" | "active") =>
      makeThreadResponse({
        id: threadId,
        projectId: "proj",
        providerId: "acp-opencode",
        // Only the root declares an environment: the scheduler validates a
        // base before it will replace a released slice.
        environmentId: threadId === ROOT ? "env_durable" : null,
        parentThreadId: threadId === ROOT ? null : ROOT,
        status,
      });
    const nextThread = () => {
      spawnCount += 1;
      const id = `thr_replacement_${spawnCount}`;
      spawned.push(id);
      return threadResponse(id, "active");
    };
    const host = registeredHost({
      threads: {
        get: async ({ threadId }) =>
          threadResponse(threadId, threadId === ROOT ? options?.rootStatus ?? "idle" : statusOf(threadId)),
        list: () => [],
        spawn: async () => nextThread(),
        fork: async () => nextThread(),
        output: () => ({ output: null }),
        send: () => ({ ok: true }),
        stop: () => ({ ok: true }),
        archive: async ({ threadId }) => {
          archived.push(threadId);
          return { archivedThreadIds: [threadId], ok: true as const };
        },
        update: ({ threadId }) => makeThreadResponse({ id: threadId }),
        timeline: () => ({ rows: [] }),
        interactions: { list: async () => [], resolve: async () => ({}) },
      },
      environments: {
        get: async () => ({
          id: "env_durable",
          hostId: "host_durable",
          path: "/srv/durable",
          branchName: "main",
        }),
      },
    }, () => ({ status: "valid", repository: "/srv/durable", commit: "f".repeat(40) }));
    const db = host.bb.storage.database();
    // progress_update_minutes = 0 turns the heartbeat off, so a root wake can
    // only come from a goal event — the thing the wake case counts.
    db.prepare(
      `UPDATE goals SET thread_id = ?, status = 'active', max_workers = ?, verify_enabled = 0,
         progress_update_minutes = 0, last_continue_at = ?
       WHERE thread_id = 'thr_sentinel'`,
    ).run(ROOT, options?.maxWorkers ?? 4, options?.lastContinueAt ?? Date.now());
    const items = createItemStore(host.bb);
    const settle = async () => {
      for (let index = 0; index < 60; index += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    const agentRow = (threadId: string) =>
      db.prepare(
        "SELECT report_status, report_evidence, nudge_count, retired_at FROM collab_agents WHERE thread_id = ?",
      ).get(threadId) as {
        report_status: string | null;
        report_evidence: string | null;
        nudge_count: number | null;
        retired_at: number | null;
      };
    const itemRow = (itemId: string) => items.list(ROOT).find((row) => row.id === itemId)!;
    const liveOwners = (itemId: string) =>
      (
        db.prepare(
          "SELECT thread_id FROM collab_agents WHERE root_thread_id = ? AND item_id = ? AND retired_at IS NULL",
        ).all(ROOT, itemId) as Array<{ thread_id: string }>
      ).map((row) => row.thread_id);
    const sendsTo = (threadId: string) =>
      host.harness.inspection.sdk.callsTo("threads.send").filter((call) => (call[0] as { threadId?: string }).threadId === threadId);
    const heal = async () => {
      const state = await host.harness.behavior.callAgentTool("ultragoal_state", {}, { threadId: ROOT });
      assert.equal(isToolError(state), false, toolText(state));
      await settle();
    };
    const idle = async (threadId: string, lastAssistantText: string) => {
      const result = await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: threadResponse(threadId, "idle"),
        lastAssistantText,
      });
      await settle();
      return result;
    };
    const spawnWorker = async (itemId: string, slug: string, step: string) => {
      const result = await host.harness.behavior.callAgentTool(
        "ultragoal_spawn_agent",
        { task_name: slug, display_name: `Worker ${slug}`, item_id: itemId, message: `SLICE (item_id=${itemId}): ${step}` },
        { threadId: ROOT },
      );
      assert.equal(isToolError(result), false, toolText(result));
      const row = db
        .prepare("SELECT thread_id FROM collab_agents WHERE root_thread_id = ? AND task_name = ?")
        .get(ROOT, `/root/${slug}`) as { thread_id: string };
      return row.thread_id;
    };
    /** One claimed slice plus the worker that owns it. */
    const slice = async (slug: string, step: string, file: string) => {
      const item = items.add(ROOT, step, "pending", { files: [file] })!;
      return { item, worker: await spawnWorker(item.id, slug, step) };
    };
    const block = async (threadId: string, blocker: string) => {
      const result = await host.harness.behavior.callAgentTool("slice_blocked", { blocker }, { threadId });
      assert.equal(isToolError(result), false, toolText(result));
    };
    return { host, db, items, spawned, archived, settle, heal, idle, slice, spawnWorker, block, agentRow, itemRow, liveOwners, sendsTo };
  }

  it("persists a text-sentinel blocked report exactly as the tool path does", async () => {
    const fx = durableHost();
    // Verification on: the durability of a worker's own block must not depend
    // on whether a verifier is watching it.
    fx.db.prepare("UPDATE goals SET verify_enabled = 1 WHERE thread_id = ?").run(ROOT);
    const sentinel = await fx.slice("sentinel_worker", "Slice blocked through the text sentinel", "src/sentinel.ts");
    const tool = await fx.slice("tool_worker", "Slice blocked through the tool", "src/tool.ts");

    const blocker = "The upstream schema freeze blocks this slice until the owner lifts it.";
    await fx.block(tool.worker, blocker);
    await fx.idle(sentinel.worker, `Cannot proceed.\nULTRAGOAL_BLOCKED: ${blocker}`);

    const sentinelRow = fx.agentRow(sentinel.worker);
    const toolRow = fx.agentRow(tool.worker);
    assert.equal(sentinelRow.report_status, "blocked", "a text sentinel must establish durable blocking state");
    assert.equal(toolRow.report_status, "blocked");
    for (const row of [sentinelRow, toolRow]) {
      const stored = JSON.parse(row.report_evidence ?? "{}") as { version?: number; evidence?: string; finding_evidence?: unknown };
      assert.equal(stored.version, 1, "both paths store the same report record shape");
      assert.equal(JSON.stringify(stored.finding_evidence), "[]");
      assert.match(stored.evidence ?? "", /upstream schema freeze/);
    }
    assert.equal(fx.itemRow(sentinel.item.id).status, "in_progress", "a blocked slice stays owned");
    assert.equal(fx.itemRow(tool.item.id).status, "in_progress");
  });

  it("keeps a running blocked worker's strike count while an unblocked control resets", async () => {
    const fx = durableHost({ workerStatus: () => "active" });
    const blocked = await fx.slice("running_blocked", "Blocked slice with a host that reads running", "src/blocked.ts");
    const control = await fx.slice("running_control", "Ordinary slice with a host that reads running", "src/control.ts");
    await fx.block(blocked.worker, "Blocked while the host still reads this worker as running.");
    fx.db.prepare("UPDATE collab_agents SET nudge_count = 2 WHERE thread_id IN (?, ?)").run(blocked.worker, control.worker);

    await fx.heal();

    assert.equal(fx.agentRow(blocked.worker).nudge_count, 2, "an observed running must not strike-reset a blocked worker");
    assert.equal(fx.agentRow(control.worker).nudge_count, 0, "an observed running still strike-resets ordinary work");
  });

  it("does not nudge or retire a durably blocked idle worker", async () => {
    const fx = durableHost();
    const blocked = await fx.slice("blocked_idle", "Blocked idle slice past the nudge cap", "src/blocked-idle.ts");
    await fx.block(blocked.worker, "Blocked and idle: the operator owns the next move.");
    fx.db.prepare("UPDATE collab_agents SET nudge_count = 3, last_nudge_at = ? WHERE thread_id = ?").run(Date.now() - 16 * 60_000, blocked.worker);
    const spawnsBefore = fx.spawned.length;

    await fx.heal();

    const row = fx.agentRow(blocked.worker);
    assert.equal(row.retired_at, null, "a blocked worker is never retired for being unresponsive");
    assert.equal(row.nudge_count, 3, "a blocked worker is never nudged");
    assert.equal(row.report_status, "blocked");
    assert.equal(fx.itemRow(blocked.item.id).status, "in_progress", "the blocked slice stays with its owner");
    assert.deepEqual(fx.liveOwners(blocked.item.id), [blocked.worker]);
    assert.equal(fx.sendsTo(blocked.worker).length, 0, "no stall nudge reaches a blocked worker");
    assert.equal(fx.spawned.length, spawnsBefore, "no replacement worker is spawned for the held slice");
  });

  it("still nudges and retires ordinary idle workers on schedule", async (t) => {
    const realNow = Date.now();
    t.mock.timers.enable({ apis: ["Date"] });
    t.mock.timers.setTime(realNow);
    const fx = durableHost();
    const stale = await fx.slice("stale_idle", "Ordinary idle slice past the nudge cap", "src/stale.ts");
    const nudge = await fx.slice("nudge_idle", "Ordinary idle slice inside the nudge cap", "src/nudge.ts");
    const finished = await fx.slice("done_worker", "Slice that closes through a done report", "src/done.ts");
    const done = await fx.host.harness.behavior.callAgentTool(
      "slice_done",
      { evidence: "commit deadbee; the slice check passed" },
      { threadId: finished.worker },
    );
    assert.equal(isToolError(done), false, toolText(done));
    await fx.idle(finished.worker, "Worker finished and called slice_done.");
    assert.equal(fx.itemRow(finished.item.id).status, "completed", "ordinary completion still closes the slice");
    fx.db.prepare("UPDATE collab_agents SET nudge_count = 3, last_nudge_at = ? WHERE thread_id = ?").run(realNow - 16 * 60_000, stale.worker);
    fx.db.prepare("UPDATE collab_agents SET nudge_count = 2, last_nudge_at = ? WHERE thread_id = ?").run(realNow - 16 * 60_000, nudge.worker);

    await fx.heal(); // retires the stale and finished rows, seeds the nudge grace window
    assert.notEqual(fx.agentRow(stale.worker).retired_at, null, "ordinary unresponsive workers still retire");
    assert.notEqual(fx.agentRow(finished.worker).retired_at, null, "finished-worker retirement still fires");
    assert.ok(fx.archived.includes(finished.worker), "the retired worker is archived");

    t.mock.timers.setTime(realNow + 181_000);
    await fx.heal(); // the grace window has elapsed

    assert.equal(fx.agentRow(nudge.worker).nudge_count, 3, "ordinary idle workers are still nudged");
    assert.equal(fx.sendsTo(nudge.worker).length, 1, "exactly one stall nudge reaches the ordinary worker");
  });

  it("keeps a blocked slice held, and the healer off it, across a plugin reload", async () => {
    const fx = durableHost();
    const blocked = await fx.slice("reload_blocked", "Blocked slice that must survive a reload", "src/reload.ts");
    await fx.block(blocked.worker, "Blocked before the plugin reloads.");
    fx.db.prepare("UPDATE collab_agents SET nudge_count = 3 WHERE thread_id = ?").run(blocked.worker);
    const spawnsBefore = fx.spawned.length;

    const reloaded = await fx.host.harness.lifecycle.reload(plugin);
    hosts.push(reloaded);
    const state = await reloaded.harness.behavior.callAgentTool("ultragoal_state", {}, { threadId: ROOT });
    assert.equal(isToolError(state), false, toolText(state));
    await fx.settle();

    // The old generation's handle is closed by the reload; read the durable rows
    // through the live one.
    const liveDb = reloaded.bb.storage.database();
    const row = liveDb
      .prepare("SELECT report_status, nudge_count, retired_at FROM collab_agents WHERE thread_id = ?")
      .get(blocked.worker) as { report_status: string | null; nudge_count: number | null; retired_at: number | null };
    assert.equal(row.retired_at, null, "a reload must not retire a durably blocked worker");
    assert.equal(row.nudge_count, 3, "a reload must not strike-reset a blocked worker");
    assert.equal(row.report_status, "blocked");
    const itemStatus = liveDb.prepare("SELECT status FROM goal_items WHERE id = ?").get(blocked.item.id) as { status: string };
    assert.equal(itemStatus.status, "in_progress", "the blocked slice stays held after reload");
    const owners = liveDb
      .prepare("SELECT thread_id FROM collab_agents WHERE root_thread_id = ? AND item_id = ? AND retired_at IS NULL")
      .all(ROOT, blocked.item.id) as Array<{ thread_id: string }>;
    assert.deepEqual(owners.map((owner) => owner.thread_id), [blocked.worker]);
    const liveRows = liveDb.prepare("SELECT COUNT(*) AS n FROM collab_agents WHERE root_thread_id = ? AND retired_at IS NULL").get(ROOT) as { n: number };
    assert.equal(liveRows.n, 1, "only the blocked owner remains live after reload");
    assert.equal(fx.spawned.length, spawnsBefore, "no replacement is staffed for the blocked slice");
  });

  it("wakes the root once per blocking transition", async (t) => {
    const realNow = Date.now();
    t.mock.timers.enable({ apis: ["Date"] });
    t.mock.timers.setTime(realNow);
    const fx = durableHost({ lastContinueAt: realNow - 10_000 });
    const held = await fx.slice("wake_worker", "Blocked slice whose reports must not re-wake the root", "src/wake.ts");
    const rootSends = () => fx.sendsTo(ROOT);

    await fx.block(held.worker, "Blocker one: the schema freeze has not been lifted yet.");
    await fx.idle(held.worker, "Ending the turn after the blocked report.");
    assert.equal(rootSends().length, 1, "the first blocked report wakes the root exactly once");

    // Past the 8s start-in-flight window, so a second wake would really send.
    t.mock.timers.setTime(realNow + 10_000);
    await fx.block(held.worker, "Second wording: the same schema freeze still blocks this slice.");
    await fx.idle(held.worker, "Ending the turn after the repeat blocked report.");
    assert.equal(rootSends().length, 1, "a repeat block with new wording is not a new transition");

    await fx.host.harness.behavior.callAgentTool(
      "slice_done",
      { evidence: "commit deadbee; the blocked slice's check passed before re-blocking" },
      { threadId: held.worker },
    );
    await fx.block(held.worker, "Third: a genuinely new blocking transition after a done report.");
    await fx.idle(held.worker, "Ending the turn after the post-done blocked report.");
    assert.equal(rootSends().length, 2, "a block after a done report wakes the root again");
  });

  it("keeps release and --hold authoritative for a blocked slice", async () => {
    const fx = durableHost();
    const released = await fx.slice("release_blocked", "Blocked slice released back to the queue", "src/release.ts");
    const held = await fx.slice("hold_blocked", "Blocked slice released under a hold", "src/hold.ts");
    await fx.block(released.worker, "Blocked until the operator releases the slice.");
    await fx.block(held.worker, "Blocked until the operator releases it under a hold.");

    // Close the fence first so the release itself is observable: the slice must
    // reach `pending` with no owner before capacity returns.
    const empty = await fx.host.harness.behavior.runCli(["workers", "0", "--thread", ROOT]);
    assert.equal(empty.exitCode, 0, empty.stderr);
    await fx.settle();

    const release = await fx.host.harness.behavior.runCli(["release", released.item.id, "--thread", ROOT]);
    assert.equal(release.exitCode, 0, release.stderr);
    await fx.settle();
    assert.notEqual(fx.agentRow(released.worker).retired_at, null, "release retires the blocked row");
    assert.equal(fx.agentRow(released.worker).report_status, "blocked", "the durable report survives retirement");
    assert.equal(fx.itemRow(released.item.id).status, "pending", "the released slice returns to the queue");
    assert.deepEqual(fx.liveOwners(released.item.id), [], "no live owner remains after release");

    const cap = await fx.host.harness.behavior.runCli(["workers", "2", "--thread", ROOT]);
    assert.equal(cap.exitCode, 0, cap.stderr);
    await fx.settle();
    const replacements = fx.liveOwners(released.item.id);
    assert.equal(replacements.length, 1, "exactly one replacement claimant");
    assert.notEqual(replacements[0], released.worker, "the replacement is a fresh thread, not the blocked owner");
    assert.equal(fx.itemRow(released.item.id).status, "in_progress", "the replacement claimed the slice");

    const hold = await fx.host.harness.behavior.runCli(["release", held.item.id, "--hold", "--thread", ROOT]);
    assert.equal(hold.exitCode, 0, hold.stderr);
    assert.match(hold.stdout ?? "", /held/i);
    await fx.settle();
    assert.notEqual(fx.agentRow(held.worker).retired_at, null, "--hold still retires the blocked row");
    assert.equal(fx.itemRow(held.item.id).status, "pending", "a held slice waits in the queue");
    const kick = await fx.host.harness.behavior.runCli(["workers", "2", "--thread", ROOT]);
    assert.equal(kick.exitCode, 0, kick.stderr);
    await fx.settle();
    assert.deepEqual(fx.liveOwners(held.item.id), [], "a scheduler kick must not lift the hold");
    const unhold = await fx.host.harness.behavior.runCli(["item", held.item.id, "--unhold", "--thread", ROOT]);
    assert.equal(unhold.exitCode, 0, unhold.stderr);
    await fx.settle();
    assert.equal(fx.liveOwners(held.item.id).length, 1, "lifting the hold staffs exactly one replacement");
    assert.equal(fx.itemRow(held.item.id).status, "in_progress");
  });

  it("keeps the verifier path authoritative and never stamps the source worker", async () => {
    const fx = durableHost();
    fx.db.prepare("UPDATE goals SET verify_enabled = 1 WHERE thread_id = ?").run(ROOT);
    const judged = await fx.slice("verified_worker", "Slice judged by an independent verifier", "src/verified.ts");
    const seedVerifier = (threadId: string) =>
      fx.db.prepare(`
        INSERT INTO collab_agents (
          thread_id, root_thread_id, parent_thread_id, task_name, created_at,
          display_name, item_id, role, source_thread_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'verifier', ?)
      `).run(threadId, ROOT, ROOT, `/root/${threadId}`, Date.now(), threadId, judged.item.id, judged.worker);
    seedVerifier("thr_verifier_one");

    await fx.idle("thr_verifier_one", "ULTRAGOAL_BLOCKED\nVERIFY_FAIL: the work is not finished");
    assert.equal(fx.agentRow(judged.worker).report_status, null, "the verifier path never stamps the source worker");
    assert.equal(fx.itemRow(judged.item.id).status, "in_progress");

    seedVerifier("thr_verifier_two");
    await fx.idle("thr_verifier_two", "VERIFY_PASS: the work checks out");
    assert.equal(fx.itemRow(judged.item.id).status, "completed", "a passing verifier still closes the slice");
  });
});
