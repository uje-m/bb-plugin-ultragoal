import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import plugin from "../server.ts";
import { createItemStore } from "./items.ts";
import { createItemReservationStore } from "./item-reservations.ts";
import {
  coalescingFilesOverlap,
  findingFilesMatchItem,
  findingMatchesItem,
  filesOverlap,
  findingAction,
  finishedWorkerRetirementCandidates,
  ownSliceScope,
  planWorkerRelease,
  retirementPermittedByHost,
  setSharedInfrastructureFiles,
  freeSlots,
  liveVerifierCount,
  occupyingWorkerIds,
  orphanInProgressIds,
  isTransientTurnFailure,
  isTurnAlreadyActiveError,
  itemContextDeclaresFinding,
  threadAcceptsStart,
  threadAcceptsSteer,
  immediateSendMode,
  threadIsSettledForSubmit,
  verifierStillDeciding,
} from "./scheduler.ts";

describe("planWorkerRelease", () => {
  const ROOT = "thr_root";
  const worker = (over: Record<string, unknown> = {}) => ({
    threadId: "thr_w",
    rootThreadId: ROOT,
    role: "worker" as string | null,
    itemId: "itm_1" as string | null,
    reportStatus: null as string | null,
    hostStatus: "idle" as string | null,
    ...over,
  });

  it("releases an idle worker's slice", () => {
    assert.deepEqual(planWorkerRelease([worker()], ROOT), {
      ok: true,
      release: [{ threadId: "thr_w", itemId: "itm_1" }],
    });
  });

  it("releases a worker whose host could not be read", () => {
    // An unreadable host is not proof of life, and refusing there would make the
    // command useless in exactly the situation it exists for.
    const plan = planWorkerRelease([worker({ hostStatus: null })], ROOT);
    assert.equal(plan.ok, true);
  });

  it("refuses an active or starting worker", () => {
    for (const hostStatus of ["active", "starting"]) {
      const plan = planWorkerRelease([worker({ hostStatus })], ROOT);
      assert.equal(plan.ok, false);
      assert.match((plan as { reason: string }).reason, new RegExp(hostStatus));
    }
  });

  it("refuses a verifier, which holds no slice of its own", () => {
    const plan = planWorkerRelease([worker({ role: "verifier" })], ROOT);
    assert.equal(plan.ok, false);
    assert.match((plan as { reason: string }).reason, /verifier/);
  });

  it("refuses a worker that already reported done", () => {
    const plan = planWorkerRelease([worker({ reportStatus: "done" })], ROOT);
    assert.equal(plan.ok, false);
    assert.match((plan as { reason: string }).reason, /completion path/);
  });

  it("refuses a worker belonging to another root", () => {
    const plan = planWorkerRelease([worker({ rootThreadId: "thr_other" })], ROOT);
    assert.equal(plan.ok, false);
  });

  it("refuses the whole batch when any later target is invalid", () => {
    // Partial release is the failure mode this two-phase shape exists to
    // prevent: the caller could not tell which half of a held item was freed.
    const plan = planWorkerRelease(
      [worker(), worker({ threadId: "thr_w2", hostStatus: "active" })],
      ROOT,
    );
    assert.equal(plan.ok, false);
    assert.match((plan as { reason: string }).reason, /thr_w2/);
  });

  it("refuses an empty target set rather than reporting success", () => {
    assert.equal(planWorkerRelease([], ROOT).ok, false);
  });
});

describe("verifierStillDeciding", () => {
  const GRACE = 10 * 60_000;
  const NOW = 1_000_000_000;
  const noneLive = () => false;

  it("blocks retirement while a verifier is live", () => {
    assert.equal(
      verifierStillDeciding(
        [{ threadId: "thr_v", createdAt: NOW - GRACE * 5, reportStatus: null }],
        (id) => id === "thr_v",
        NOW,
        GRACE,
      ),
      true,
    );
  });

  it("blocks retirement for a young verifier whose verdict may be unharvested", () => {
    assert.equal(
      verifierStillDeciding(
        [{ threadId: "thr_v", createdAt: NOW - 1_000, reportStatus: null }],
        noneLive,
        NOW,
        GRACE,
      ),
      true,
    );
  });

  it("stops blocking once a crashed verifier is past the grace window", () => {
    // verifiersFor returns every non-retired row regardless of host state, so a
    // verifier that died before emitting a verdict used to hold its source
    // worker's slot for the life of the goal.
    assert.equal(
      verifierStillDeciding(
        [{ threadId: "thr_v", createdAt: NOW - GRACE - 1, reportStatus: null }],
        noneLive,
        NOW,
        GRACE,
      ),
      false,
    );
  });

  it("stops blocking as soon as a verifier has recorded its verdict", () => {
    for (const reportStatus of ["done", "blocked"]) {
      assert.equal(
        verifierStillDeciding(
          [{ threadId: "thr_v", createdAt: NOW, reportStatus }],
          () => true,
          NOW,
          GRACE,
        ),
        false,
        `report ${reportStatus} should not block`,
      );
    }
  });

  it("does not block when there is no verifier at all", () => {
    assert.equal(verifierStillDeciding([], noneLive, NOW, GRACE), false);
  });
});

