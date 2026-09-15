#!/usr/bin/env node
// Addendum to scripts/check-execution-reconciliation.mjs: audits the tracker claims the base
// check does not cover — every citation resolves to the right issue/comment, the
// closing notes and Q5-Q7 receipt are the ones cited, the eight program tickets
// carry no sourcing label, the cited PR merge SHAs really are those PRs' merges,
// and those commits are ancestors of the integration ref this tree sits on.
// Run from the worktree root: node scripts/check-execution-reconciliation-addendum.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const TRACKER = "uje-m/bb-plugin-ultragoal";
const DOC = "docs/execution-reconciliation.md";
const doc = existsSync(DOC) ? readFileSync(DOC, "utf8") : "";
const flat = doc.replace(/\s+/g, " ");

const pass = [];
const fail = [];
const check = (name, cond, detail = "") =>
  (cond ? pass : fail).push(`${cond ? "PASS" : "FAIL"}: ${name}${detail ? ` — ${detail}` : ""}`);
const ghJson = (path) => {
  try {
    return JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  } catch (error) {
    throw new Error(`gh api ${path} did not return parseable JSON: ${error.message}`);
  }
};

// A. Every issue-comment citation in the document resolves to that issue.
const citations = [...doc.matchAll(/issues\/(\d+)#issuecomment-(\d+)/g)].map((m) => ({
  issue: Number(m[1]),
  comment: Number(m[2]),
}));
check("document cites tracker comments", citations.length >= 6, String(citations.length));
for (const { issue, comment } of citations) {
  const body = ghJson(`repos/${TRACKER}/issues/comments/${comment}`);
  check(
    `citation #${issue} comment ${comment} belongs to that issue`,
    body.issue_url?.endsWith(`/issues/${issue}`),
    body.issue_url,
  );
}

// B. The #7/#8 closures are the notes the document cites, with the cited rulings.
for (const [issue, decision, rulingComment, closeComment] of [
  [7, "dec_mu239a7w_08ko65", 5674132832, 5674133076],
  [8, "dec_mu2399hy_3el515", 5674125633, 5674125796],
]) {
  const state = ghJson(`repos/${TRACKER}/issues/${issue}`);
  check(`#${issue} is closed`, state.state === "closed", state.state);
  check(`#${issue} ruling id in doc`, doc.includes(decision), decision);
  check(`#${issue} ruling comment cited`, doc.includes(`issuecomment-${rulingComment}`));
  check(`#${issue} closing note cited`, doc.includes(`issuecomment-${closeComment}`));
  const ruling = ghJson(`repos/${TRACKER}/issues/comments/${rulingComment}`).body;
  const close = ghJson(`repos/${TRACKER}/issues/comments/${closeComment}`).body;
  check(`#${issue} ruling states its decision id`, ruling.includes(decision));
  check(`#${issue} closing note references the ruling`, /owner ruling/i.test(close), close.slice(0, 60));
  check(
    `#${issue} doc states no install/restart/deploy authority`,
    /no installation, restart, deployment, or live-workflow migration/i.test(flat),
  );
}

// C. The Q5-Q7 receipt the doc consumes is the cited comment, bullet for bullet.
const q57 = ghJson(`repos/${TRACKER}/issues/comments/5673834619`);
check("Q5-Q7 receipt is on map #2", q57.issue_url?.endsWith("/issues/2"), q57.issue_url);
check("Q5-Q7 receipt cited by the doc", doc.includes("issues/2#issuecomment-5673834619"));
// The document summarizes the Q5-Q7 receipt (its verbatim guarantee, verified
// above and in the base check, is tied to decision-bearing rulings #7/#8). A
// faithful summary must still carry every operative constraint, so each
// decision's decisive tokens are required: a lossy paraphrase fails here.
const Q57_TOKENS = {
  Q5: ["five minutes", "matching acceptance", "retain its slot", "one actionable escalation", "late evidence", "never releases or retries"],
  Q6: ["launch intent", "provider acceptance", "drift", "unavailable", "null/default", "normalize"],
  Q7: ["revision", "effective selection", "older-revision launch", "refresh or yield"],
};
for (const [decision, tokens] of Object.entries(Q57_TOKENS)) {
  const receiptBullet = q57.body.split("\n").find((line) => line.startsWith(`- ${decision}:`)) ?? "";
  check(`Q5-Q7 receipt carries ${decision}`, receiptBullet.length > 0, receiptBullet.slice(0, 50));
  for (const token of tokens) {
    check(
      `Q5-Q7 ${decision} constraint recorded — ${token}`,
      flat.toLowerCase().includes(token.toLowerCase()),
    );
  }
}
const q57flat = q57.body.replace(/\s+/g, " ");
check(
  "Q5-Q7 receipt explicitly excludes #7 and #8",
  /does not claim approval/i.test(q57flat) && q57flat.includes("contract (#7)") && q57flat.includes("contract (#8)"),
);

