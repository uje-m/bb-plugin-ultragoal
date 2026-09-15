#!/usr/bin/env node
// Independent done-criterion for the execution-specification reconciliation slice.
// It reads the fork tracker through `gh` and the local worktree, and asserts:
//   1. the two owner rulings (#7, #8) are recorded verbatim, with decision ids;
//   2. CONTEXT.md carries the settled vocabulary for those rulings;
//   3. exactly eight candidate-only fork implementation tickets exist, each with a
//      grounded file fence, a strict candidate-only Factory manifest and explicit
//      dependency edges that resolve to the other tickets;
//   4. #1/#2 stay open with a reconciliation receipt, and no deployment is claimed.
// Run from the worktree root: node scripts/check-execution-reconciliation.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const REPO = process.cwd();
const TRACKER = "uje-m/bb-plugin-ultragoal";
const DOC = "docs/execution-reconciliation.md";
const CONTEXT = "CONTEXT.md";
const TEST_CHECK = "npx tsx --test --test-concurrency=4 lib/*.test.ts";

const pass = [];
const fail = [];
const check = (name, cond, detail = "") =>
  (cond ? pass : fail).push(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const ghJson = (path) => {
  try {
    return JSON.parse(gh("api", path));
  } catch (error) {
    throw new Error(`gh api ${path} did not return parseable JSON: ${error.message}`);
  }
};

const doc = existsSync(`${REPO}/${DOC}`) ? readFileSync(`${REPO}/${DOC}`, "utf8") : "";
const context = existsSync(`${REPO}/${CONTEXT}`) ? readFileSync(`${REPO}/${CONTEXT}`, "utf8") : "";
check(`${DOC} exists`, doc.length > 0);

// --- 1. exact owner rulings -------------------------------------------------
const RULINGS = [
  { issue: 7, comment: 5674132832, decision: "dec_mu239a7w_08ko65", label: "verifier read-only" },
  { issue: 8, comment: 5674125633, decision: "dec_mu2399hy_3el515", label: "rolling replacement" },
];
for (const r of RULINGS) {
  const comment = ghJson(`repos/${TRACKER}/issues/comments/${r.comment}`);
  const issue = ghJson(`repos/${TRACKER}/issues/${r.issue}`);
  check(`#${r.issue} closed`, issue.state === "closed", issue.state);
  check(`#${r.issue} ruling decision id recorded`, doc.includes(r.decision), r.decision);
  check(
    `#${r.issue} ruling comment linked`,
    doc.includes(`issues/${r.issue}#issuecomment-${r.comment}`),
  );
  const bullets = comment.body
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.trim());
  check(`#${r.issue} ruling has bullets`, bullets.length > 0, `${bullets.length}`);
  for (const bullet of bullets) {
    check(`#${r.issue} ${r.label} bullet verbatim`, doc.includes(bullet), bullet.slice(0, 72));
  }
  // Presence of the authority disclaimer, whitespace-normalized across line wraps.
  check(
    `#${r.issue} authority limit stated`,
    /no installation, restart, deployment, or live-workflow migration/i.test(
      doc.slice(doc.indexOf(r.decision)).replace(/\s+/g, " "),
    ),
  );
}

// --- 2. settled vocabulary --------------------------------------------------
for (const term of [
  "**Enforced read-only execution environment**:",
  "**Verifier capability proof**:",
  "**Pre-allocation verifier rejection**:",
  "**Roll target revision**:",
  "**Replacement mapping**:",
  "**Roll pause**:",
  "**Frozen roll**:",
]) {
  check(`${CONTEXT} defines ${term.replace(/[*:]/g, "")}`, context.includes(term));
}

// --- 3. candidate-only fork implementation tickets --------------------------
const EXPECTED = {
  T1: { upstream: 4, deps: [] },
  T2: { upstream: 5, deps: [] },
  T3: { upstream: 6, deps: [] },
  T4: { upstream: 7, deps: ["T1"] },
  T5: { upstream: 8, deps: ["T2"] },
  T6: { upstream: 9, deps: ["T2"] },
  T7: { upstream: 10, deps: ["T2", "T4"] },
  T8: { upstream: 11, deps: ["T1", "T3", "T4", "T6"] },
};
const openIssues = ghJson(`repos/${TRACKER}/issues?state=open&per_page=100`).filter(
  (issue) => !issue.pull_request,
);
const MARKER = /^Program ticket: (T\d+) · upstream braedonsaunders\/bb-plugin-ultragoal#(\d+) · depends on: (.+)$/m;
const found = new Map();
for (const issue of openIssues) {
  const marker = MARKER.exec(issue.body ?? "");
  if (!marker) continue;
  if (found.has(marker[1])) fail.push(`FAIL: duplicate ticket ${marker[1]}`);
  found.set(marker[1], { number: issue.number, upstream: Number(marker[2]), deps: marker[3], body: issue.body });
}
check(
  "exactly the eight program tickets are open",
  found.size === 8 && Object.keys(EXPECTED).every((t) => found.has(t)),
  [...found.keys()].sort().join(","),
);