describe("occupyingWorkerIds", () => {
  const open = new Set(["itm_a", "itm_b"]);

  it("counts running workers even without an item", () => {
    const ids = occupyingWorkerIds(
      [{ role: "worker", status: "running", itemId: null, threadId: "thr_1" }],
      open,
    );
    assert.deepEqual(ids, ["thr_1"]);
  });

  it("counts idle workers that still hold an open slice", () => {
    const ids = occupyingWorkerIds(
      [{ role: "worker", status: "idle", itemId: "itm_a", threadId: "thr_1" }],
      open,
    );
    assert.deepEqual(ids, ["thr_1"]);
  });

  it("counts unknown holders so uncached crew cannot leak slots", () => {
    const ids = occupyingWorkerIds(
      [{ role: "worker", status: "unknown", itemId: "itm_a", threadId: "thr_1" }],
      open,
    );
    assert.deepEqual(ids, ["thr_1"]);
  });

  it("does not count idle workers whose slice is already closed", () => {
    const ids = occupyingWorkerIds(
      [{ role: "worker", status: "idle", itemId: "itm_done", threadId: "thr_1" }],
      open,
    );
    assert.deepEqual(ids, []);
  });

  it("does not count verifiers or stopped/error husks", () => {
    const ids = occupyingWorkerIds(
      [
        { role: "verifier", status: "running", itemId: "itm_a", threadId: "thr_v" },
        { role: "worker", status: "stopped", itemId: "itm_a", threadId: "thr_s" },
        { role: "worker", status: "error", itemId: "itm_b", threadId: "thr_e" },
      ],
      open,
    );
    assert.deepEqual(ids, []);
  });

  it("keeps a 5-slot crew at 5 when Codex workers idle mid-slice", () => {
    const agents = [1, 2, 3, 4, 5].map((n) => ({
      role: "worker" as const,
      status: n <= 2 ? ("running" as const) : ("idle" as const),
      itemId: `itm_${n}`,
      threadId: `thr_${n}`,
    }));
    const openFive = new Set(agents.map((agent) => agent.itemId!));
    assert.equal(occupyingWorkerIds(agents, openFive).length, 5);
    assert.equal(freeSlots(5, occupyingWorkerIds(agents, openFive).length), 0);
  });
});

describe("retirementPermittedByHost", () => {
  it("refuses to retire when the host could not be read", () => {
    // Unknown is not proof of death. The in-memory projection drops exactly the
    // workers this pass collects, so treating absence as "not live" would stop
    // a genuinely running worker on any transient host-read failure.
    assert.equal(retirementPermittedByHost(null), false);
  });

  it("refuses to retire a live host in either status vocabulary", () => {
    for (const status of ["active", "running", "starting"]) {
      assert.equal(retirementPermittedByHost(status), false, status);
    }
  });

  it("permits retiring a settled host", () => {
    for (const status of ["idle", "stopped", "error", "completed"]) {
      assert.equal(retirementPermittedByHost(status), true, status);
    }
  });
});

describe("ownSliceScope", () => {
  it("normalizes declared fix files so line-qualified paths still overlap", () => {
    // The scheduler compares scopes as exact paths, so a stored
    // "src/shared.ts:99" would never overlap another slice's "src/shared.ts".
    assert.deepEqual(
      ownSliceScope("src/x.ts:12", ["src/shared.ts:99", "src/other.ts"]),
      ["src/shared.ts", "src/other.ts"],
    );
  });

  it("deduplicates declared files that normalize to the same path", () => {
    assert.deepEqual(
      ownSliceScope("src/x.ts", ["src/a.ts:1", "src/a.ts:2", "src/a.ts"]),
      ["src/a.ts"],
    );
  });

  it("falls back to the normalized evidence file when nothing is declared", () => {
    assert.deepEqual(ownSliceScope("src/x.ts:12", undefined), ["src/x.ts"]);
    assert.deepEqual(ownSliceScope("src/x.ts:12", []), ["src/x.ts"]);
  });

  it("returns an empty scope only when there is genuinely nothing to scope", () => {
    assert.deepEqual(ownSliceScope("", []), []);
  });
});

describe("finishedWorkerRetirementCandidates", () => {
  const noVerifier = () => false;
  const items = [
    { id: "itm_open", status: "in_progress" as const },
    { id: "itm_done", status: "completed" as const },
    { id: "itm_waiting", status: "pending" as const },
  ];

  it("retires a worker whose slice completed but whose host stop failed", () => {
    // The stop is best-effort, so the host can stay `idle` forever. The SQL
    // capacity fence counts the row regardless; without this reconciliation it
    // holds a root slot permanently.
    const retire = finishedWorkerRetirementCandidates(
      [{ role: "worker", itemId: "itm_done", threadId: "thr_done" }],
      items,
      noVerifier,
    );
    assert.deepEqual(retire, ["thr_done"]);
  });

  it("retires a worker whose slice vanished from the plan", () => {
    const retire = finishedWorkerRetirementCandidates(
      [{ role: "worker", itemId: "itm_gone", threadId: "thr_gone" }],
      items,
      noVerifier,
    );
    assert.deepEqual(retire, ["thr_gone"]);
  });

  it("collects a finished worker the agent projection would have dropped", () => {
    // oneWorkerPerItem drops any non-live worker whose item is completed, so the
    // projected list cannot contain this row at all. Reconciling against the
    // projection instead of the durable rows made this function a no-op that
    // still looked correct: the one case it exists for was invisible to it.
    const durableOnly = [{ role: null, itemId: "itm_done", threadId: "thr_invisible" }];
    assert.deepEqual(
      finishedWorkerRetirementCandidates(durableOnly, items, noVerifier),
      ["thr_invisible"],
    );
  });

  it("keeps workers whose slice is still in progress or still pending", () => {
    const retire = finishedWorkerRetirementCandidates(
      [
        { role: "worker", itemId: "itm_open", threadId: "thr_open" },
        { role: "worker", itemId: "itm_waiting", threadId: "thr_waiting" },
      ],
      items,
      noVerifier,
    );
    assert.deepEqual(retire, []);
  });


  it("keeps a finished worker a verifier still reads as its source", () => {
    const retire = finishedWorkerRetirementCandidates(
      [{ role: "worker", itemId: "itm_done", threadId: "thr_done" }],
      items,
      (threadId) => threadId === "thr_done",
    );
    assert.deepEqual(retire, []);
  });

  it("never retires verifiers or itemless crew", () => {
    const retire = finishedWorkerRetirementCandidates(
      [
        { role: "verifier", itemId: "itm_done", threadId: "thr_verifier" },
        { role: "worker", itemId: null, threadId: "thr_itemless" },
      ],
      items,
      noVerifier,
    );
    assert.deepEqual(retire, []);
  });

  it("frees every leaked slot so a wedged full crew can staff again", () => {
    const workers = [1, 2, 3, 4, 5].map((n) => ({
      role: "worker" as const,
      itemId: `itm_${n}`,
      threadId: `thr_${n}`,
    }));
    const closed = workers.map((worker) => ({
      id: worker.itemId,
      status: "completed" as const,
    }));
    assert.equal(
      finishedWorkerRetirementCandidates(workers, closed, noVerifier).length,
      5,
    );
  });
});

