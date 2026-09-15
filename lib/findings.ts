import { createHash } from "node:crypto";
import { verifyAttribution, type CommitResolver } from "./attribution.js";
import { missingLinkedDefectEvidenceIds, type FindingAffirmativeEvidence } from "./finding-brief.js";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { GoalFinding, GoalFindingStatus } from "../contract.js";

interface FindingRow {
  id: string;
  thread_id: string;
  fingerprint: string;
  title: string;
  file: string;
  evidence: string;
  status: GoalFindingStatus;
  item_id: string | null;
  resolution_note: string | null;
  fix_files: string | null;
  check_cmd: string | null;
  /** BB project the FILING thread stood in; null on pre-column rows. */
  project_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface FindingRegistrationOutcome {
  status: "new" | "recorded_unstaffed";
  finding_id: string;
  fix_item_id: string | null;
  note?: string;
}

export interface RemediationFinding extends GoalFinding {
  fixFiles: string[];
  check: string | null;
  /**
   * The project the finding was filed from, when the filing thread named one.
   * Staffing compares it against the project the worker environment is cut
   * from; null means "unknown", never "elsewhere".
   */
  projectId: string | null;
}

/**
 * Describe a newly recorded finding without claiming the scheduler assigned
 * a work item when remediation capacity deliberately kept it waiting.
 */
export function findingRegistrationOutcome(
  findingId: string,
  fixItemId: string | null,
): FindingRegistrationOutcome {
  if (fixItemId) {
    return { status: "new", finding_id: findingId, fix_item_id: fixItemId };
  }
  return {
    status: "recorded_unstaffed",
    finding_id: findingId,
    fix_item_id: null,
    note: "Finding is durably queued without a fix slice because remediation capacity is full; UltraGoal assigns it automatically when capacity opens.",
  };
}

export function findingRegistrationCliMessage(
  findingId: string,
  fixItemId: string | null,
  /** Whether the filer supplied a command that can gate the slice's closure. */
  hasCheck = true,
): string {
  if (fixItemId) {
    // Say it at filing time. A slice minted without a check can be closed with
    // nothing verifying it, and the filer is the only one who knows what
    // command would have proved the defect gone.
    const gate = hasCheck
      ? ""
      : ` No --check was supplied, so nothing gates its completion; re-file the command with 'bb ultragoal item ${fixItemId} --check "<cmd>"' if one exists.`;
    return `Finding ${findingId} registered; fix slice ${fixItemId} assigned by the scheduler.${gate}`;
  }
  return `Finding ${findingId} queued without a fix slice: remediation capacity is full; UltraGoal will assign it automatically.`;
}

// The seen-set key: same file + same defect statement is the same finding,
// however a re-sweep phrases the details. Line numbers shift between sweeps,
// so they are stripped from the file part.
export function fingerprintOf(file: string, title: string): string {
  const normalizedFile = file.trim().toLowerCase().replace(/[:#]\d+([-:]\d+)?$/, "");
  const normalizedTitle = title.trim().toLowerCase().replace(/\s+/g, " ").replace(/\d+/g, "#");
  return createHash("sha1").update(`${normalizedFile}|${normalizedTitle}`).digest("hex").slice(0, 16);
}

function rowToFinding(row: FindingRow): GoalFinding {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    title: row.title,
    file: row.file,
    evidence: row.evidence,
    status: row.status,
    itemId: row.item_id,
    createdAt: row.created_at,
  };
}

function parseList(json: string | null): string[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function rowToRemediation(row: FindingRow): RemediationFinding {
  const finding = rowToFinding(row);
  const fixFiles = parseList(row.fix_files);
  return {
    ...finding,
    fixFiles: fixFiles.length > 0
      ? fixFiles
      : [row.file.trim().replace(/[:#]\d+([-:]\d+)?$/, "")].filter(Boolean),
    check: row.check_cmd?.trim() || null,
    projectId: row.project_id?.trim() || null,
  };
}

function newId(): string {
  return `fnd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createFindingStore(bb: BbPluginApi) {
  const db = bb.storage.database();
  const byThread = db.prepare(
    "SELECT * FROM goal_findings WHERE thread_id = ? ORDER BY created_at ASC, id ASC",
  );
  const byFingerprint = db.prepare(
    "SELECT * FROM goal_findings WHERE thread_id = ? AND fingerprint = ?",
  );
  const byId = db.prepare("SELECT * FROM goal_findings WHERE thread_id = ? AND id = ?");
  const byItem = db.prepare("SELECT * FROM goal_findings WHERE thread_id = ? AND item_id = ?");
  const insert = db.prepare(`
    INSERT INTO goal_findings (
      id, thread_id, fingerprint, title, file, evidence, status, item_id,
      resolution_note, fix_files, check_cmd, project_id, created_at, updated_at
    ) VALUES (
      @id, @thread_id, @fingerprint, @title, @file, @evidence, @status, @item_id,
      @resolution_note, @fix_files, @check_cmd, @project_id, @created_at, @updated_at
    )
  `);
  const setStatus = db.prepare(`
    UPDATE goal_findings
    SET status = @status, resolution_note = @resolution_note, updated_at = @updated_at
    WHERE thread_id = @thread_id AND id = @id
  `);
  const setItem = db.prepare(
    "UPDATE goal_findings SET item_id = @item_id, updated_at = @updated_at WHERE thread_id = @thread_id AND id = @id AND status = 'open' AND item_id IS NULL",
  );
  const moveItem = db.prepare(
    "UPDATE goal_findings SET item_id = @item_id, updated_at = @updated_at WHERE thread_id = @thread_id AND id = @id AND status = 'open' AND item_id = @from_item_id",
  );
  const clearItem = db.prepare(
    "UPDATE goal_findings SET item_id = NULL, updated_at = @updated_at WHERE thread_id = @thread_id AND id = @id AND status = 'open'",
  );
  const clearStmt = db.prepare("DELETE FROM goal_findings WHERE thread_id = ?");

  return {
    /** Records a finding; a repeat fingerprint returns the existing one instead. */
    report(
      threadId: string,
      input: {
        title: string;
        file: string;
        evidence: string;
        fixFiles?: string[];
        check?: string | null;
        /**
         * Project the filing thread stood in, resolved by the caller from the
         * host — never from the agent's own description of where it works.
         */
        projectId?: string | null;
      },
    ): { created: boolean; finding: GoalFinding } {
      const fingerprint = fingerprintOf(input.file, input.title);
      const existing = byFingerprint.get(threadId, fingerprint) as FindingRow | undefined;
      if (existing) return { created: false, finding: rowToFinding(existing) };
      const now = Date.now();
      const row: FindingRow = {
        id: newId(),
        thread_id: threadId,
        fingerprint,
        title: input.title.trim(),
        file: input.file.trim(),
        evidence: input.evidence.trim(),
        status: "open",
        item_id: null,
        resolution_note: null,
        fix_files:
          input.fixFiles && input.fixFiles.length > 0
            ? JSON.stringify([...new Set(input.fixFiles.map((file) => file.trim()).filter(Boolean))])
            : null,
        check_cmd: input.check?.trim() || null,
        project_id: input.projectId?.trim() || null,
        created_at: now,
        updated_at: now,
      };
      insert.run(row);
      return { created: true, finding: rowToFinding(row) };
    },

    linkItem(threadId: string, findingId: string, itemId: string): boolean {
      return setItem.run({ thread_id: threadId, id: findingId, item_id: itemId, updated_at: Date.now() }).changes > 0;
    },

    /** Atomically move one open finding from its current work item. */
    moveItem(threadId: string, findingId: string, fromItemId: string, itemId: string): boolean {
      return moveItem.run({
        thread_id: threadId,
        id: findingId,
        from_item_id: fromItemId,
        item_id: itemId,
        updated_at: Date.now(),
      }).changes > 0;
    },

    unlinkItem(threadId: string, findingId: string): boolean {
      return clearItem.run({ thread_id: threadId, id: findingId, updated_at: Date.now() }).changes > 0;
    },

    unlinkItems(threadId: string, findingIds: readonly string[]): number {
      const ids = [...new Set(findingIds.map((id) => id.trim()).filter(Boolean))];
      if (ids.length === 0) return 0;
      let changed = 0;
      db.transaction(() => {
        const updatedAt = Date.now();
        for (const id of ids) {
          changed += clearItem.run({ thread_id: threadId, id, updated_at: updatedAt }).changes;
        }
      })();
      return changed;
    },

    get(threadId: string, ref: string): GoalFinding | null {
      const viaId = byId.get(threadId, ref) as FindingRow | undefined;
      if (viaId) return rowToFinding(viaId);
      const viaFp = byFingerprint.get(threadId, ref) as FindingRow | undefined;
      return viaFp ? rowToFinding(viaFp) : null;
    },

    list(threadId: string, status?: GoalFindingStatus): GoalFinding[] {
      const rows = (byThread.all(threadId) as FindingRow[]).map(rowToFinding);
      return status ? rows.filter((finding) => finding.status === status) : rows;
    },

    remediationQueue(threadId: string): RemediationFinding[] {
      return (byThread.all(threadId) as FindingRow[])
        .filter((row) => row.status === "open")
        .map(rowToRemediation);
    },

    counts(threadId: string): {
      open: number;
      fixed: number;
      fixedUnverified: number;
      dismissed: number;
      assignedDefects: number;
      awaitingAssignment: number;
      remediationWorkItems: number;
    } {
      const rows = byThread.all(threadId) as FindingRow[];
      const open = rows.filter((row) => row.status === "open");
      const assigned = open.filter((row) => row.item_id);
      return {
        open: open.length,
        fixed: rows.filter((row) => row.status === "fixed").length,
        fixedUnverified: rows.filter((row) => row.status === "fixed_unverified").length,
        dismissed: rows.filter((row) => row.status === "dismissed").length,
        assignedDefects: assigned.length,
        awaitingAssignment: open.length - assigned.length,
        remediationWorkItems: new Set(assigned.map((row) => row.item_id!)).size,
      };
    },

    resolve(
      threadId: string,
      ref: string,
      status: Exclude<GoalFindingStatus, "open">,
      note: string,
      /**
       * Answers whether a commit-like token exists in the repository. Optional
       * because the server side of a plugin has no git; when it is absent the
       * note is stored as given, exactly as before.
       */
      resolvesCommit?: CommitResolver,
      /** Which repository was searched, so the note can say. */
      repository?: string | null,
    ): GoalFinding | null {
      const finding = this.get(threadId, ref);
      if (!finding) return null;
      // A finding was closed citing 2e4f7dd, which does not exist. The register
      // accepted it and nothing objected — the same class the reachability
      // audit counts, created by the API that was supposed to prevent it.
      const checked = resolvesCommit
        ? verifyAttribution(note, resolvesCommit, repository)
        : { unresolved: [] as string[], unverified: [] as string[], note };
      setStatus.run({
        thread_id: threadId,
        id: finding.id,
        status,
        resolution_note: checked.note.trim() || null,
        updated_at: Date.now(),
      });
      return this.get(threadId, finding.id);
    },

    /**
     * A finding whose fix is not shown to be live goes back in play. Only
     * entries this slice closed are reopened, and only from a state a merge
     * outcome can contradict — `fixed_unverified` is exactly that state, and a
     * dismissal was a human judgement about the defect itself that no merge
     * outcome should overturn.
     */
    reopenForFailedIntegration(threadId: string, itemId: string, note: string): number {
      const rows = (byItem.all(threadId, itemId) as FindingRow[]).filter(
        (row) => row.status === "fixed" || row.status === "fixed_unverified",
      );
      db.transaction(() => {
        const updatedAt = Date.now();
        for (const row of rows) {
          setStatus.run({
            thread_id: threadId,
            id: row.id,
            status: "open",
            resolution_note: note.trim().slice(0, 400) || null,
            updated_at: updatedAt,
          });
        }
      })();
      return rows.length;
    },

    /**
     * A completed fix slice closes the findings its completion attests — never
     * every finding that happens to be linked to the item — and records them
     * as `fixed_unverified`, never `fixed`.
     *
     * A slice completing shows that work was done, not where it runs. Stamping
     * `fixed` here recorded an unlanded or cross-repo fix as closed the moment
     * its item completed, and reopenForFailedIntegration could not undo it:
     * that path fires on a merge failure, and a slice whose work never entered
     * this repository's integration path never produces one. The attested
     * state says what is actually known — the completion affirms a fix; no
     * landing has been shown — and `confirmLandedByItem` promotes it once one
     * is. A linked defect the completion does not cover stays open, where the
     * queue can still reach it.
     */
    markAttestedByItem(
      threadId: string,
      itemId: string,
      note: string,
      evidence: readonly FindingAffirmativeEvidence[],
    ): number {
      const rows = (byItem.all(threadId, itemId) as FindingRow[]).filter(
        (row) => row.status === "open",
      );
      const unattested = new Set(
        missingLinkedDefectEvidenceIds(evidence, rows).map((id) => id.toLowerCase()),
      );
      const closing = rows.filter((row) => !unattested.has(row.id.toLowerCase()));
      db.transaction(() => {
        const updatedAt = Date.now();
        for (const row of closing) {
          setStatus.run({
            thread_id: threadId,
            id: row.id,
            status: "fixed_unverified",
            resolution_note: note.trim().slice(0, 400) || null,
            updated_at: updatedAt,
          });
        }
      })();
      if (unattested.size > 0) {
        bb.log.warn(
          `Completion of ${itemId} on ${threadId} attested ${closing.length} of ${rows.length} linked finding(s); the rest stay open`,
        );
      }
      return closing.length;
    },

    /**
     * Promote this slice's attested findings to `fixed` because the landing is
     * now shown: its work is on the base branch the goal ships from.
     *
     * Deliberately separate from the closure. The register may only claim a fix
     * is live when something other than the completing worker's own report says
     * so, and the merge is that something.
     */
    confirmLandedByItem(threadId: string, itemId: string, note: string): number {
      const rows = (byItem.all(threadId, itemId) as FindingRow[]).filter(
        (row) => row.status === "fixed_unverified",
      );
      db.transaction(() => {
        const updatedAt = Date.now();
        for (const row of rows) {
          setStatus.run({
            thread_id: threadId,
            id: row.id,
            status: "fixed",
            resolution_note: note.trim().slice(0, 400) || null,
            updated_at: updatedAt,
          });
        }
      })();
      return rows.length;
    },

    clear(threadId: string): void {
      clearStmt.run(threadId);
    },
  };
}

export type FindingStore = ReturnType<typeof createFindingStore>;
