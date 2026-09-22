import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  createFindingStore,
  findingRegistrationCliMessage,
  findingRegistrationOutcome,
} from "./findings.ts";
import {
  MAX_BASE_REF_CHARS,
  goalFindingBaseRefSchema,
  goalFindingSchema,
} from "../contract.js";

const hosts: FakePluginHost[] = [];
afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()!.harness.lifecycle.dispose();
});

function freshFindings() {
  const host = createFakePluginHost({ pluginId: `findings-test-${hosts.length}` });
  hosts.push(host);
  host.bb.storage.database().exec(`CREATE TABLE goal_findings (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      title TEXT NOT NULL,
      file TEXT NOT NULL,
      evidence TEXT NOT NULL,
      status TEXT NOT NULL,
      item_id TEXT,
      resolution_note TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      fix_files TEXT,
      check_cmd TEXT,
      project_id TEXT,
      UNIQUE(thread_id, fingerprint)
    )
  `);
  return createFindingStore(host.bb);
}

describe("finding registration reporting", () => {
  it("reports a scheduler-staffed fix slice when one was linked", () => {
    assert.deepEqual(findingRegistrationOutcome("fnd_1", "itm_1"), {
      status: "new",
      finding_id: "fnd_1",
      fix_item_id: "itm_1",
    });
    assert.match(findingRegistrationCliMessage("fnd_1", "itm_1"), /fix slice itm_1 assigned/);
  });

  it("reports cap-exceeded findings as recorded but unstaffed", () => {
    const outcome = findingRegistrationOutcome("fnd_2", null);
    assert.equal(outcome.status, "recorded_unstaffed");
    assert.equal(outcome.fix_item_id, null);
    assert.match(outcome.note ?? "", /durably queued/);
    const message = findingRegistrationCliMessage("fnd_2", null);
    assert.doesNotMatch(message, /null staffed/);
    assert.match(message, /queued without a fix slice/);
  });
});

describe("filing warns when a slice has no gate", () => {
  it("says nothing extra when a check was supplied", () => {
    const msg = findingRegistrationCliMessage("fnd_1", "itm_1", true);
    assert.match(msg, /fix slice itm_1 assigned/);
    assert.doesNotMatch(msg, /nothing gates/);
  });

  it("tells the filer their slice can close unverified, and how to fix it", () => {
    // A minted slice with no check can be closed with nothing proving the
    // defect gone, and the filer is the only one who knows the command.
    const msg = findingRegistrationCliMessage("fnd_1", "itm_1", false);
    assert.match(msg, /nothing gates its completion/);
    assert.match(msg, /bb ultragoal item itm_1 --check/);
  });

  it("stays quiet about checks when no slice was minted at all", () => {
    assert.match(findingRegistrationCliMessage("fnd_1", null, false), /without a fix slice/);
  });
});