describe("findingAction", () => {
  const openItems = [
    {
      id: "itm_search",
      step: "Repair search behavior in web/lib/search.ts",
      status: "in_progress" as const,
      files: ["web/lib/search.ts"],
    },
    {
      id: "itm_pay",
      step: "Repair payment behavior in engine/src/payments.ts",
      status: "pending" as const,
      files: ["engine/src/payments.ts"],
    },
  ];

  it("attaches a same-file finding to the existing slice", () => {
    const result = findingAction({
      findingId: "fnd_search",
      file: "web/lib/search.ts:88",
      staffedRemediationCount: 50,
      maxStaffedRemediations: 50,
      openItems,
    });
    assert.deepEqual(result, { action: "attach", attachItemId: "itm_search" });
  });

  it("records without minting once remediation work capacity is hit", () => {
    const result = findingAction({
      findingId: "fnd_authz",
      file: "web/lib/authz.ts",
      staffedRemediationCount: 50,
      maxStaffedRemediations: 50,
      openItems,
    });
    assert.deepEqual(result, { action: "record-only" });
  });

  it("mints a slice for a new file under the cap", () => {
    const result = findingAction({
      findingId: "fnd_authz",
      file: "web/lib/authz.ts",
      staffedRemediationCount: 3,
      maxStaffedRemediations: 50,
      openItems,
    });
    assert.deepEqual(result, { action: "mint" });
  });

  it("does not attach unrelated findings through a shared migration directory", () => {
    const result = findingAction({
      findingId: "fnd_documents",
      file: "schema/migrations/generated",
      fixFiles: ["schema/src/documents.ts", "schema/migrations/generated"],
      staffedRemediationCount: 3,
      maxStaffedRemediations: 50,
      openItems: [
        {
          id: "itm_recurring",
          step: "Repair recurring logic in engine/src/recurring.ts",
          status: "in_progress" as const,
          files: ["engine/src/recurring.ts", "schema/migrations/generated"],
        },
      ],
    });
    assert.deepEqual(result, { action: "mint" });
  });

  it("does not coalesce distinct lines in a monolithic generated baseline", () => {
    const result = findingAction({
      findingId: "fnd_tenant_fk",
      file: "schema/migrations/generated/0001_baseline.sql:30655",
      fixFiles: ["schema/migrations/generated/0001_baseline.sql"],
      staffedRemediationCount: 3,
      maxStaffedRemediations: 50,
      openItems: [
        {
          id: "itm_tax_rate",
          step:
            "Repair tax-rate persistence [schema/migrations/generated/0001_baseline.sql:1200]",
          status: "in_progress" as const,
          files: ["schema/migrations/generated/0001_baseline.sql"],
        },
      ],
    });
    assert.deepEqual(result, { action: "mint" });
  });

  it("attaches when fix scope shares a concrete domain file", () => {
    const result = findingAction({
      findingId: "fnd_recurring",
      file: "schema/migrations/generated",
      fixFiles: ["engine/src/recurring.ts", "schema/migrations/generated"],
      staffedRemediationCount: 50,
      maxStaffedRemediations: 50,
      openItems: [
        {
          id: "itm_recurring",
          step: "Repair recurring logic in engine/src/recurring.ts",
          status: "in_progress" as const,
          files: ["engine/src/recurring.ts", "schema/migrations/generated"],
        },
      ],
    });
    assert.deepEqual(result, { action: "attach", attachItemId: "itm_recurring" });
  });

  it("attaches an exact Next dynamic-route file", () => {
    const result = findingAction({
      findingId: "fnd_mt97llmk_73ao2v",
      file: "web/app/api/admin/setup/[entity]/route.ts:42",
      staffedRemediationCount: 50,
      maxStaffedRemediations: 50,
      openItems: [
        {
          id: "itm_setup",
          step: "Fix tax setup in web/app/api/admin/setup/[entity]/route.ts",
          status: "pending" as const,
          files: ["web/app/api/admin/setup/[entity]/route.ts"],
        },
      ],
    });
    assert.deepEqual(result, { action: "attach", attachItemId: "itm_setup" });
  });

  it("attaches only ids named by a structured CONTEXT audit-findings clause", () => {
    const item = {
      id: "itm_payment",
      step:
        "Fix payment durability. CONTEXT (audit findings #42 fnd_mt97oet5_3vwaph + #43 fnd_mt97oqxt_pkqakx): both failures share one transaction boundary.",
      status: "pending" as const,
      files: [],
    };
    assert.deepEqual(
      findingAction({
        findingId: "fnd_mt97oqxt_pkqakx",
        file: "schema/migrations/generated",
        staffedRemediationCount: 50,
        maxStaffedRemediations: 50,
        openItems: [item],
      }),
      { action: "attach", attachItemId: "itm_payment" },
    );
    assert.deepEqual(
      findingAction({
        findingId: "fnd_mt97dd9k_xl8bc6",
        file: "schema/migrations/generated",
        staffedRemediationCount: 1,
        maxStaffedRemediations: 50,
        openItems: [
          {
            ...item,
            step:
              "AUDITOR TIGHTENING: fnd_mt97dd9k_xl8bc6 proves broad migration coalescing is WRONG.",
          },
        ],
      }),
      { action: "mint" },
    );
  });
});

