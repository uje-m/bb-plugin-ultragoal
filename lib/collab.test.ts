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
import { COLLAB_TOOL_NAMES, createCollabStore, INTAKE_COURIER_DISPLAY_NAME, INTAKE_COURIER_SLUG, isIntakeCourier, isIntakeCourierTaskName } from "./collab.ts";
import { slugFromName } from "./names.ts";

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
  it("binds scheduler allocation to the validated host and peeled commit", async () => {
    // The root names an integration branch of its own: the validated commit must
    // still win, or a ref that moved between validation and allocation would
    // silently decide what the worker is cut from.
    const state = collabHost({ rootBranch: "integration" });
    const collab = createCollabStore(state.host.bb, {
      claimItem: (_root, args) => args.itemId ?? null,
    });
    const commit = "a".repeat(40);

    const result = await collab.spawnWorker({
      parentThreadId: "thr_root",
      itemId: "itm_validated",
      maxWorkers: 1,
      displayName: "Commit Binder",
      message: "SLICE (item_id=itm_validated): use the validated source",
      validatedBase: {
        hostId: "host_source",
        repository: "/srv/project",
        requestedRef: "release",
        commit,
      },
    });

    assert.ok(!("error" in result));
    const args = state.spawnArgs()[0] as {
      environment?: {
        hostId?: string;
        workspace?: { baseBranch?: { kind?: string; name?: string } };
      };
    };
    assert.equal(args.environment?.hostId, "host_source");
    assert.equal(args.environment?.workspace?.baseBranch?.kind, "named");
    assert.equal(args.environment?.workspace?.baseBranch?.name, commit);
    assert.notEqual(args.environment?.workspace?.baseBranch?.name, "integration");
  });

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

