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

function registeredHost(sdk?: CreateFakePluginHostOptions["sdk"]) {
  const host = createFakePluginHost({
    pluginId: `ultragoal-tools-${hosts.length}`,
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

function registeredTools() {
  const host = registeredHost();
  return new Map(
    host.harness.inspection.registrations.agentTools.map((tool) => [tool.name, tool]),
  );
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

  const context = (providerId: string, threadId: string) => ({
    thread: { id: threadId, title: "UltraGoal root", parentThreadId: null, sourceThreadId: null },
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

  it("pins the decision id request_decision returns in ultragoal_state", async () => {
    const host = registeredHost();
    const threadId = "thr_decision_contract";
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

    const state = await host.harness.behavior.callAgentTool("ultragoal_state", {}, { threadId });
    assert.equal(isToolError(state), false);
    const openDecisions = (JSON.parse(toolText(state)) as {
      goal: { openDecisions: Array<{ decision_id: string }> };
    }).goal.openDecisions.map((decision) => decision.decision_id);
    assert.ok(
      openDecisions.includes(decisionId),
      `ultragoal_state must project the decision request_decision returned: ${decisionId}`,
    );
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
          environmentId: null,
          status: "idle",
        }),
        list: () => [],
        spawn: () => {
          spawnCalls += 1;
          throw new Error("forced external spawn failure");
        },
        update: ({ threadId }) => makeThreadResponse({ id: threadId }),
      },
    });
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
          environmentId: null,
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
    });
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
        spawn: (args) =>
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