describe("findingFilesMatchItem", () => {
  it("matches exact concrete finding and declared repair files", () => {
    const item = {
      step: "Repair segment ownership",
      files: ["schema/src/segments.ts", "schema/migrations/generated"],
    };
    assert.equal(findingFilesMatchItem("schema/src/segments.ts:88", [], item), true);
    assert.equal(
      findingFilesMatchItem(
        "schema/migrations/generated/baseline.sql:12",
        ["schema/src/segments.ts"],
        item,
      ),
      true,
    );
  });

  it("uses concrete files named in the item step", () => {
    assert.equal(
      findingFilesMatchItem(
        "schema/src/pricing.ts:41",
        [],
        {
          step: "Correct rate-book generation in schema/src/pricing.ts.",
          files: ["schema/migrations/generated"],
        },
      ),
      true,
    );
  });

  it("rejects broad directories, shared infrastructure, and unrelated files", () => {
    assert.equal(
      findingFilesMatchItem(
        "schema/migrations/generated",
        ["schema/migrations/generated"],
        {
          step: "Regenerate schema/migrations/generated",
          files: ["schema/src/segments.ts", "schema/migrations/generated"],
        },
      ),
      false,
    );
    assert.equal(
      findingFilesMatchItem(
        "package.json",
        ["schema/canonical-baseline.test.ts"],
        { step: "Update package.json", files: ["package.json"] },
      ),
      false,
    );
    assert.equal(
      findingFilesMatchItem(
        "schema/src/pricing.ts",
        [],
        { step: "Repair schema/src/segments.ts", files: ["schema/src/segments.ts"] },
      ),
      false,
    );
    assert.equal(
      findingFilesMatchItem(
        "schema/migrations/generated/0001_baseline.sql:29912",
        ["schema/migrations/generated/0001_baseline.sql"],
        {
          step: "Repair another baseline line in schema/migrations/generated/0001_baseline.sql",
          files: ["schema/migrations/generated/0001_baseline.sql"],
        },
      ),
      false,
    );
  });

  it("treats square-bracket route segments as literal concrete paths", () => {
    assert.equal(
      findingFilesMatchItem(
        "web/app/api/admin/setup/[entity]/route.ts:19",
        [],
        {
          step: "Repair web/app/api/admin/setup/[entity]/route.ts.",
          files: [],
        },
      ),
      true,
    );
  });
});

describe("structured audit finding declarations", () => {
  const paymentStep =
    "Fix payments. CONTEXT (audit findings #42 fnd_mt97oet5_3vwaph + #43 fnd_mt97oqxt_pkqakx): durable claim required.";
  const appStep =
    "Fix apps. CONTEXT (audit findings #57 fnd_mt97wk5r_6qlleu + #58 fnd_mt97wkcv_xyihvs): make writes atomic.";

  it("accepts exact ids in singular or plural CONTEXT audit clauses", () => {
    assert.equal(itemContextDeclaresFinding(paymentStep, "fnd_mt97oet5_3vwaph"), true);
    assert.equal(itemContextDeclaresFinding(paymentStep, "fnd_mt97oqxt_pkqakx"), true);
    assert.equal(itemContextDeclaresFinding(appStep, "fnd_mt97wk5r_6qlleu"), true);
    assert.equal(itemContextDeclaresFinding(appStep, "fnd_mt97wkcv_xyihvs"), true);
    assert.equal(
      itemContextDeclaresFinding(
        "CONTEXT (audit finding #29, fnd_mt97dwj1_u541eg): enforce credit limits.",
        "fnd_mt97dwj1_u541eg",
      ),
      true,
    );
  });

  it("rejects ids mentioned outside the structured CONTEXT clause", () => {
    const tightening =
      "AUDITOR TIGHTENING: the old attachment of fnd_mt97dd9k_xl8bc6 was WRONG and must be detached.";
    assert.equal(itemContextDeclaresFinding(tightening, "fnd_mt97dd9k_xl8bc6"), false);
    assert.equal(
      findingMatchesItem(
        "fnd_mt97dd9k_xl8bc6",
        "schema/migrations/generated",
        ["schema/migrations/generated"],
        { step: tightening, files: ["schema/migrations/generated"] },
      ),
      false,
    );
  });
});

describe("filesOverlap", () => {
  it("treats a directory scope as overlapping its children", () => {
    assert.equal(filesOverlap(["web/lib"], ["web/lib/search.ts"]), true);
  });

  it("does not overlap sibling files", () => {
    assert.equal(filesOverlap(["web/lib/search.ts"], ["web/lib/authz.ts"]), false);
  });
});

describe("coalescingFilesOverlap", () => {
  it("requires an exact concrete file instead of directory ancestry", () => {
    assert.equal(coalescingFilesOverlap(["web/lib"], ["web/lib/search.ts"]), false);
    assert.equal(coalescingFilesOverlap(["web/lib/search.ts"], ["web/lib/search.ts:42"]), true);
  });

  it("does not use ecosystem manifests as semantic ownership", () => {
    // Only files nearly every repository has are built in. A path meaningful to
    // one project used to sit in this list, which applied that project's layout
    // to every other one.
    for (const manifest of ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) {
      assert.equal(coalescingFilesOverlap([manifest], [manifest]), false, manifest);
    }
  });

  it("treats a configured repository file as shared, and stops when it is unconfigured", () => {
    const repoFile = "schema/canonical-baseline.test.ts";
    // Unconfigured, it is an ordinary file and may anchor ownership.
    setSharedInfrastructureFiles([]);
    assert.equal(coalescingFilesOverlap([repoFile], [repoFile]), true);
    // Configured, it can no longer merge two unrelated defects.
    setSharedInfrastructureFiles([repoFile]);
    assert.equal(coalescingFilesOverlap([repoFile], [repoFile]), false);
    // The built-ins survive configuration rather than being replaced by it.
    assert.equal(coalescingFilesOverlap(["package.json"], ["package.json"]), false);
    setSharedInfrastructureFiles([]);
  });

  it("normalizes configured paths, so a line-qualified entry still matches", () => {
    setSharedInfrastructureFiles(["schema/inventory.ts:42"]);
    assert.equal(coalescingFilesOverlap(["schema/inventory.ts"], ["schema/inventory.ts"]), false);
    setSharedInfrastructureFiles([]);
  });
});