describe("intake courier identity", () => {
  it("accepts the row spawnWorker really creates and rejects every near miss", async () => {
    const state = collabHost();
    const collab = createCollabStore(state.host.bb);
    const spawned = await collab.spawnWorker({
      parentThreadId: "thr_root",
      itemId: null,
      skipClaim: true,
      maxWorkers: 4,
      displayName: INTAKE_COURIER_DISPLAY_NAME,
      message: "INTAKE TRIAGE (you are the goal's intake agent; do not implement anything).",
    });
    assert.ok(!("error" in spawned), JSON.stringify(spawned));

    // The identity must describe what the spawn side really emits, read back
    // from durable state rather than from the spawn arguments — the predicate
    // is a reload path and never sees the arguments.
    const persisted = state.host.bb.storage.database().prepare(
      "SELECT task_name, display_name, item_id, role FROM collab_agents WHERE thread_id = ?",
    ).get(spawned.threadId) as {
      task_name: string;
      display_name: string | null;
      item_id: string | null;
      role: string | null;
    };
    assert.match(
      persisted.task_name,
      new RegExp(`^/root/${INTAKE_COURIER_SLUG}_[0-9a-z]+$`),
      "the courier's task name is the spawn format the predicate anchors to",
    );
    assert.equal(persisted.display_name, INTAKE_COURIER_DISPLAY_NAME);
    assert.equal(persisted.item_id, null);
    assert.equal(persisted.role, "worker");
    const durable = collab.durableRowsForRoot("thr_root").find(
      (row) => row.threadId === spawned.threadId,
    );
    assert.ok(durable, "the courier row is a durable row of its root");
    assert.equal(durable.displayName, INTAKE_COURIER_DISPLAY_NAME);
    assert.equal(typeof durable.createdAt, "number");
    assert.equal(
      isIntakeCourier({
        taskName: durable.taskName,
        displayName: durable.displayName,
        itemId: durable.itemId,
        role: durable.role,
      }),
      true,
      "the exact row the plugin's intake spawn creates is a courier",
    );

    // Every near miss the incident class contains. A discovered or natively
    // spawned child is itemless too, and an orchestrator can name a real slice
    // with the same words — neither may inherit the courier's lifecycle.
    const nearMisses: Array<{ why: string; row: Parameters<typeof isIntakeCourier>[0] }> = [
      {
        why: "an itemless worker the plugin did not spawn is not a courier",
        row: {
          taskName: "/root/discovered_child_9zz",
          displayName: "Discovered Child",
          itemId: null,
          role: "worker",
        },
      },
      {
        why: "a verifier wearing the courier's name is not a courier",
        row: {
          taskName: persisted.task_name,
          displayName: INTAKE_COURIER_DISPLAY_NAME,
          itemId: null,
          role: "verifier",
        },
      },
      {
        why: "a differing display name is not the plugin's courier",
        row: {
          taskName: `/root/${INTAKE_COURIER_SLUG}_diagnostics`,
          displayName: "Intake Courier Diagnostics",
          itemId: null,
          role: "worker",
        },
      },
      {
        why: "sharing the slug words without the spawn format is not a courier",
        row: {
          taskName: "/root/intake_triage",
          displayName: INTAKE_COURIER_DISPLAY_NAME,
          itemId: null,
          role: "worker",
        },
      },
      {
        why: "an item-holding worker with the courier name is not a courier",
        row: {
          taskName: persisted.task_name,
          displayName: INTAKE_COURIER_DISPLAY_NAME,
          itemId: "itm_held",
          role: "worker",
        },
      },
    ];
    for (const { why, row } of nearMisses) assert.equal(isIntakeCourier(row), false, why);

    // The identity is one value: the slug the predicate matches is derived from
    // the name the spawn passes, so a rename can never leave the cleaner behind.
    assert.equal(slugFromName(INTAKE_COURIER_DISPLAY_NAME), INTAKE_COURIER_SLUG);
    assert.equal(isIntakeCourierTaskName(`/root/${INTAKE_COURIER_SLUG}_abc123`), true);
    assert.equal(isIntakeCourierTaskName(`/root/${INTAKE_COURIER_SLUG}`), false);
    assert.equal(isIntakeCourierTaskName("/root/intake_triage"), false);
    assert.equal(isIntakeCourierTaskName("/root/intake_courierish_abc"), false);
  });

  it("never claims a slice the owner's message quoted for the courier", async () => {
    // The courier carries the owner's message verbatim, so its spawn prompt is
    // untrusted prose. Before the guard, the adoption pass read the quoted
    // item_id out of it, linked the slice to the courier and destroyed the
    // identity the idle branch and the retirement sweep match on.
    const timeline: Record<string, string> = {};
    const state = collabHost({ prompts: timeline });
    const claims: Array<string | null> = [];
    const collab = createCollabStore(state.host.bb, {
      claimItem: (_root, request) => {
        claims.push(request.itemId);
        return request.itemId ?? null;
      },
    });
    const courierPrompt = [
      "INTAKE TRIAGE (you are the goal's intake agent; do not implement anything).",
      "OWNER MESSAGE:",
      "SLICE (item_id=itm_owner_brief): reconcile the itemless-worker adoption contract",
    ].join("\n\n");
    const spawned = await collab.spawnWorker({
      parentThreadId: "thr_root",
      itemId: null,
      skipClaim: true,
      maxWorkers: 4,
      displayName: INTAKE_COURIER_DISPLAY_NAME,
      message: courierPrompt,
    });
    assert.ok(!("error" in spawned), JSON.stringify(spawned));
    timeline[spawned.threadId] = courierPrompt;

    await collab.listForRoot("thr_root");

    assert.deepEqual(claims, [], "the courier's prompt is not a claim");
    const durable = collab.durableRowsForRoot("thr_root").find(
      (row) => row.threadId === spawned.threadId,
    );
    assert.ok(durable, "the courier row is a durable row of its root");
    assert.equal(durable.itemId, null);
    assert.equal(
      isIntakeCourier({
        taskName: durable.taskName,
        displayName: durable.displayName,
        itemId: durable.itemId,
        role: durable.role,
      }),
      true,
      "the courier must stay the row the idle branch and the retirement sweep recognize",
    );
  });
});

