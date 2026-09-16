import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import { COLLAB_TOOL_NAMES, createCollabStore } from "./collab.ts";

const hosts: FakePluginHost[] = [];
/** Throwaway checkout trees, so a warning test never leaves bytes behind. */
const trees: string[] = [];

afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()!.harness.lifecycle.dispose();
  while (trees.length > 0) await rm(trees.pop()!, { recursive: true, force: true });
});

function collabHost(options?: {
  discovered?: ReturnType<typeof makeThreadResponse>[];
  prompts?: Record<string, string>;
  /** Branch checked out by the root's environment, i.e. where slices land. */
  rootBranch?: string;
  /** Root environment that exists but names no branch at all. */
  rootEnvWithoutBranch?: boolean;
  /** Root environment on-disk path: the tree a worker would be cut from. */
  rootEnvPath?: string;
}) {
  const stopped: string[] = [];
  const prompts: string[] = [];
  const spawnArgsSeen: unknown[] = [];
  const queued: unknown[] = [];
  const sent: Array<{ threadId?: string; mode?: string }> = [];
  let spawnCalls = 0;
  const host = createFakePluginHost({
    pluginId: `collab-strict-${hosts.length}`,
    sdk: {
      threads: {
        get: ({ threadId }) =>
          options?.discovered?.find((thread) => thread.id === threadId) ??
          makeThreadResponse({
            id: threadId,
            projectId: "proj",
            providerId: "acp-opencode",
            environmentId:
              (options?.rootBranch || options?.rootEnvWithoutBranch) && threadId === "thr_root"
                ? "env_root"
                : null,
            status: threadId === "thr_root" ? "idle" : "active",
          }),
        list: () => options?.discovered ?? [],
        timeline: ({ threadId }) => ({
          rows: options?.prompts?.[threadId]
            ? [{ kind: "conversation", role: "user", text: options.prompts[threadId] }]
            : [],
        }),
        spawn: (args) => {
          spawnCalls += 1;
          prompts.push(args.prompt ?? "");
          spawnArgsSeen.push(args);
          return makeThreadResponse({
            // A real spawn mints a fresh thread id every time; keep the first
            // one stable (triggers key on it) and make the rest unique, so a
            // test that staffs the same root twice is not fighting the
            // collab_agents primary key.
            id: spawnCalls === 1 ? "thr_spawned" : `thr_spawned_${spawnCalls}`,
            parentThreadId: "thr_root",
            projectId: "proj",
            providerId: "acp-opencode",
            environmentId: null,
            status: "active",
          });
        },
        send: (args) => {
          sent.push({ threadId: args.threadId, mode: args.mode });
          return { ok: true };
        },
        queuedMessages: {
          create: (args: unknown) => {
            queued.push(args);
            return { id: "qmsg_test" };
          },
        },
        stop: ({ threadId }) => {
          stopped.push(threadId);
          return { ok: true };
        },
        update: ({ threadId }) => makeThreadResponse({ id: threadId }),
      },
      environments: {
        // Shaped from the live record for an UltraGoal root on omegacode
        // (env_2j2yd334px): branch_name=integration, merge_base_branch=NULL,
        // default_branch=main. mergeBaseBranch is deliberately absent.
        get: async () => ({
          id: "env_root",
          hostId: "host_1",
          branchName: options?.rootBranch ?? null,
          mergeBaseBranch: null,
          defaultBranch: "main",
          path: options?.rootEnvPath ?? null,
        }),
      } as never,
    },
  });
  hosts.push(host);
  host.bb.storage.database().exec(`
    CREATE TABLE collab_agents (
      thread_id TEXT PRIMARY KEY,
      root_thread_id TEXT NOT NULL,
      parent_thread_id TEXT,
      task_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      display_name TEXT,
      item_id TEXT,
      role TEXT,
      source_thread_id TEXT,
      last_verify_hash TEXT,
      retired_at INTEGER,
      verify_fails INTEGER,
      last_nudge_at INTEGER,
      nudge_count INTEGER,
      report_status TEXT,
      report_evidence TEXT,
      report_item_id TEXT
    );
    CREATE TABLE collab_item_reservations (
      root_thread_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      claim_token TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      slot_limit INTEGER NOT NULL,
      PRIMARY KEY (root_thread_id, item_id)
    );
    CREATE TABLE collab_root_worker_caps (
      root_thread_id TEXT PRIMARY KEY,
      max_workers INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TRIGGER collab_agents_root_capacity_insert
      BEFORE INSERT ON collab_agents
      WHEN NEW.retired_at IS NULL
        AND COALESCE(NEW.role, 'worker') != 'verifier'
        AND EXISTS (
          SELECT 1 FROM collab_root_worker_caps WHERE root_thread_id = NEW.root_thread_id
        )
        AND (
          (SELECT COUNT(*) FROM collab_agents
           WHERE root_thread_id = NEW.root_thread_id
             AND retired_at IS NULL
             AND COALESCE(role, 'worker') != 'verifier')
          +
          (SELECT COUNT(*) FROM collab_item_reservations
           WHERE root_thread_id = NEW.root_thread_id
             AND expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
             AND (NEW.item_id IS NULL OR item_id != NEW.item_id))
        ) >= (SELECT max_workers FROM collab_root_worker_caps
              WHERE root_thread_id = NEW.root_thread_id)
      BEGIN
        SELECT RAISE(ABORT, 'root worker capacity is full');
      END;
  `);
  return {
    host,
    stopped,
    prompts,
    queued,
    sent,
    spawnCalls: () => spawnCalls,
    spawnArgs: () => spawnArgsSeen,
  };
}