for (const [ticket, spec] of Object.entries(EXPECTED)) {
  const entry = found.get(ticket);
  if (!entry) {
    fail.push(`FAIL: ${ticket} missing`);
    continue;
  }
  check(`${ticket} upstream issue`, entry.upstream === spec.upstream, `#${entry.upstream}`);
  const deps = entry.deps.trim() === "none (frontier)" ? [] : entry.deps.split(",").map((d) => d.trim().replace(/\s*\(#\d+\)$/, ""));
  check(`${ticket} dependency edges`, JSON.stringify(deps) === JSON.stringify(spec.deps), entry.deps);
  for (const dep of deps) {
    check(`${ticket} dep ${dep} resolves to an open ticket`, found.has(dep));
    if (found.has(dep)) {
      check(`${ticket} references fork #${found.get(dep).number}`, entry.body.includes(`#${found.get(dep).number}`));
    }
  }
  const block = /```json\n([\s\S]*?)```/.exec(entry.body);
  check(`${ticket} carries a JSON manifest`, Boolean(block));
  if (!block) continue;
  let manifest;
  try {
    manifest = JSON.parse(block[1]);
  } catch (error) {
    fail.push(`FAIL: ${ticket} manifest is not JSON — ${error.message}`);
    continue;
  }
  check(`${ticket} manifest is candidate-only`, manifest.candidateOnly === true);
  check(`${ticket} manifest base is main`, manifest.baseBranch === "main");
  check(
    `${ticket} machine checks`,
    Array.isArray(manifest.machineChecks) &&
      manifest.machineChecks.includes("npx tsc --noEmit") &&
      manifest.machineChecks.includes(TEST_CHECK),
    (manifest.machineChecks ?? []).join(" | "),
  );
  check(
    `${ticket} baseline checks match`,
    JSON.stringify(manifest.taskBaselineChecks) === JSON.stringify(manifest.machineChecks),
  );
  check(`${ticket} manifest is not a feeder manifest`, !("route" in manifest) && !/factory-feeder/.test(entry.body));
  const files = (manifest.tasks ?? []).flatMap((task) => task.files ?? []);
  check(`${ticket} declares a file fence`, files.length > 0);
  for (const file of files) check(`${ticket} fence ${file} exists`, existsSync(`${REPO}/${file}`), file);
  check(`${ticket} maxChangedFiles matches fence`, manifest.maxChangedFiles === files.length, String(manifest.maxChangedFiles));
  const claims = (manifest.claims?.claims ?? []).map((claim) => claim.resource);
  check(
    `${ticket} write claims match fence`,
    manifest.claims?.version === 2 &&
      claims.length === files.length &&
      files.every((file) => claims.includes(`repo:${TRACKER}:${file}`)),
  );
  check(`${ticket} referenced by the reconciliation doc`, doc.includes(`#${entry.number}`), `#${entry.number}`);
}

// --- 4. open issues, receipts, no deployment claim --------------------------
for (const issue of [1, 2]) {
  const state = ghJson(`repos/${TRACKER}/issues/${issue}`);
  check(`#${issue} stays open`, state.state === "open", state.state);
  const comments = ghJson(`repos/${TRACKER}/issues/${issue}/comments?per_page=100`);
  check(
    `#${issue} carries a reconciliation receipt`,
    comments.some((c) => c.body.includes(DOC) && /Program ticket: T1/.test(c.body)),
  );
}
check("doc states no installation", /no installation/i.test(doc));
check("doc states no deployment claim", /not a deployment|no deployment|no installation, restart, deployment/i.test(doc));
check("doc records the open dispositions of #1 and #2", /#1/.test(doc) && /#2/.test(doc));

for (const line of pass) console.log(line);
for (const line of fail) console.log(line);
console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length === 0 ? 0 : 1);