describe("immediate agent messaging", () => {
  /** One durable child row. Defaults to the worker the existing cases use. */
  function seedWorker(
    state: ReturnType<typeof collabHost>,
    itemId: string | null = "itm_live",
    overrides: {
      threadId?: string;
      rootThreadId?: string;
      taskName?: string;
      displayName?: string;
    } = {},
  ) {
    const rootThreadId = overrides.rootThreadId ?? "thr_root";
    state.host.bb.storage.database().prepare(`
      INSERT INTO collab_agents (
        thread_id, root_thread_id, parent_thread_id, task_name, created_at,
        display_name, item_id, role
      ) VALUES (@thread_id, @root_thread_id, @root_thread_id, @task_name, 1,
        @display_name, @item_id, 'worker')
    `).run({
      thread_id: overrides.threadId ?? "thr_worker",
      root_thread_id: rootThreadId,
      task_name: overrides.taskName ?? "/root/worker",
      display_name: overrides.displayName ?? "Live worker",
      item_id: itemId,
    });
  }

  function failed(result: unknown): boolean {
    return (
      typeof result === "object" &&
      result !== null &&
      (result as { isError?: boolean }).isError === true
    );
  }

  function textOf(result: unknown): string {
    if (typeof result === "string") return result;
    return ((result as { content?: Array<{ text?: string }> }).content ?? [])
      .map((part) => part.text ?? "")
      .join("");
  }

  function callTool(
    state: ReturnType<typeof collabHost>,
    tool: string,
    args: Record<string, unknown>,
    threadId: string,
  ) {
    return state.host.harness.behavior.callAgentTool(tool, args, {
      threadId,
      projectId: "proj",
    });
  }

  function collabOn(state: ReturnType<typeof collabHost>) {
    const collab = createCollabStore(state.host.bb, { itemStatus: () => "in_progress" });
    collab.registerTools();
    return collab;
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

  it("reaches the owning root for /root, root and the owning root's thread id", async () => {
    const state = collabHost();
    seedWorker(state);
    collabOn(state);

    for (const target of ["/root", "root", "thr_root"]) {
      const result = await callTool(
        state,
        "ultragoal_send_message",
        { target, message: "Need your ruling on the scope fence." },
        "thr_worker",
      );
      assert.equal(failed(result), false, `${target} must reach the owning root: ${textOf(result)}`);
    }
    assert.equal(state.queued.length, 0, "root delivery never touches the composer queue");
    assert.deepEqual(state.sent, [
      { threadId: "thr_root", mode: "start" },
      { threadId: "thr_root", mode: "start" },
      { threadId: "thr_root", mode: "start" },
    ]);
  });

  it("never routes a worker to another goal's root", async () => {
    const state = collabHost();
    seedWorker(state);
    seedWorker(state, null, {
      threadId: "thr_other_worker",
      rootThreadId: "thr_other_root",
      taskName: "/root/other_worker",
      displayName: "Other worker",
    });
    collabOn(state);

    const foreign = await callTool(
      state,
      "ultragoal_send_message",
      { target: "thr_other_root", message: "cross-goal" },
      "thr_worker",
    );
    assert.equal(failed(foreign), true, textOf(foreign));
    assert.match(textOf(foreign), /Agent not found: thr_other_root/);
    assert.equal(state.sent.length, 0, "another goal's root is unreachable");

    const own = await callTool(
      state,
      "ultragoal_send_message",
      { target: "/root", message: "my own root" },
      "thr_other_worker",
    );
    assert.equal(failed(own), false, textOf(own));
    assert.deepEqual(
      state.sent.map((entry) => entry.threadId),
      ["thr_other_root"],
      "the alias means the caller's OWN root",
    );
  });

  it("fails closed when the root itself addresses /root", async () => {
    const state = collabHost();
    seedWorker(state);
    // A real child whose task_name ends in "/root" is exactly what would
    // capture the alias if the root caller fell through to the suffix scan.
    seedWorker(state, null, {
      threadId: "thr_shadow",
      taskName: "/root/root",
      displayName: "Shadow child",
    });
    collabOn(state);

    for (const target of ["/root", "root"]) {
      const result = await callTool(
        state,
        "ultragoal_send_message",
        { target, message: "steer myself?" },
        "thr_root",
      );
      assert.equal(failed(result), true, `${target} must not resolve from the root`);
      assert.match(textOf(result), new RegExp(`Agent not found: ${target}`));
    }
    assert.deepEqual(state.sent, [], "the root never steers itself");
  });

  it("fails closed for a thread with no durable row", async () => {
    const state = collabHost();
    collabOn(state);

    const result = await callTool(
      state,
      "ultragoal_send_message",
      { target: "/root", message: "who owns me?" },
      "thr_orphan",
    );
    assert.equal(failed(result), true, textOf(result));
    assert.match(textOf(result), /Agent not found: \/root/);
    assert.deepEqual(state.sent, [], "a rowless thread has no owning root to address");
  });

  it("keeps canonical, short and thread-id child addressing working", async () => {
    const state = collabHost();
    seedWorker(state);
    seedWorker(state, "itm_peer", {
      threadId: "thr_peer",
      taskName: "/root/peer",
      displayName: "The peer",
    });
    collabOn(state);

    for (const target of ["/root/peer", "peer", "thr_peer"]) {
      const result = await callTool(
        state,
        "ultragoal_send_message",
        { target, message: "child controls" },
        "thr_worker",
      );
      assert.equal(failed(result), false, `${target} must keep reaching the child: ${textOf(result)}`);
    }
    assert.deepEqual(state.sent.map((entry) => entry.threadId), ["thr_peer", "thr_peer", "thr_peer"]);
  });

  it("reserves the root aliases against a child named /root/root", async () => {
    const state = collabHost();
    seedWorker(state);
    seedWorker(state, "itm_shadow", {
      threadId: "thr_shadow",
      taskName: "/root/root",
      displayName: "Shadow child",
    });
    collabOn(state);

    for (const target of ["/root", "root"]) {
      const result = await callTool(
        state,
        "ultragoal_send_message",
        { target, message: "owning root, not the shadow child" },
        "thr_worker",
      );
      assert.equal(failed(result), false, `${target}: ${textOf(result)}`);
    }
    assert.deepEqual(state.sent.map((entry) => entry.threadId), ["thr_root", "thr_root"]);

    // ...while the real child keeps the addresses it had: canonical and id.
    for (const target of ["/root/root", "thr_shadow"]) {
      const result = await callTool(
        state,
        "ultragoal_send_message",
        { target, message: "real child" },
        "thr_worker",
      );
      assert.equal(failed(result), false, `${target}: ${textOf(result)}`);
    }
    assert.deepEqual(state.sent.slice(2).map((entry) => entry.threadId), ["thr_shadow", "thr_shadow"]);
  });

  it("keeps follow-ups refused for root targets and steering for children", async () => {
    const state = collabHost();
    seedWorker(state);
    collabOn(state);

    for (const target of ["/root", "thr_root"]) {
      const refused = await callTool(
        state,
        "ultragoal_followup_task",
        { target, message: "steer the root" },
        "thr_worker",
      );
      assert.equal(failed(refused), true, `${target} must stay refused`);
      assert.match(textOf(refused), /Follow-up tasks can't target the root agent/);
    }
    // Bare "root" is not a follow-up alias: it fails to resolve rather than
    // being caught by the root-target refusal, and must not reach the root.
    const bare = await callTool(
      state,
      "ultragoal_followup_task",
      { target: "root", message: "steer the root" },
      "thr_worker",
    );
    assert.equal(failed(bare), true);
    assert.match(textOf(bare), /Agent not found: root/);
    assert.equal(state.sent.length, 0, "no root follow-up is ever delivered");

    const child = await callTool(
      state,
      "ultragoal_followup_task",
      { target: "worker", message: "clarify the slice" },
      "thr_root",
    );
    assert.equal(failed(child), false, textOf(child));
    assert.deepEqual(state.sent.map((entry) => entry.threadId), ["thr_worker"]);
  });

  it("does not widen the lifecycle tools to the root", async () => {
    const state = collabHost();
    seedWorker(state);
    collabOn(state);

    const attempts: Array<[string, Record<string, unknown>]> = [
      ["ultragoal_interrupt_agent", { target: "/root" }],
      ["ultragoal_release_slice", { target: "/root", reason: "no" }],
      ["ultragoal_retire_agent", { target: "/root" }],
    ];
    for (const [tool, args] of attempts) {
      const result = await callTool(state, tool, args, "thr_worker");
      assert.equal(failed(result), true, `${tool} must refuse the root: ${textOf(result)}`);
      assert.match(textOf(result), /Agent not found: \/root/);
    }
    assert.deepEqual(state.stopped, [], "the root is never stopped");
    assert.equal(
      state.host.harness.inspection.sdk.callsTo("threads.archive").length,
      0,
      "the root is never archived",
    );

    const child = await callTool(
      state,
      "ultragoal_interrupt_agent",
      { target: "worker" },
      "thr_root",
    );
    assert.equal(failed(child), false, textOf(child));
    assert.deepEqual(state.stopped, ["thr_worker"], "existing child controls keep working");
  });
});