describe("scheduler-strict collaboration spawns", () => {
  it("fails closed before claim fallback when the requested item already has a worker", async () => {
    const state = collabHost();
    state.host.bb.storage.database().prepare(`
      INSERT INTO collab_agents (
        thread_id, root_thread_id, parent_thread_id, task_name, created_at,
        display_name, item_id, role
      ) VALUES ('thr_existing', 'thr_root', 'thr_root', '/root/existing', 1,
        'Existing worker', 'itm_held', 'worker')
    `).run();
    let claimCalls = 0;
    const collab = createCollabStore(state.host.bb, {
      claimItem: (_root, args) => {
        claimCalls += 1;
        return args.createIfMissing === false ? null : "itm_duplicate";
      },
    });

    const result = await collab.spawnWorker({
      parentThreadId: "thr_root",
      itemId: "itm_held",
      maxWorkers: 1,
      displayName: "Strict Scheduler",
      message: "SLICE (item_id=itm_held): repair the held work",
    });
    assert.ok("error" in result);
    assert.match(result.error, /already has a durable worker/);
    assert.equal(claimCalls, 0);
    assert.equal(state.spawnCalls(), 0);
    assert.equal(
      (state.host.bb.storage.database().prepare(
        "SELECT COUNT(*) AS n FROM collab_agents WHERE retired_at IS NULL",
      ).get() as { n: number }).n,
      1,
    );
  });

  it("retires and stops a spawned worker whose durable item differs from the request", async () => {
    const state = collabHost();
    state.host.bb.storage.database().exec(`
      CREATE TRIGGER rewrite_scheduler_item
      AFTER INSERT ON collab_agents
      WHEN NEW.thread_id = 'thr_spawned'
      BEGIN
        UPDATE collab_agents SET item_id = 'itm_wrong' WHERE thread_id = NEW.thread_id;
      END;
    `);
    const collab = createCollabStore(state.host.bb, {
      claimItem: (_root, args) => args.itemId,
    });

    const result = await collab.spawnWorker({
      parentThreadId: "thr_root",
      itemId: "itm_intended",
      maxWorkers: 1,
      displayName: "Claim Inspector",
      message: "SLICE (item_id=itm_intended): inspect the durable claim",
    });
    assert.ok("error" in result);
    assert.match(result.error, /did not retain scheduler item/);
    assert.equal(state.spawnCalls(), 1);
    assert.deepEqual(state.stopped, ["thr_spawned"]);
    const row = state.host.bb.storage.database().prepare(
      "SELECT item_id, retired_at FROM collab_agents WHERE thread_id = 'thr_spawned'",
    ).get() as { item_id: string | null; retired_at: number | null };
    assert.equal(row.item_id, null);
    assert.ok(row.retired_at);
  });

  it("does not convert a null strict claim back into the requested item", async () => {
    const state = collabHost();
    const collab = createCollabStore(state.host.bb, {
      claimItem: () => null,
    });

    const result = await collab.spawnWorker({
      parentThreadId: "thr_root",
      itemId: "itm_unclaimable",
      maxWorkers: 1,
      displayName: "Claim Refuser",
      message: "SLICE (item_id=itm_unclaimable): do not spawn without a claim",
    });
    assert.ok("error" in result);
    assert.match(result.error, /resolved to no item/);
    assert.equal(state.spawnCalls(), 0);
    assert.equal(
      (state.host.bb.storage.database().prepare(
        "SELECT COUNT(*) AS n FROM collab_item_reservations",
      ).get() as { n: number }).n,
      0,
      "failed claims must release the pre-spawn reservation",
    );
  });

  it("injects scope and defect evidence without promoting agent-authored checks", async () => {
    const state = collabHost();
    const collab = createCollabStore(state.host.bb, {
      itemBrief: () => ({
        files: ["src/domain.ts"],
        linkedDefects: "LINKED DEFECTS: fnd_public_verifier — untrusted evidence only",
      }),
    });
    collab.registerTools();

    const result = await state.host.harness.behavior.callAgentTool(
      "ultragoal_spawn_agent",
      {
        task_name: "verify_domain",
        item_id: "itm_domain",
        role: "verifier",
        message: "Verify the domain repair",
        fork_turns: "none",
      },
      { threadId: "thr_root", projectId: "proj" },
    );
    assert.equal(
      typeof result === "object" && result !== null && "isError" in result
        ? (result as { isError?: boolean }).isError
        : false,
      false,
    );
    assert.equal(state.prompts.length, 1);
    assert.match(state.prompts[0]!, /src\/domain\.ts/);
    assert.doesNotMatch(state.prompts[0]!, /npm test -- domain/);
    assert.match(state.prompts[0]!, /fnd_public_verifier/);
    assert.match(state.prompts[0]!, /DEFECT_COVERAGE/);
  });

  it("refuses to staff a slice whose finding was filed from another repository", async () => {
    // The staffing path cuts the worker worktree from the GOAL's project. A
    // finding filed from a different repository names a file that checkout has
    // never contained, so the worker's only exits were slice_blocked or
    // creating the file in the wrong repository and reporting done. Observed: a
    // slice scoped to server.ts handed a worktree of a repo with no
    // server.ts. Guarding the refusal, not the prompt wording.
    const state = collabHost({
      discovered: [
        makeThreadResponse({
          id: "thr_root",
          projectId: "proj_omegacode",
          providerId: "acp-opencode",
          environmentId: null,
          status: "idle",
        }),
      ],
    });
    const collab = createCollabStore(state.host.bb, {
      claimItem: (_root, request) => request.itemId ?? null,
      itemBrief: () => ({
        files: ["lib/collab.ts"],
        linkedDefects: "LINKED DEFECTS: fnd_cross_repo",
        findingProjectIds: ["proj_ultragoal"],
      }),
    });
    collab.registerTools();

    const result = await state.host.harness.behavior.callAgentTool(
      "ultragoal_spawn_agent",
      {
        task_name: "fix_collab",
        item_id: "itm_cross_repo",
        message: "SLICE (item_id=itm_cross_repo): fix the staffing path",
        fork_turns: "none",
      },
      { threadId: "thr_root", projectId: "proj_omegacode" },
    );

    assert.equal(
      (result as { isError?: boolean }).isError,
      true,
      JSON.stringify(result),
    );
    const refusal = JSON.stringify(result);
    assert.match(refusal, /proj_ultragoal/, "the refusal must name the project that owns the fix");
    assert.match(refusal, /proj_omegacode/, "and the project this goal actually cuts from");
    assert.equal(
      state.spawnCalls(),
      0,
      "a worker must never receive a checkout that cannot contain its scoped files",
    );
  });

  it("still staffs a finding filed from the project this goal cuts from", async () => {
    // Positive control: a refusal that fired on every finding-derived slice
    // would pass the test above and take all remediation staffing down with it.
    // Recorded provenance that MATCHES must stay a normal spawn.
    const state = collabHost();
    const collab = createCollabStore(state.host.bb, {
      claimItem: (_root, request) => request.itemId ?? null,
      itemBrief: () => ({
        files: ["lib/collab.ts"],
        linkedDefects: "LINKED DEFECTS: fnd_same_repo",
        findingProjectIds: ["proj"],
      }),
    });
    collab.registerTools();

    const result = await state.host.harness.behavior.callAgentTool(
      "ultragoal_spawn_agent",
      {
        task_name: "fix_local",
        item_id: "itm_same_repo",
        message: "SLICE (item_id=itm_same_repo): fix it here",
        fork_turns: "none",
      },
      { threadId: "thr_root", projectId: "proj" },
    );
    assert.equal(
      (result as { isError?: boolean }).isError ?? false,
      false,
      JSON.stringify(result),
    );
    assert.equal(state.spawnCalls(), 1);
  });

  it("staffs findings recorded before project provenance existed", async () => {
    // Second positive control. Every finding filed before the column existed
    // carries no project, and 170 live rows are in exactly that state. Absent
    // provenance is not a mismatch: reading it as one would refuse the entire
    // existing remediation backlog.
    const state = collabHost();
    const collab = createCollabStore(state.host.bb, {
      claimItem: (_root, request) => request.itemId ?? null,
      itemBrief: () => ({
        files: ["server.ts"],
        linkedDefects: "LINKED DEFECTS: fnd_legacy",
      }),
    });
    collab.registerTools();

    const result = await state.host.harness.behavior.callAgentTool(
      "ultragoal_spawn_agent",
      {
        task_name: "fix_legacy",
        item_id: "itm_legacy",
        message: "SLICE (item_id=itm_legacy): legacy finding, no provenance",
        fork_turns: "none",
      },
      { threadId: "thr_root", projectId: "proj" },
    );
    assert.equal(
      (result as { isError?: boolean }).isError ?? false,
      false,
      JSON.stringify(result),
    );
    assert.equal(state.spawnCalls(), 1);
  });

  it("warns but still staffs when a declared path is absent from the tree being cut", async () => {
    // The in-plan instance, reproduced: a row declared
    // `test/import-closure.test.ts`, which does not exist, while the real file
    // is `test/host-only/import-closure.test.ts`. Existence cannot be a gate —
    // 68 of 170 live findings name a path absent from their base branch and
    // only 8 are cross-repository, so refusing on absence would refuse sixty
    // correct stale-base slices to catch eight. It is still worth saying out
    // loud before the worker spends a turn finding out, and worth NOT saying
    // for the paths that do resolve.
    const tree = await mkdtemp(join(tmpdir(), "ug-staffed-tree-"));
    trees.push(tree);
    await mkdir(join(tree, "test", "host-only"), { recursive: true });
    await writeFile(join(tree, "test", "host-only", "import-closure.test.ts"), "// present\n");

    const state = collabHost({ rootBranch: "integration", rootEnvPath: tree });
    const collab = createCollabStore(state.host.bb, {
      claimItem: (_root, request) => request.itemId ?? null,
      itemBrief: () => ({
        files: ["test/import-closure.test.ts", "test/host-only/import-closure.test.ts"],
        linkedDefects: "LINKED DEFECTS: fnd_wrong_path",
      }),
    });
    collab.registerTools();

    const result = await state.host.harness.behavior.callAgentTool(
      "ultragoal_spawn_agent",
      {
        task_name: "fix_import_closure",
        item_id: "itm_wrong_path",
        message: "SLICE (item_id=itm_wrong_path): fix the closure test",
        fork_turns: "none",
      },
      { threadId: "thr_root", projectId: "proj" },
    );
    assert.equal(
      (result as { isError?: boolean }).isError ?? false,
      false,
      `a warning must not refuse the slice: ${JSON.stringify(result)}`,
    );
    assert.equal(state.spawnCalls(), 1, "the worker is staffed anyway");

    const warning = state.host.harness.inspection.logEntries.find(
      (entry) => entry.level === "warn" && entry.message.includes("declared path(s) absent"),
    );
    assert.ok(warning, JSON.stringify(state.host.harness.inspection.logEntries));
    assert.match(warning.message, /test\/import-closure\.test\.ts/);
    assert.match(warning.message, new RegExp(tree));
    assert.doesNotMatch(
      warning.message,
      /host-only/,
      "a declared path that resolves must not be reported as missing",
    );
  });

  it("staffs a mixed provenance list when one recorded project is the goal's own", async () => {
    // The field is a LIST because coalescing can link findings filed from
    // different threads, so the two candidate rules are not equivalent: "staff
    // when ANY recorded project matches" versus "refuse when ANY mismatches".
    // This is the former — a goal serving its own project keeps working even
    // when a sibling linked finding came from elsewhere — and it is pinned here
    // because an over-broad refusal (refuse on any foreign id) satisfies the
    // refusal test above and would stop legitimate multi-finding remediation.
    //
    // An explicitly EMPTY list is pinned in the same test: "recorded, but no
    // project" proves no mismatch either, exactly like the omitted field the
    // legacy control covers.
    const state = collabHost();
    const collab = createCollabStore(state.host.bb, {
      claimItem: (_root, request) => request.itemId ?? null,
      itemBrief: (_root, itemId) =>
        itemId === "itm_empty"
          ? { files: ["lib/collab.ts"], linkedDefects: "LINKED DEFECTS: fnd_unknown", findingProjectIds: [] }
          : {
              files: ["lib/collab.ts"],
              linkedDefects: "LINKED DEFECTS: fnd_here, fnd_elsewhere",
              findingProjectIds: ["proj", "proj_ultragoal"],
            },
    });
    collab.registerTools();

    const mixed = await state.host.harness.behavior.callAgentTool(
      "ultragoal_spawn_agent",
      {
        task_name: "fix_mixed",
        item_id: "itm_mixed",
        message: "SLICE (item_id=itm_mixed): one finding is mine",
        fork_turns: "none",
      },
      { threadId: "thr_root", projectId: "proj" },
    );
    const empty = await state.host.harness.behavior.callAgentTool(
      "ultragoal_spawn_agent",
      {
        task_name: "fix_empty",
        item_id: "itm_empty",
        message: "SLICE (item_id=itm_empty): provenance recorded empty",
        fork_turns: "none",
      },
      { threadId: "thr_root", projectId: "proj" },
    );
    assert.equal(
      (mixed as { isError?: boolean }).isError ?? false,
      false,
      JSON.stringify(mixed),
    );
    assert.equal(
      (empty as { isError?: boolean }).isError ?? false,
      false,
      JSON.stringify(empty),
    );
    assert.equal(state.spawnCalls(), 2);
  });

  it("refuses nothing when the goal's own project cannot be determined", async () => {
    // Fail closed on proven MISMATCH, never on missing data. The scheduler's
    // own staffing path passes no project of its own (spawnWorker → projectId:
    // undefined), so a root thread that names no project leaves nothing to
    // compare against: the guard stays silent rather than refusing a slice it
    // has no evidence about.
    const state = collabHost({
      discovered: [
        makeThreadResponse({
          id: "thr_root",
          // The fake host names a project for every thread unless told
          // otherwise, and an EMPTY one is how "no cut project to compare
          // against" is expressed here.
          projectId: "",
          providerId: "acp-opencode",
          environmentId: null,
          status: "idle",
        }),
      ],
    });
    let briefLookups = 0;
    const collab = createCollabStore(state.host.bb, {
      claimItem: (_root, request) => request.itemId ?? null,
      itemBrief: () => {
        briefLookups += 1;
        return {
          files: ["lib/collab.ts"],
          linkedDefects: "LINKED DEFECTS: fnd_cross_repo",
          findingProjectIds: ["proj_ultragoal"],
        };
      },
    });

    const result = await collab.spawnWorker({
      parentThreadId: "thr_root",
      itemId: "itm_unknown",
      displayName: "Unknown Project",
      message: "SLICE (item_id=itm_unknown): no cut project recorded",
      maxWorkers: 1,
    });
    assert.ok("threadId" in result, JSON.stringify(result));
    // Proves the guard RAN and stayed silent, rather than never being reached:
    // without this, an implementation that skipped the provenance lookup on the
    // scheduler path would pass the assertion above unchanged.
    assert.equal(briefLookups, 1, "the brief — and so the provenance — was consulted");
    assert.equal(state.spawnCalls(), 1);
  });

  it("names the root environment's branch in the worker brief, not a hardcoded main", async () => {
    // The rebase target used to be the literal `main` in the brief template.
    // Here `main` is the upstream tracker and `integration` is the base — a
    // worker told to rebase onto `main` corrupts its candidate with unrelated
    // history, and the corruption only surfaces at merge time.
    const state = collabHost({ rootBranch: "integration" });
    const collab = createCollabStore(state.host.bb, {
      claimItem: () => "itm_plumbing",
    });
    collab.registerTools();

    await state.host.harness.behavior.callAgentTool(
      "ultragoal_spawn_agent",
      {
        task_name: "fix_plumbing",
        item_id: "itm_plumbing",
        message: "SLICE (item_id=itm_plumbing): repair the brief",
        fork_turns: "none",
      },
      { threadId: "thr_root", projectId: "proj" },
    );
    assert.equal(state.prompts.length, 1);
    assert.match(state.prompts[0]!, /`integration`/);
    assert.doesNotMatch(state.prompts[0]!, /rebase onto `main`/);
    // The rules that three workers never received, now carried by the prompt.
    assert.match(state.prompts[0]!, /\/proc\/loadavg/);
    assert.match(state.prompts[0]!, /not evidence/i);
    // And what makes a command qualified travels with them. Without this the
    // spawned brief still defers to a repo doc that pins an unqualified
    // command, which is how the rule handed the violation back as a receipt.
    assert.match(state.prompts[0]!, /however authoritative/i);
  });

  it("cuts a worker from the root's branch even when the root names no merge base", async () => {
    // Regression guard against "harmonizing" this with integrateWorker's
    // mergeBaseBranch-first order. The live root environment measures
    // branch_name=integration, merge_base_branch=NULL, default_branch=main, so
    // reading mergeBaseBranch first resolves to null and puts every worker on
    // the project default — `main`, the passive upstream tracker at 748d686.
    const state = collabHost({ rootBranch: "integration" });
    const collab = createCollabStore(state.host.bb, { claimItem: () => "itm_base" });
    collab.registerTools();

    await state.host.harness.behavior.callAgentTool(
      "ultragoal_spawn_agent",
      {
        task_name: "cut_from_base",
        item_id: "itm_base",
        message: "SLICE (item_id=itm_base): build on integrated work",
        fork_turns: "none",
      },
      { threadId: "thr_root", projectId: "proj" },
    );
    const spawn = state.spawnArgs()[0] as {
      environment?: { workspace?: { baseBranch?: { kind?: string; name?: string } } };
    };
    assert.equal(spawn?.environment?.workspace?.baseBranch?.kind, "named");
    assert.equal(spawn?.environment?.workspace?.baseBranch?.name, "integration");
  });

  it("refuses to staff a slice when a root environment names no branch", async () => {
    // The plumbing must fail closed the same way the brief now tells the worker
    // to. `{ kind: "default" }` here yields a worktree with
    // merge_base_branch=NULL, and integrateWorker then falls through to
    // default_branch and squash-merges the slice into the upstream tracker.
    const state = collabHost({ rootEnvWithoutBranch: true });
    const collab = createCollabStore(state.host.bb, { claimItem: () => "itm_nobase" });
    collab.registerTools();

    const result = await state.host.harness.behavior.callAgentTool(
      "ultragoal_spawn_agent",
      {
        task_name: "no_base",
        item_id: "itm_nobase",
        message: "SLICE (item_id=itm_nobase): work with nowhere to land",
        fork_turns: "none",
      },
      { threadId: "thr_root", projectId: "proj" },
    );
    assert.match(JSON.stringify(result), /names no integration branch/);
    assert.equal(state.spawnCalls(), 0);
  });

  it("keeps structured item evidence available after the reporting row retires", () => {
    const state = collabHost();
    state.host.bb.storage.database().prepare(`
      INSERT INTO collab_agents (
        thread_id, root_thread_id, parent_thread_id, task_name, created_at,
        display_name, item_id, role
      ) VALUES ('thr_reporter', 'thr_root', 'thr_root', '/root/reporter', 1,
        'Evidence Keeper', 'itm_proven', 'worker')
    `).run();
    const collab = createCollabStore(state.host.bb);
    assert.equal(
      collab.setReport("thr_reporter", "done", "commit abc; test passed", [
        { findingId: "fnd_retired", proof: "regression test passed" },
      ]),
      true,
    );
    collab.forget("thr_reporter");

    assert.deepEqual(collab.findingEvidenceForItem("thr_root", "itm_proven"), [
      { findingId: "fnd_retired", proof: "regression test passed" },
    ]);
    const row = state.host.bb.storage.database().prepare(
      "SELECT item_id, report_item_id, retired_at FROM collab_agents WHERE thread_id='thr_reporter'",
    ).get() as { item_id: string | null; report_item_id: string | null; retired_at: number | null };
    assert.equal(row.item_id, null);
    assert.equal(row.report_item_id, "itm_proven");
    assert.ok(row.retired_at);
  });

  it("tombstones and stops a capacity-rejected discovered legacy child", async () => {
    const legacyChild = makeThreadResponse({
      id: "thr_legacy_b",
      parentThreadId: "thr_root",
      projectId: "proj",
      providerId: "acp-opencode",
      environmentId: null,
      status: "active",
      title: "Late legacy worker",
    });
    const state = collabHost({
      discovered: [legacyChild],
      prompts: { thr_legacy_b: "SLICE (item_id=itm_b): late old-generation work" },
    });
    const db = state.host.bb.storage.database();
    db.prepare(`
      INSERT INTO collab_root_worker_caps (root_thread_id, max_workers, updated_at)
      VALUES ('thr_root', 1, 1)
    `).run();
    db.prepare(`
      INSERT INTO collab_agents (
        thread_id, root_thread_id, parent_thread_id, task_name, created_at,
        display_name, item_id, role
      ) VALUES ('thr_a', 'thr_root', 'thr_root', '/root/a', 1,
        'Worker A', 'itm_a', 'worker')
    `).run();
    const rejected: Array<{ threadId: string; itemId: string | null }> = [];
    const collab = createCollabStore(state.host.bb, {
      onRejectedChild: (_root, threadId, itemId) => rejected.push({ threadId, itemId }),
    });

    const listed = await collab.listForRoot("thr_root", { discover: true, refreshLimit: 8 });
    assert.deepEqual(listed.map((agent) => agent.threadId), ["thr_a"]);
    assert.deepEqual(state.stopped, ["thr_legacy_b"]);
    assert.deepEqual(rejected, [{ threadId: "thr_legacy_b", itemId: "itm_b" }]);
    const tombstone = db.prepare(`
      SELECT item_id, retired_at FROM collab_agents WHERE thread_id='thr_legacy_b'
    `).get() as { item_id: string | null; retired_at: number };
    assert.equal(tombstone.item_id, null);
    assert.ok(tombstone.retired_at > 0);

    await collab.listForRoot("thr_root", { discover: true, refreshLimit: 8 });
    assert.deepEqual(state.stopped, ["thr_legacy_b"], "the tombstone prevents repeated adoption");
  });

  it("answers a capacity-fenced spawn with the error union and stops the child it already made", async () => {
    // The bundle-only hand patch guarded exactly this; a rebuild from source
    // dropped it. The child thread exists the moment spawn() returns, and the
    // durable insert is the only step the capacity fence can refuse — so the
    // ABORT used to escape spawnWorker, handing the caller a rejection while
    // the child kept running with no row: invisible to the fence, unretirable
    // by discovery, and one more stranded per retry of the same path. The
    // non-reservation insert is the reachable one (the scheduler path's
    // `commit` re-checks occupancy against the same trigger).
    const state = collabHost();
    const db = state.host.bb.storage.database();
    db.prepare(`
      INSERT INTO collab_root_worker_caps (root_thread_id, max_workers, updated_at)
      VALUES ('thr_root', 1, 1)
    `).run();
    db.prepare(`
      INSERT INTO collab_agents (
        thread_id, root_thread_id, parent_thread_id, task_name, created_at,
        display_name, item_id, role
      ) VALUES ('thr_holding', 'thr_root', 'thr_root', '/root/holding', 1,
        'Capacity Holder', 'itm_holding', 'worker')
    `).run();
    const collab = createCollabStore(state.host.bb);

    const result = await collab.spawnWorker({
      parentThreadId: "thr_root",
      itemId: null,
      skipClaim: true,
      maxWorkers: 1,
      displayName: "Capacity Refuser",
      message: "SLICE: an unclaimed spawn at a full root",
    });

    assert.ok(
      "error" in result,
      `a full root must answer the union, not reject: ${JSON.stringify(result)}`,
    );
    assert.match(result.error, /root worker capacity is full/i);
    assert.equal(state.spawnCalls(), 1, "the child existed before persistence ran");
    assert.deepEqual(state.stopped, ["thr_spawned"], "the orphaned child must be stopped");
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS n FROM collab_agents WHERE retired_at IS NULL").get() as { n: number }).n,
      1,
      "the capacity-fenced row must not be persisted",
    );
  });

  it("guards the registered spawn tool too, not just the scheduler wrapper", async () => {
    // ultragoal_spawn_agent calls spawnAgent directly, so a guard living in
    // spawnWorker would pass the test above and leave the orchestrator's own
    // path stranding children. Pin the shared entry point.
    const state = collabHost();
    const db = state.host.bb.storage.database();
    db.prepare(`
      INSERT INTO collab_root_worker_caps (root_thread_id, max_workers, updated_at)
      VALUES ('thr_root', 1, 1)
    `).run();
    db.prepare(`
      INSERT INTO collab_agents (
        thread_id, root_thread_id, parent_thread_id, task_name, created_at,
        display_name, item_id, role
      ) VALUES ('thr_holding', 'thr_root', 'thr_root', '/root/holding', 1,
        'Capacity Holder', 'itm_holding', 'worker')
    `).run();
    const collab = createCollabStore(state.host.bb);
    collab.registerTools();

    const result = await state.host.harness.behavior.callAgentTool(
      "ultragoal_spawn_agent",
      {
        task_name: "tool_capacity_refuser",
        item_id: "itm_tool",
        message: "SLICE (item_id=itm_tool): spawn into a full root from the tool",
        fork_turns: "none",
      },
      { threadId: "thr_root", projectId: "proj" },
    );

    assert.equal((result as { isError?: boolean }).isError, true, JSON.stringify(result));
    assert.match(JSON.stringify(result), /root worker capacity is full/i);
    assert.deepEqual(state.stopped, ["thr_spawned"], "the tool's orphaned child must be stopped");
  });

  it("releases the reservation and stops the child when a refused scheduler spawn cannot persist", async () => {
    // The RESERVED path: spawnWorker acquires a token before bb is asked for a
    // child, and the commit's own re-check refuses a spawn whose item gained a
    // durable worker after acquisition. Two guards that already live in
    // lib/collab.ts spawnAgent keep that refusal from burning the reservation —
    // the `!reservationCommitted` branch stops the child bb already made, and
    // the `finally` releases the token. Neither guard is added by this test;
    // this is the regression pin that ties them to the invariant "a refused
    // admission never consumes a reservation".
    //
    // The competing fact has to land in itemBrief: that hook runs after the
    // pre-spawn itemHasWorker guard and before threads.spawn, i.e. inside the
    // window the reservation covers, so the commit's under-lock re-check is the
    // guard that refuses. Landed in claimItem instead, the pre-spawn guard
    // answers first and the refusal under test is never reached.
    const state = collabHost();
    const db = state.host.bb.storage.database();
    let armed = false;
    const collab = createCollabStore(state.host.bb, {
      claimItem: (_root, args) => args.itemId,
      itemBrief: () => {
        if (!armed) {
          armed = true;
          // Exactly the race commit's re-check describes: an old generation
          // finishes a prior spawn for the same item and wins it first.
          db.prepare(`
            INSERT INTO collab_agents (
              thread_id, root_thread_id, parent_thread_id, task_name, created_at,
              display_name, item_id, role
            ) VALUES ('thr_legacy', 'thr_root', 'thr_root', '/root/legacy', 1,
              'Legacy Owner', 'itm_race', 'worker')
          `).run();
        }
        return null;
      },
    });

    const result = await collab.spawnWorker({
      parentThreadId: "thr_root",
      itemId: "itm_race",
      maxWorkers: 2,
      displayName: "Refused Scheduler",
      message: "SLICE (item_id=itm_race): a row that landed first wins",
    });

    assert.ok(
      "error" in result,
      `a refused reservation must answer the {error} union, not reject: ${JSON.stringify(result)}`,
    );
    assert.deepEqual(
      state.stopped,
      ["thr_spawned"],
      "the child bb made before persistence ran must be stopped",
    );
    assert.equal(
      (db.prepare(
        "SELECT COUNT(*) AS n FROM collab_agents WHERE thread_id = 'thr_spawned'",
      ).get() as { n: number }).n,
      0,
      "the refused spawn must leave no durable row behind",
    );
    assert.equal(
      (db.prepare(`
        SELECT COUNT(*) AS n FROM collab_item_reservations
        WHERE root_thread_id = 'thr_root' AND item_id = 'itm_race'
      `).get() as { n: number }).n,
      0,
      "a refused admission must RELEASE the reservation, never consume it",
    );

    // The point of the test: the refusal must not burn the slice's only slot.
    // Retiring the rival row frees the item, and the very next spawn of the
    // SAME item through the SAME hooks must be admitted.
    db.prepare("UPDATE collab_agents SET retired_at = ? WHERE thread_id = 'thr_legacy'").run(
      Date.now(),
    );
    const second = await collab.spawnWorker({
      parentThreadId: "thr_root",
      itemId: "itm_race",
      maxWorkers: 2,
      displayName: "Refused Scheduler",
      message: "SLICE (item_id=itm_race): retry once the rival retired",
    });
    assert.ok(
      "threadId" in second,
      `the slice must stay staffable after a refused admission: ${JSON.stringify(second)}`,
    );
    assert.equal(state.spawnCalls(), 2, "the retry must reach threads.spawn a second time");
    assert.equal(
      (db.prepare(`
        SELECT COUNT(*) AS n FROM collab_agents
        WHERE item_id = 'itm_race' AND retired_at IS NULL
      `).get() as { n: number }).n,
      1,
      "exactly one live row may own the slice after the retry",
    );
  });
});