// D. The release-receipt claim is grounded in the cited handoff comment.
const handoff = ghJson(`repos/${TRACKER}/issues/comments/5663463518`);
check("release handoff receipt is on #12", handoff.issue_url?.endsWith("/issues/12"), handoff.issue_url);
check("release handoff receipt cited by the doc", doc.includes("issues/12#issuecomment-5663463518"));
check("release handoff records PR14 as not installed live", /Not installed live/i.test(handoff.body));
check(
  "doc quotes the not-installed status",
  /not installed live/i.test(doc),
);

// E. The eight program tickets are unsourced: no label at all, so nothing can be
// picked up by a feeder.
const openIssues = ghJson(`repos/${TRACKER}/issues?state=open&per_page=100`).filter(
  (issue) => !issue.pull_request,
);
const program = openIssues.filter((issue) => /^Program ticket: T\d+/m.test(issue.body ?? ""));
check("all eight program tickets are open", program.length === 8, String(program.length));
for (const issue of program) {
  check(
    `#${issue.number} carries no label (never ready-for-agent)`,
    (issue.labels ?? []).length === 0,
    (issue.labels ?? []).map((l) => l.name).join(","),
  );
  check(`#${issue.number} is not a PR`, !issue.pull_request);
  check(
    `#${issue.number} forbids the feeder`,
    /Factory Feeder is not used/.test(issue.body),
  );
  check(
    `#${issue.number} disclaims release authority`,
    /Out of bounds: push, PR, merge, default-branch landing, plugin install or restart, deployment/.test(
      issue.body,
    ),
  );
}

// F. Dispositions the document records for the other open issues.
for (const number of [1, 2, 12]) {
  const state = ghJson(`repos/${TRACKER}/issues/${number}`);
  check(`#${number} is open as documented`, state.state === "open", state.state);
}
const nineteen = ghJson(`repos/${TRACKER}/issues/19`);
check("#19 is an issue, not a PR", !nineteen.pull_request, nineteen.html_url);
check(
  "doc states #19 is not a merged PR",
  doc.includes("issues/19") && flat.includes("not a merged PR"),
);

// G. The cited merge commits are those PRs' merges.
const PRS = [
  [14, "138f649cd129983c24d18d8ab5e0ecff0cbe06e5"],
  [16, "8e28bc091be780e1679c3669c1d553dfe9f0818b"],
  [17, "827b5a9fcbcb47279b5613be0b88276c381f7066"],
  [18, "a014a9ba0b7d32cd3fca1191dce88923d5d1d6e9"],
  [20, "a0ef05be9c42f83491aa878dc8a197e2255d7790"],
];
for (const [number, sha] of PRS) {
  const pr = ghJson(`repos/${TRACKER}/pulls/${number}`);
  check(`PR #${number} is merged`, pr.merged === true, String(pr.merged));
  check(`PR #${number} merge commit is the cited ${sha.slice(0, 7)}`, pr.merge_commit_sha === sha, pr.merge_commit_sha);
  check(`doc cites PR #${number} merge commit`, doc.includes(sha));
  // H. The cited commit is an ancestor of the ref this worktree is checked out at.
  let ancestor = true;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], { stdio: "pipe" });
  } catch {
    ancestor = false;
  }
  check(`merge commit ${sha.slice(0, 7)} is an ancestor of HEAD`, ancestor);
}

for (const line of pass) console.log(line);
for (const line of fail) console.log(line);
console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length === 0 ? 0 : 1);