describe("liveVerifierCount / threadAcceptsSteer / orphanInProgressIds", () => {
  it("counts only live verifiers", () => {
    assert.equal(
      liveVerifierCount([
        { role: "verifier", status: "running" },
        { role: "verifier", status: "idle" },
        { role: "worker", status: "starting" },
      ]),
      1,
    );
  });

  it("refuses archived, deleted, and terminal threads", () => {
    assert.equal(threadAcceptsSteer({ status: "idle" }), true);
    assert.equal(threadAcceptsSteer({ status: "active" }), true);
    assert.equal(threadAcceptsSteer({ status: "error" }), false);
    assert.equal(threadAcceptsSteer({ status: "idle", archivedAt: 1 }), false);
    assert.equal(threadAcceptsSteer({ status: "idle", deletedAt: 1 }), false);
    assert.equal(threadAcceptsSteer({ status: "stopping" }), false);
  });

  it("starts a new turn on idle or errored threads, not live ones", () => {
    assert.equal(threadAcceptsStart({ status: "idle" }), true);
    assert.equal(threadAcceptsStart({ status: "error" }), true);
    assert.equal(threadAcceptsStart({ status: "stopped" }), true);
    assert.equal(threadAcceptsStart({ status: "active" }), false);
    assert.equal(threadAcceptsStart({ status: "starting" }), false);
    assert.equal(threadAcceptsStart({ status: "stopping" }), false);
    assert.equal(threadAcceptsStart({ status: "idle", archivedAt: 1 }), false);
    assert.equal(threadAcceptsStart({ status: "error", deletedAt: 1 }), false);
  });

  it("picks start for idle threads and steer for live ones, never a queue path", () => {
    assert.equal(immediateSendMode({ status: "idle" }), "start");
    assert.equal(immediateSendMode({ status: "error" }), "start");
    assert.equal(immediateSendMode({ status: "stopped" }), "start");
    assert.equal(immediateSendMode({ status: "active" }), "steer");
    assert.equal(immediateSendMode({ status: "starting" }), "steer");
    assert.equal(immediateSendMode({ status: "stopping" }), null);
    assert.equal(immediateSendMode({ status: "idle", archivedAt: 1 }), null);
  });

  it("treats only non-running statuses as settled for submit", () => {
    assert.equal(threadIsSettledForSubmit("idle"), true);
    assert.equal(threadIsSettledForSubmit("error"), true);
    assert.equal(threadIsSettledForSubmit("stopped"), true);
    assert.equal(threadIsSettledForSubmit("active"), false);
    assert.equal(threadIsSettledForSubmit("starting"), false);
    assert.equal(threadIsSettledForSubmit("stopping"), false);
  });

  it("classifies OpenCode ghost-turn submit failures", () => {
    assert.equal(isTurnAlreadyActiveError("A turn is already active"), true);
    assert.equal(isTurnAlreadyActiveError(new Error("Command turn.submit failed: A turn is already active")), true);
    assert.equal(isTurnAlreadyActiveError("HTTP 409: Thread is already active"), false);
    assert.equal(isTransientTurnFailure("Command turn.submit failed"), true);
    assert.equal(isTransientTurnFailure("A turn is already active"), true);
    assert.equal(isTransientTurnFailure("No active ACP session"), true);
    assert.equal(isTransientTurnFailure("Usage limited"), false);
  });

  it("lists in_progress slices nobody holds", () => {
    assert.deepEqual(
      orphanInProgressIds(
        [
          { id: "itm_held", status: "in_progress" },
          { id: "itm_ghost", status: "in_progress" },
          { id: "itm_next", status: "pending" },
        ],
        new Set(["itm_held"]),
      ),
      ["itm_ghost"],
    );
  });
});
// ---------------------------------------------------------------------------
// Real plugin lifecycle: convergence after a worker is stopped, aborted before
// acceptance, or released. Every assertion reads durable rows or spawns.
// ---------------------------------------------------------------------------

const hosts: FakePluginHost[] = [];
const REAL_NOW = Date.now;

afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()!.harness.lifecycle.dispose();
  Date.now = REAL_NOW;
});

type EventRow = { seq: number; type: string; data?: Record<string, unknown> };

async function drain(
  service: { controller: AbortController; done: Promise<unknown> },
  settle: (rounds?: number) => Promise<void>,
): Promise<void> {
  await settle(10);
  service.controller.abort();
  await service.done;
  await settle(80);
}

async function reloadHost(host: FakePluginHost): Promise<FakePluginHost> {
  const next = await host.harness.lifecycle.reload(plugin);
  hosts.push(next);
  return next;
}