describe("a completed slice cannot claim a fix is live", () => {
  it("leaves a linked finding open when the closure attests nothing for it", () => {
    // The slice finished; the defect did not. This stamped EVERY open finding
    // linked to the item, so an unlanded or cross-repo fix was recorded as
    // closed the moment its item completed. The only undo, reopenForFailed
    // Integration, fires on a merge failure — and work that was never on this
    // repository's integration path can never produce one.
    const findings = freshFindings();
    const rec = findings.report("thr_g", { title: "t", file: "a.ts:1", evidence: "e" });
    findings.linkItem("thr_g", rec.finding.id, "itm_1");
    assert.equal(findings.markAttestedByItem("thr_g", "itm_1", "slice reported done", []), 0);
    assert.equal(findings.get("thr_g", rec.finding.id)?.status, "open");
  });

  it("closes exactly the findings the completion attests", () => {
    // A blank proof is not an attestation: a caller that passes the id and no
    // evidence must not be able to bypass the guard with an empty string.
    const findings = freshFindings();
    const attested = findings.report("thr_g", { title: "attested", file: "a.ts:1", evidence: "e" });
    const silent = findings.report("thr_g", { title: "silent", file: "b.ts:1", evidence: "e" });
    findings.linkItem("thr_g", attested.finding.id, "itm_1");
    findings.linkItem("thr_g", silent.finding.id, "itm_1");
    const closed = findings.markAttestedByItem("thr_g", "itm_1", "n", [
      { findingId: attested.finding.id, proof: "npm test -- a passed" },
      { findingId: silent.finding.id, proof: "   " },
    ]);
    assert.equal(closed, 1);
    assert.equal(findings.get("thr_g", attested.finding.id)?.status, "fixed_unverified");
    assert.equal(findings.get("thr_g", silent.finding.id)?.status, "open");
  });

  it("records a completion's closure as attested, never as a landed fix", () => {
    // THE defect: a slice completing is not a fix being live. This worker
    // attested its defect, so the slice closes — but nothing has shown the fix
    // is in the repository the running install consumes, and for an unlanded or
    // cross-repo fix nothing ever will. `fixed` is reserved for a shown landing.
    const findings = freshFindings();
    const rec = findings.report("thr_g", { title: "Cross-repo defect", file: "lib/collab.ts:1", evidence: "e" });
    findings.linkItem("thr_g", rec.finding.id, "itm_1");
    assert.equal(
      findings.markAttestedByItem("thr_g", "itm_1", "worker reported done", [
        { findingId: rec.finding.id, proof: "the plugin PR is open" },
      ]),
      1,
    );
    assert.equal(findings.get("thr_g", rec.finding.id)?.status, "fixed_unverified");
    assert.equal(findings.counts("thr_g").fixed, 0);
    assert.equal(findings.counts("thr_g").fixedUnverified, 1);
  });

  it("promotes an attested finding only when the landing is shown", () => {
    const findings = freshFindings();
    const rec = findings.report("thr_g", { title: "t", file: "a.ts:1", evidence: "e" });
    findings.linkItem("thr_g", rec.finding.id, "itm_1");
    findings.markAttestedByItem("thr_g", "itm_1", "n", [{ findingId: rec.finding.id, proof: "p" }]);

    assert.equal(findings.confirmLandedByItem("thr_g", "itm_1", "squash-merged into integration"), 1);
    assert.equal(findings.get("thr_g", rec.finding.id)?.status, "fixed");
    // Idempotent: a second integration pass has nothing left to promote.
    assert.equal(findings.confirmLandedByItem("thr_g", "itm_1", "again"), 0);
  });
});