describe("fleet management tool surface", () => {
  it("exposes the levers an orchestrator needs to act on what it can see", () => {
    // It could describe a redundant worker on a stale base and had only
    // ultragoal_interrupt_agent, which ends a turn while keeping the slot and the
    // assignment — so the slice stayed in_progress and the queue stayed blocked.
    for (const name of ["ultragoal_release_slice", "ultragoal_retire_agent"]) {
      assert.ok(
        (COLLAB_TOOL_NAMES as readonly string[]).includes(name),
        `${name} must be registered for the orchestrator`,
      );
    }
  });

  it("keeps ultragoal_interrupt_agent, which is different from giving work up", () => {
    assert.ok((COLLAB_TOOL_NAMES as readonly string[]).includes("ultragoal_interrupt_agent"));
  });
});

describe("immediate agent messaging", () => {
  function seedWorker(state: ReturnType<typeof collabHost>, itemId = "itm_live") {
    state.host.bb.storage.database().prepare(`
      INSERT INTO collab_agents (
        thread_id, root_thread_id, parent_thread_id, task_name, created_at,
        display_name, item_id, role
      ) VALUES ('thr_worker', 'thr_root', 'thr_root', '/root/worker', 1,
        'Live worker', ?, 'worker')
    `).run(itemId);
  }

  it("ultragoal_send_message steers a live worker and never touches the composer queue", async () => {
    const state = collabHost();
    seedWorker(state);
    const collab = createCollabStore(state.host.bb, {
      itemStatus: () => "in_progress",
    });
    collab.registerTools();

    const result = await state.host.harness.behavior.callAgentTool(
      "ultragoal_send_message",
      { target: "worker", message: "Stop gold-plating and finish the slice." },
      { threadId: "thr_root", projectId: "proj" },
    );
    assert.equal(
      typeof result === "object" && result !== null && "isError" in result
        ? (result as { isError?: boolean }).isError
        : false,
      false,
    );
    assert.equal(state.queued.length, 0);
    assert.deepEqual(state.sent, [{ threadId: "thr_worker", mode: "steer" }]);
  });

  it("ultragoal_followup_task uses the same immediate send path", async () => {
    const state = collabHost();
    seedWorker(state);
    const collab = createCollabStore(state.host.bb, {
      itemStatus: () => "in_progress",
    });
    collab.registerTools();

    const result = await state.host.harness.behavior.callAgentTool(
      "ultragoal_followup_task",
      { target: "worker", message: "Use the existing helper instead of a new one." },
      { threadId: "thr_root", projectId: "proj" },
    );
    assert.equal(
      typeof result === "object" && result !== null && "isError" in result
        ? (result as { isError?: boolean }).isError
        : false,
      false,
    );
    assert.equal(state.queued.length, 0);
    assert.deepEqual(state.sent, [{ threadId: "thr_worker", mode: "steer" }]);
  });
});