function liveGoal(rootId: string, maxWorkers: number) {
  const spawns: Array<{ threadId: string; itemId: string | null }> = [];
  const statuses = new Map<string, string>();
  const events = new Map<string, EventRow[]>();
  const stopped: string[] = [];
  let spawnFailure: string | null = null;
  let stopFailure: string | null = null;
  let eventReadFails = false;
  let spawnCalls = 0;
  let gate: Promise<void> | null = null;
  let openGate: (() => void) | null = null;
  const thread = (threadId: string, status: string) =>
    makeThreadResponse({
      id: threadId,
      projectId: "proj",
      providerId: "codex",
      environmentId: null,
      parentThreadId: threadId === rootId ? null : rootId,
      status: status as never,
    });
  const host = createFakePluginHost({
    pluginId: `ultragoal-scheduler-${hosts.length}`,
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => thread(threadId, statuses.get(threadId) ?? "idle"),
        list: () => [],
        timeline: () => ({ rows: [] as never[] }),
        output: () => ({ output: null }),
        send: async () => ({ ok: true }),
        archive: async () => ({}),
        update: async ({ threadId }: { threadId: string }) => thread(threadId, "idle"),
        interactions: { list: async () => [], resolve: async () => ({}) },
        stop: async ({ threadId }: { threadId: string }) => {
          stopped.push(threadId);
          if (stopFailure) throw new Error(stopFailure);
          return { ok: true };
        },
        events: {
          list: async (args: {
            threadId: string;
            types?: readonly string[];
            order?: string;
            limit?: string;
            afterSeq?: string;
          }) => {
            if (eventReadFails) throw new Error("event projection read failed");
            let rows = [...(events.get(args.threadId) ?? [])].sort((a, b) => a.seq - b.seq);
            if (args.types?.length) rows = rows.filter((row) => args.types!.includes(row.type));
            if (args.afterSeq != null) rows = rows.filter((row) => row.seq > Number(args.afterSeq));
            if (args.order === "desc") rows.reverse();
            if (args.limit != null) rows = rows.slice(0, Number(args.limit));
            return rows as never;
          },
        },
        spawn: async (args: { parentThreadId?: string | null; prompt?: string }) => {
          spawnCalls += 1;
          if (gate) await gate;
          if (spawnFailure) throw new Error(spawnFailure);
          const id = `thr_spawn_${spawnCalls}`;
          spawns.push({
            threadId: id,
            itemId: /item_id=(itm_[A-Za-z0-9_]+)/.exec(args.prompt ?? "")?.[1] ?? null,
          });
          statuses.set(id, "active");
          return thread(id, "active");
        },
      },
    } as never,
  });
  hosts.push(host);
  const db = host.bb.storage.database();
  // Sentinel row: keeps the store's one-time legacy import out of this machine's
  // developer database, exactly as lib/server-tools.test.ts does.
  db.exec(`CREATE TABLE goals (
      thread_id TEXT PRIMARY KEY, objective TEXT NOT NULL, status TEXT NOT NULL, reason TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, started_at INTEGER NOT NULL,
      turn_count INTEGER NOT NULL, max_turns INTEGER NOT NULL, max_minutes INTEGER NOT NULL,
      last_continue_at INTEGER, last_assistant_hash TEXT
    );
    INSERT INTO goals VALUES ('thr_sentinel', 'test', 'complete', NULL, 1, 1, 1, 0, 0, 0, NULL, NULL);`);
  plugin(host.bb);
  db.prepare(
    `UPDATE goals SET thread_id = ?, status = 'active', max_workers = ?, last_continue_at = ?,
       verify_enabled = 0, progress_update_minutes = 0 WHERE thread_id = 'thr_sentinel'`,
  ).run(rootId, maxWorkers, Date.now());
  const items = createItemStore(host.bb);
  const settle = async (rounds = 80): Promise<void> => {
    for (let n = 0; n < rounds; n += 1) await new Promise<void>((r) => setImmediate(r));
  };
  const one = <T,>(sql: string, ...params: unknown[]): T | undefined =>
    db.prepare(sql).get(...params) as T | undefined;
  return {
    host, db, rootId, items, settle, stopped, spawns,
    spawnCalls: () => spawnCalls,
    spawnsFor: (itemId: string) => spawns.filter((spawn) => spawn.itemId === itemId),
    pulse: (from: FakePluginHost = host) =>
      drain(from.harness.behavior.runService("progress-pulse"), settle),
    emitIdle: async (threadId: string, text = "") => {
      await host.harness.behavior.emitThreadEvent("thread.idle", {
        thread: thread(threadId, "idle"),
        lastAssistantText: text,
      } as never);
      await settle(80);
    },
    add(step: string, status: "pending" | "in_progress", files: string[]) {
      const item = items.add(rootId, step, status, { files, deps: [], check: null });
      if (!item) throw new Error(`could not create ${step}`);
      return item;
    },
    own(threadId: string, itemId: string | null, role = "worker") {
      db.prepare(
        `INSERT INTO collab_agents (thread_id, root_thread_id, parent_thread_id, task_name, created_at,
           display_name, item_id, role) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(threadId, rootId, rootId, `/root/${threadId}`, Date.now(), `Worker ${threadId}`, itemId, role);
    },
    status: (threadId: string, value: string) => statuses.set(threadId, value),
    event: (threadId: string, row: EventRow) =>
      events.set(threadId, [...(events.get(threadId) ?? []), row]),
    itemStatus: (itemId: string) =>
      one<{ status: string }>("SELECT status FROM goal_items WHERE id = ?", itemId)?.status,
    owners: () =>
      db.prepare(
        `SELECT thread_id, item_id FROM collab_agents WHERE root_thread_id = ? AND retired_at IS NULL
           AND COALESCE(role, 'worker') != 'verifier' ORDER BY thread_id`,
      ).all(rootId) as Array<{ thread_id: string; item_id: string | null }>,
    generation: () =>
      one<{ requested_seq: number; serviced_seq: number }>(
        "SELECT requested_seq, serviced_seq FROM collab_scheduler_generations WHERE root_thread_id = ?",
        rootId,
      ),
    attempt: (itemId: string) =>
      one<{
        attempt_count: number;
        next_due_at: number | null;
        last_attempt_at: number;
        blocked_at: number | null;
      }>(
        "SELECT attempt_count, next_due_at, last_attempt_at, blocked_at FROM collab_launch_attempts WHERE root_thread_id = ? AND item_id = ?",
        rootId,
        itemId,
      ),
    failSpawn: (message: string | null) => {
      spawnFailure = message;
    },
    failStop: (message: string | null) => {
      stopFailure = message;
    },
    failEventRead: () => {
      eventReadFails = true;
    },
    holdSpawn: () => {
      gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });
    },
    releaseSpawn: () => {
      openGate?.();
      gate = null;
      openGate = null;
    },
    trigger: (item: { id: string; step: string }) =>
      host.harness.behavior.callAgentTool(
        "ultragoal_patch",
        { plan: [{ id: item.id, step: item.step, status: "pending" }], remove_item_ids: [] },
        { threadId: rootId },
      ),
  };
}

describe("scheduler convergence (real plugin lifecycle)", () => {
  it("staffs four eligible disjoint slices under free capacity exactly once each", async () => {
    const f = liveGoal("thr_s1", 6);
    const created = [0, 1, 2, 3].map((n) =>
      f.add(`Slice: independent repair ${n}`, "pending", [`src/independent-${n}.ts`]),
    );
    await f.pulse();
    assert.equal(f.spawnCalls(), 4, "four disjoint slices under free capacity are staffed once each");
    for (const item of created) {
      assert.equal(f.spawnsFor(item.id).length, 1, `${item.id} may not be staffed twice`);
      assert.equal(f.itemStatus(item.id), "in_progress");
    }
    assert.equal(f.owners().length, 4, "one durable owner per slice");
  });

  it("retains ownership and capacity on ordinary idle with no stop evidence", async () => {
    const f = liveGoal("thr_s2", 3);
    const item = f.add("Slice: ordinary idle", "pending", ["src/idle.ts"]);
    await f.pulse();
    const worker = f.owners()[0]!.thread_id;
    f.status(worker, "idle");
    f.event(worker, { seq: 1, type: "client/turn/requested", data: { requestId: "req_idle" } });
    f.event(worker, { seq: 2, type: "turn/input/accepted", data: { clientRequestId: "req_idle" } });
    f.event(worker, { seq: 3, type: "turn/completed", data: { status: "completed" } });
    await f.emitIdle(worker, "Still working this slice.");
    assert.equal(f.spawnCalls(), 1, "ordinary idle must not staff a replacement");
    assert.equal(f.spawnsFor(item.id).length, 1);
    assert.deepEqual(f.owners().map((row) => row.thread_id), [worker]);
  });

  it("releases a reliable stop and an abort-before-acceptance exactly once each", async () => {
    const f = liveGoal("thr_s3", 2);
    const aborted = f.add("Slice: aborted before acceptance", "in_progress", ["src/abort.ts"]);
    const held = f.add("Slice: stopped after acceptance", "in_progress", ["src/stop.ts"]);
    f.own("thr_abort", aborted.id);
    f.own("thr_stop", held.id);
    f.status("thr_abort", "idle");
    f.status("thr_stop", "idle");
    f.event("thr_abort", { seq: 1, type: "client/turn/requested", data: { requestId: "req_a" } });
    f.event("thr_abort", { seq: 2, type: "system/thread/interrupted", data: { reason: "manual-stop" } });
    f.event("thr_stop", { seq: 1, type: "client/turn/requested", data: { requestId: "req_s" } });
    f.event("thr_stop", { seq: 2, type: "turn/input/accepted", data: { clientRequestId: "req_s" } });
    f.event("thr_stop", { seq: 3, type: "system/thread/interrupted", data: { reason: "manual-stop" } });
    await f.emitIdle("thr_abort", "Stopped before the provider accepted the turn.");
    await f.emitIdle("thr_stop", "Stopped after the provider accepted the turn.");
    for (const item of [aborted, held]) {
      assert.equal(f.spawnsFor(item.id).length, 1, `${item.id} is requeued and restaffed once`);
      assert.equal(f.itemStatus(item.id), "in_progress");
    }
    assert.equal(f.owners().length, 2, "exactly one live owner per released slice");
    for (const retired of ["thr_abort", "thr_stop"]) {
      assert.equal(f.owners().some((row) => row.thread_id === retired), false);
      assert.ok(f.db.prepare("SELECT retired_at FROM collab_agents WHERE thread_id = ?").get(retired));
    }
    await f.emitIdle("thr_abort", "Stopped before the provider accepted the turn.");
    assert.equal(f.spawnsFor(aborted.id).length, 1, "a duplicate stop releases once");
    assert.equal(f.owners().length, 2, "a duplicate stop leaves the owner count alone");
  });

  it("quarantines stop-pending and unavailable-evidence workers", async () => {
    const f = liveGoal("thr_s4", 2);
    const pending = f.add("Slice: stop still settling", "in_progress", ["src/pending.ts"]);
    const unreadable = f.add("Slice: unreadable evidence", "in_progress", ["src/unreadable.ts"]);
    f.own("thr_pending", pending.id);
    f.own("thr_unreadable", unreadable.id);
    f.status("thr_pending", "stopping");
    f.status("thr_unreadable", "idle");
    f.event("thr_pending", { seq: 1, type: "client/turn/requested", data: { requestId: "req_p" } });
    f.event("thr_pending", { seq: 2, type: "system/thread/interrupted", data: { reason: "manual-stop" } });
    f.failEventRead();
    await f.emitIdle("thr_pending", "Stopping.");
    await f.emitIdle("thr_unreadable", "Worker went quiet.");
    assert.equal(f.spawnCalls(), 0, "neither a settling stop nor unreadable evidence is replaced");
    assert.equal(f.itemStatus(pending.id), "in_progress");
    assert.equal(f.itemStatus(unreadable.id), "in_progress");
    assert.deepEqual(
      f.owners().map((row) => row.thread_id),
      ["thr_pending", "thr_unreadable"],
      "both quarantined workers keep their slot",
    );
  });

  it("walks a failed launch 15s/1m/5m into a durable blocked record", async () => {
    const f = liveGoal("thr_s5", 1);
    const item = f.add("Slice: transiently unlaunchable", "pending", ["src/flaky.ts"]);
    f.failSpawn("threads.spawn refused the launch");
    const t0 = 1_800_000_000_000;
    const at = async (ms: number) => {
      Date.now = () => t0 + ms;
      await f.pulse();
    };
    await at(0);
    assert.equal(f.spawnCalls(), 1, "the initial attempt fires immediately");
    assert.equal(f.itemStatus(item.id), "pending", "a failed launch rolls the slice back");
    assert.deepEqual(f.owners(), [], "a confirmed failed attempt leaves no live row");
    assert.deepEqual(
      f.db.prepare("SELECT item_id FROM collab_item_reservations WHERE root_thread_id = ?").all("thr_s5"),
      [],
      "a confirmed failed attempt releases its reservation",
    );
    assert.equal(f.attempt(item.id)?.attempt_count, 1);
    assert.ok(
      f.attempt(item.id)!.next_due_at! - f.attempt(item.id)!.last_attempt_at >= 15_000,
      "the 15 second retry is scheduled durably",
    );
    await at(8_000);
    assert.equal(f.spawnCalls(), 1, "no retry before the 15 second floor");
    await at(20_000);
    await at(20_000);
    assert.equal(f.spawnCalls(), 2, "the 15 second retry fires once, however many triggers arrive");
    await at(90_000);
    assert.equal(f.spawnCalls(), 3, "the 1 minute retry fires");
    await at(390_000);
    assert.equal(f.spawnCalls(), 4, "the 5 minute retry fires");
    await at(1_500_000);
    await at(2_100_000);
    assert.equal(f.spawnCalls(), 4, "exhaustion is bounded: no fifth attempt, ever");
    assert.equal(f.attempt(item.id)?.attempt_count, 4);
    assert.ok(f.attempt(item.id)?.blocked_at != null, "exhaustion produces a durable launch block");
    assert.equal(f.itemStatus(item.id), "pending");
    const reloaded = await reloadHost(f.host);
    Date.now = () => t0 + 2_700_000;
    await f.pulse(reloaded);
    assert.equal(f.spawnCalls(), 4, "a reload may not reset an exhausted attempt generation");
    const liveDb = reloaded.bb.storage.database();
    assert.equal(
      (liveDb.prepare("SELECT status FROM goal_items WHERE id = ?").get(item.id) as { status: string }).status,
      "pending",
      "the exhausted slice stays blocked across a plugin generation",
    );
    assert.ok(
      liveDb
        .prepare("SELECT blocked_at FROM collab_launch_attempts WHERE root_thread_id = ? AND item_id = ?")
        .get("thr_s5", item.id),
      "the launch-blocked record survives the reload",
    );
  });

  it("records an overlapping trigger durably and services it with one follow-up pass", async () => {
    const f = liveGoal("thr_s6", 3);
    for (const n of [0, 1]) {
      const held = f.add(`Slice: held ${n}`, "in_progress", [`src/held-${n}.ts`]);
      f.own(`thr_held_${n}`, held.id);
      f.status(`thr_held_${n}`, "active");
    }
    const ready = [
      f.add("Slice: ready A", "pending", ["src/ready-a.ts"]),
      f.add("Slice: ready B", "pending", ["src/ready-b.ts"]),
    ];
    // The first pass can only afford one spawn; it is held open while the
    // capacity the second slice waits on becomes free.
    f.holdSpawn();
    const first = f.trigger(ready[0]!);
    await f.settle(20);
    assert.equal(f.spawnCalls(), 1, "the first pass is in flight inside its one spawn");
    f.db
      .prepare(
        `UPDATE collab_agents SET retired_at = ?
         WHERE root_thread_id = 'thr_s6' AND thread_id = 'thr_held_0'`,
      )
      .run(Date.now());
    f.db.prepare("UPDATE goal_items SET status = 'completed' WHERE step = 'Slice: held 0'").run();
    await f.trigger(ready[1]!);
    await f.settle(40);
    const dirty = f.generation();
    assert.ok(dirty, "an overlapping trigger is recorded durably, not dropped");
    assert.ok(
      dirty!.requested_seq > dirty!.serviced_seq,
      `a trigger during a pass owes a follow-up: ${JSON.stringify(dirty)}`,
    );
    f.releaseSpawn();
    await first;
    await f.settle(200);
    assert.equal(f.spawnCalls(), 2, "capacity freed during the pass is serviced by the follow-up");
    for (const item of ready) {
      assert.equal(f.spawnsFor(item.id).length, 1, `${item.id} is staffed exactly once`);
    }
    assert.equal(f.owners().length, 3, "three owners, no duplicates");
    const serviced = f.generation()!;
    assert.equal(serviced.serviced_seq, serviced.requested_seq, "every requested generation is serviced");
  });

  it("requeues an explicit release, refuses a failed stop, and keeps the fence across a reload", async () => {
    const f = liveGoal("thr_s7", 1);
    const item = f.add("Slice: releasable", "pending", ["src/releasable.ts"]);
    await f.pulse();
    const owner = f.owners()[0]!.thread_id;
    assert.equal(f.spawnsFor(item.id).length, 1);
    f.status(owner, "idle");
    const released = await f.host.harness.behavior.runCli(["release", owner, "--thread", "thr_s7"]);
    await f.settle(120);
    assert.equal(released.exitCode, 0, released.stderr ?? "");
    assert.equal(f.spawnsFor(item.id).length, 2, "the released slice is requeued and restaffed once");
    assert.equal(f.itemStatus(item.id), "in_progress");
    const next = f.owners()[0]!.thread_id;
    assert.notEqual(next, owner);
    // A stop that fails must refuse: no retirement, no requeue, no replacement.
    f.status(next, "idle");
    f.failStop("threads.stop refused the stop");
    const refused = await f.host.harness.behavior.runCli(["release", next, "--thread", "thr_s7"]);
    await f.settle(40);
    assert.notEqual(refused.exitCode, 0, "a failed stop may not report a successful release");
    assert.equal(f.stopped.includes(next), true, "the stop was attempted");
    assert.equal(f.itemStatus(item.id), "in_progress", "a failed stop quarantines the slice");
    assert.deepEqual(f.owners().map((row) => row.thread_id), [next], "a failed stop retains the durable owner row");
    const reloaded = await reloadHost(f.host);
    const fence = createItemReservationStore(reloaded.bb.storage.database());
    assert.equal(fence.isHeld("thr_s7", item.id), true, "the live owner still holds its slice");
    assert.equal(
      fence.acquire("thr_s7", "itm_other", 1),
      null,
      "a reloaded generation cannot reserve the slot its durable owner occupies",
    );
  });
});