describe("a fix that never reached the base branch", () => {
  it("reopens findings this slice closed, because the fix is provably not there", () => {
    // Closure happens on the worker's report, BEFORE the merge is attempted.
    // A genuine integration failure used to leave the register asserting a fix
    // that does not exist anywhere main will ship.
    const findings = freshFindings();
    const rec = findings.report("thr_g", { title: "t", file: "a.ts:1", evidence: "e" });
    findings.linkItem("thr_g", rec.finding.id, "itm_1");
    findings.markAttestedByItem("thr_g", "itm_1", "worker said so", [
      { findingId: rec.finding.id, proof: "the fix is on the slice branch" },
    ]);
    assert.equal(findings.get("thr_g", rec.finding.id)?.status, "fixed_unverified");

    const reopened = findings.reopenForFailedIntegration("thr_g", "itm_1", "merge conflict");
    assert.equal(reopened, 1);
    assert.equal(findings.get("thr_g", rec.finding.id)?.status, "open");
  });

  it("never overturns a dismissal, which was a judgement about the defect", () => {
    const findings = freshFindings();
    const rec = findings.report("thr_g", { title: "t", file: "a.ts:1", evidence: "e" });
    findings.linkItem("thr_g", rec.finding.id, "itm_1");
    findings.resolve("thr_g", rec.finding.id, "dismissed", "not a real defect");
    assert.equal(findings.reopenForFailedIntegration("thr_g", "itm_1", "merge conflict"), 0);
    assert.equal(findings.get("thr_g", rec.finding.id)?.status, "dismissed");
  });

  it("touches only the slice that failed", () => {
    const findings = freshFindings();
    const mine = findings.report("thr_g", { title: "mine", file: "a.ts:1", evidence: "e" });
    const other = findings.report("thr_g", { title: "other", file: "b.ts:1", evidence: "e" });
    findings.linkItem("thr_g", mine.finding.id, "itm_1");
    findings.linkItem("thr_g", other.finding.id, "itm_2");
    findings.markAttestedByItem("thr_g", "itm_1", "n", [{ findingId: mine.finding.id, proof: "p1" }]);
    findings.markAttestedByItem("thr_g", "itm_2", "n", [{ findingId: other.finding.id, proof: "p2" }]);
    findings.reopenForFailedIntegration("thr_g", "itm_1", "conflict");
    assert.equal(findings.get("thr_g", mine.finding.id)?.status, "open");
    assert.equal(findings.get("thr_g", other.finding.id)?.status, "fixed_unverified");
  });

  it("leaves an already-present slice closed, since its work IS on the branch", () => {
    // 0.25.3: "Already up to date (nothing to squash)" records as integrated,
    // so this reopen path must never run for it. It stays attested rather than
    // fixed on purpose: a branch that adds no work HERE cannot show that THIS
    // slice landed the fix, which is the unlanded and cross-repo case.
    const findings = freshFindings();
    const rec = findings.report("thr_g", { title: "t", file: "a.ts:1", evidence: "e" });
    findings.linkItem("thr_g", rec.finding.id, "itm_1");
    findings.markAttestedByItem("thr_g", "itm_1", "n", [
      { findingId: rec.finding.id, proof: "already on the branch" },
    ]);
    assert.equal(findings.get("thr_g", rec.finding.id)?.status, "fixed_unverified");
  });

  it("reopens an attested closure too, because it was never shown to land", () => {
    // The merge failed, so the fix is provably not on the base branch — and an
    // attested closure carried no landing evidence to begin with.
    const findings = freshFindings();
    const rec = findings.report("thr_g", { title: "t", file: "a.ts:1", evidence: "e" });
    findings.linkItem("thr_g", rec.finding.id, "itm_1");
    findings.markAttestedByItem("thr_g", "itm_1", "n", [{ findingId: rec.finding.id, proof: "p" }]);
    assert.equal(findings.reopenForFailedIntegration("thr_g", "itm_1", "merge conflict"), 1);
    assert.equal(findings.counts("thr_g").fixedUnverified, 0);
    assert.equal(findings.get("thr_g", rec.finding.id)?.status, "open");
  });

  it("reopens an already-promoted fix, so a legacy `fixed` row is not stranded", () => {
    // `fixed` is reachable from a confirmed landing (and from every row a
    // pre-upgrade register still holds). A later integration failure must undo
    // it exactly as it undoes an attested one, or the register keeps the
    // strongest claim in the presence of proof it is wrong.
    const findings = freshFindings();
    const rec = findings.report("thr_g", { title: "t", file: "a.ts:1", evidence: "e" });
    findings.linkItem("thr_g", rec.finding.id, "itm_1");
    findings.markAttestedByItem("thr_g", "itm_1", "n", [{ findingId: rec.finding.id, proof: "p" }]);
    findings.confirmLandedByItem("thr_g", "itm_1", "landed");
    assert.equal(findings.get("thr_g", rec.finding.id)?.status, "fixed");

    assert.equal(findings.reopenForFailedIntegration("thr_g", "itm_1", "merge conflict"), 1);
    assert.equal(findings.get("thr_g", rec.finding.id)?.status, "open");
    assert.equal(findings.counts("thr_g").fixed, 0);
  });
});

describe("finding project provenance", () => {
  it("records the filing project and exposes it for staffing", () => {
    // Staffing cuts the worker environment from the GOAL's project, so it needs
    // the FILING thread's project to compare against. Read host-side from the
    // thread, never from the agent's text: a model that can name its own repo
    // can defeat the refusal it exists to trigger.
    const findings = freshFindings();
    findings.report("thr_g", {
      title: "Cross-repo defect",
      file: "lib/collab.ts:750",
      evidence: "Exists only in the plugin repository.",
      projectId: "proj_ultragoal",
    });
    assert.equal(findings.remediationQueue("thr_g")[0]?.projectId, "proj_ultragoal");
  });

  it("leaves provenance null for a filing thread that named no project", () => {
    // 170 live findings predate the column. Absent provenance must read as
    // "unknown", never "elsewhere", or the guard refuses the whole backlog.
    const findings = freshFindings();
    findings.report("thr_g", { title: "Legacy", file: "a.ts:1", evidence: "e" });
    assert.equal(findings.remediationQueue("thr_g")[0]?.projectId, null);
  });

  it("keeps provenance on a duplicate fingerprint rather than overwriting it", () => {
    // A re-sweep from another checkout must not silently re-home an existing
    // finding: the first filer's project is what the fix slice was cut for.
    const findings = freshFindings();
    const first = findings.report("thr_g", {
      title: "Same defect",
      file: "a.ts:1",
      evidence: "e",
      projectId: "proj_first",
    });
    const again = findings.report("thr_g", {
      title: "Same defect",
      file: "a.ts:2",
      evidence: "e",
      projectId: "proj_second",
    });
    assert.equal(again.created, false);
    assert.equal(findings.remediationQueue("thr_g")[0]?.projectId, "proj_first");
    assert.equal(findings.remediationQueue("thr_g")[0]?.id, first.finding.id);
  });
});

describe("the resolved PR head a finding names", () => {
  it("persists baseRef trim-only and round-trips it", () => {
    // No tracker client exists here, so the filer resolved the ref and the
    // register stores exactly that ref — never a PR number or URL to resolve.
    const findings = freshFindings();
    const rec = findings.report("thr_g", {
      title: "Defect on the PR branch", file: "a.ts:1", evidence: "e", baseRef: "  PR/Fix-58-Head  ",
    });
    assert.equal(rec.finding.baseRef, "PR/Fix-58-Head");
    assert.equal(findings.get("thr_g", rec.finding.id)?.baseRef, "PR/Fix-58-Head");
    assert.equal(findings.list("thr_g")[0]?.baseRef, "PR/Fix-58-Head");
    assert.equal(findings.remediationQueue("thr_g")[0]?.baseRef, "PR/Fix-58-Head");
  });

  it("leaves baseRef null when the filer named no PR", () => {
    // Absent must read as "none", never as a ref something should resolve.
    const findings = freshFindings();
    const rec = findings.report("thr_g", { title: "No PR", file: "a.ts:1", evidence: "e" });
    assert.equal(rec.finding.baseRef, null);
    assert.equal(findings.get("thr_g", rec.finding.id)?.baseRef, null);
    assert.equal(findings.remediationQueue("thr_g")[0]?.baseRef, null);
  });

  it("parses a GoalFinding object recorded before the field existed", () => {
    // Additive and never defaulted, so pre-change objects keep parsing.
    const legacy = goalFindingSchema.safeParse({
      id: "fnd_legacy", fingerprint: "fp", title: "Legacy", file: "a.ts:1",
      evidence: "e", status: "open", itemId: null, createdAt: 1,
    });
    assert.ok(legacy.success);
    assert.equal(legacy.data.baseRef, undefined);
    assert.equal(goalFindingSchema.safeParse({ ...legacy.data, baseRef: null }).success, true);
  });

  it("refuses a non-ref-shaped baseRef, naming what to supply instead", () => {
    // Resolving a PR number or URL needs a tracker client this plugin
    // deliberately lacks, so the shape is refused at the one recording boundary.
    for (const ref of [
      "https://github.com/uje-m/bb-plugin-ultragoal/pull/58", "pr 58 head",
      "-pr/58-head", "pr/../58-head", "58",
    ]) {
      const parsed = goalFindingBaseRefSchema.safeParse(ref);
      assert.equal(parsed.success, false, `${ref} must be refused`);
      assert.match(parsed.error?.issues[0]?.message ?? "", /head branch or head SHA/);
    }
    // The fail-closed length bound refuses before the shape refine is reached.
    assert.equal(goalFindingBaseRefSchema.safeParse("a".repeat(MAX_BASE_REF_CHARS + 1)).success, false);
  });

  it("accepts a branch name, a hex SHA, and the empty placeholder", () => {
    for (const ref of ["pr/58-head", "fix/R4-finding-baseref", "a1b2c3d",
      "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0", "a".repeat(MAX_BASE_REF_CHARS)]) {
      assert.equal(goalFindingBaseRefSchema.safeParse(ref).success, true, `${ref} must be accepted`);
    }
    // Deliberate: a legacy or placeholder Finding carrying "" keeps parsing;
    // non-empty is the filing boundary's rule, not the shape's.
    assert.equal(goalFindingBaseRefSchema.safeParse("").success, true);
  });

  it("adds the column to a table that predates it, at store creation", () => {
    // freshFindings' CREATE TABLE is the pre-column register; the store owns
    // the self-heal (worker-brief precedent), not lib/store.ts's positional
    // migration list.
    const findings = freshFindings();
    const db = hosts[hosts.length - 1]!.bb.storage.database();
    const columns = (db.prepare("PRAGMA table_info(goal_findings)").all() as Array<{ name: string }>)
      .map((column) => column.name);
    assert.equal(columns.includes("base_ref"), true);
    const rec = findings.report("thr_g", { title: "Self-healed", file: "a.ts:1", evidence: "e", baseRef: "pr/58-head" });
    assert.equal(findings.get("thr_g", rec.finding.id)?.baseRef, "pr/58-head");
  });
});
