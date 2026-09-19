#!/usr/bin/env node
// Focused coverage for scripts/check-skill-impact.mjs.
// Run: node --test scripts/check-skill-impact.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evaluateSkillImpact } from "./check-skill-impact.mjs";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHECKER = join(REPO_ROOT, "scripts", "check-skill-impact.mjs");
const WORKFLOW = join(REPO_ROOT, ".github", "workflows", "skill-impact.yml");
const TEMPLATE = join(REPO_ROOT, ".github", "pull_request_template.md");

const GOOD_NONE = "Skill impact: none — the change only touches local tooling and no surface depends on it.";
const GOOD_UPDATED = "Skill impact: updated — the bundled demo skill now documents the gate entry point.";

// Fixture registry: tools registered either on the root surface, the worker
// surface, or (ultragoal_retired) on no surface at all.
const SERVER_TS = `const COLLAB_TOOL_NAMES = ["ultragoal_send_message", "ultragoal_followup_task"];
bb.agents.registerTool({ name: "ultragoal_start" });
bb.agents.registerTool({ name: "ultragoal_state" });
bb.agents.registerTool({ name: "ultragoal_retired" });
bb.agents.registerTool({ name: "slice_done" });
bb.agents.configure((context) => {
  if (isWorker) {
    return {
      tools: [...COLLAB_TOOL_NAMES, "slice_done"],
    };
  }
  return {
    tools: ["ultragoal_start", "ultragoal_state", ...COLLAB_TOOL_NAMES],
  };
});
`;

const SKILL_DOC = "---\nname: demo\ndescription: Demo skill for the gate tests.\n---\n\nUse `ultragoal_start` to begin.\n";

function makeRepo(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "skill-impact-test-"));
  const files = {
    "package.json": JSON.stringify({
      name: "fixture-plugin",
      type: "module",
      files: ["server.ts", "lib", "skills", "templates"],
      bb: { name: "Fixture", skills: ["skills"] },
    }),
    "server.ts": SERVER_TS,
    "skills/demo/SKILL.md": SKILL_DOC,
    "skills/demo/notes.txt": "packaged alongside the skill\n",
    ...overrides,
  };
  for (const [rel, content] of Object.entries(files)) {
    if (rel.endsWith("/")) {
      mkdirSync(join(root, rel), { recursive: true });
      continue;
    }
    if (content === null) continue;
    const absolute = join(root, rel);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

function runChecker(root, args = [], env = {}) {
  const proc = spawnSync(process.execPath, [CHECKER, "--root", root, ...args], {
    encoding: "utf8",
    cwd: root,
    env: { ...process.env, GITHUB_EVENT_PATH: "", ...env },
  });
  return { status: proc.status, out: `${proc.stdout}${proc.stderr}` };
}

function bodyArgs(root, body) {
  const path = join(root, "pr-body.md");
  writeFileSync(path, body);
  return ["--body-file", path];
}

function withRepo(overrides, fn) {
  const root = makeRepo(overrides);
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a behavior-affecting diff without a declaration is a violation", () => {
  withRepo({}, (root) => {
    const { status, out } = runChecker(root, [...bodyArgs(root, ""), "--changed", "server.ts"]);
    assert.equal(status, 1, out);
    assert.match(out, /skill-impact: missing-declaration/);
    assert.match(out, /server\.ts/);
  });
});

test("empty, placeholder and malformed rationales are violations", () => {
  withRepo({}, (root) => {
    for (const body of [
      "Skill impact: none — <why>",
      "Skill impact: none",
      "Skill impact: updated — todo",
      "Skill impact: none — N/A.",
      "Skill impact: none — no change",
      "Skill impact: maybe — a real sentence",
    ]) {
      const { status, out } = runChecker(root, [...bodyArgs(root, body), "--changed", "server.ts"]);
      assert.equal(status, 1, `${body}\n${out}`);
      assert.match(out, /skill-impact: malformed-declaration/, body);
    }
  });
});

test("a declaration on a non-behavior-affecting diff is still validated", () => {
  withRepo({}, (root) => {
    const updated = runChecker(root, [...bodyArgs(root, GOOD_UPDATED), "--changed", "docs/notes.md"]);
    assert.equal(updated.status, 1, updated.out);
    assert.match(updated.out, /declaration-contradiction/);
    const placeholder = runChecker(root, [...bodyArgs(root, "Skill impact: none — tbd"), "--changed", "docs/notes.md"]);
    assert.equal(placeholder.status, 1, placeholder.out);
  });
});

test("updated without a skill or template change is a violation", () => {
  withRepo({}, (root) => {
    const { status, out } = runChecker(root, [...bodyArgs(root, GOOD_UPDATED), "--changed", "server.ts,lib/collab.ts"]);
    assert.equal(status, 1, out);
    assert.match(out, /declaration-contradiction/);
    assert.match(out, /skills\/\*\* or templates\/\*\*/);
  });
});

test("two declarations are a violation even when both are well formed", () => {
  withRepo({}, (root) => {
    const body = `${GOOD_NONE}\n\n${GOOD_UPDATED}`;
    const { status, out } = runChecker(root, [
      ...bodyArgs(root, body),
      "--changed",
      "server.ts,skills/demo/SKILL.md",
    ]);
    assert.equal(status, 1, out);
    assert.match(out, /duplicate-declaration/);
    assert.match(out, /lines 1, 3/);
  });
});

test("none contradicts a changed skill or template path", () => {
  withRepo({}, (root) => {
    const { status, out } = runChecker(root, [
      ...bodyArgs(root, GOOD_NONE),
      "--changed",
      "server.ts,skills/demo/SKILL.md",
    ]);
    assert.equal(status, 1, out);
    assert.match(out, /declaration-contradiction/);
    assert.match(out, /skills\/demo\/SKILL\.md/);
  });
});

test("a valid updated declaration with a skills change passes", () => {
  withRepo({}, (root) => {
    const { status, out } = runChecker(root, [
      ...bodyArgs(root, GOOD_UPDATED),
      "--changed",
      "server.ts,skills/demo/SKILL.md",
    ]);
    assert.equal(status, 0, out);
    assert.equal(out, "");
  });
});

test("a valid none declaration passes", () => {
  withRepo({}, (root) => {
    const { status, out } = runChecker(root, [...bodyArgs(root, GOOD_NONE), "--changed", "lib/collab.ts"]);
    assert.equal(status, 0, out);
  });
});

test("a non-behavior-affecting diff needs no declaration, including an empty diff", () => {
  withRepo({}, (root) => {
    const docs = runChecker(root, [
      ...bodyArgs(root, ""),
      "--changed",
      "docs/notes.md,scripts/tool.mjs,lib/collab.test.ts,CHANGELOG.md",
    ]);
    assert.equal(docs.status, 0, docs.out);
    const empty = runChecker(root, [...bodyArgs(root, ""), "--changed", ""]);
    assert.equal(empty.status, 0, empty.out);
  });
});

test("packaging: a skill directory without SKILL.md is a violation", () => {
  withRepo({ "skills/demo/SKILL.md": null }, (root) => {
    const { status, out } = runChecker(root, [...bodyArgs(root, ""), "--changed", "docs/notes.md"]);
    assert.equal(status, 1, out);
    assert.match(out, /missing/);
    assert.match(out, /skills\/demo\/SKILL\.md/);
  });
});

test("packaging: a frontmatter name mismatch or empty description is a violation", () => {
  withRepo(
    { "skills/demo/SKILL.md": "---\nname: ultragoal\ndescription: Mismatched.\n---\n\nBody.\n" },
    (root) => {
      const { status, out } = runChecker(root, [...bodyArgs(root, ""), "--changed", "docs/notes.md"]);
      assert.equal(status, 1, out);
      assert.match(out, /does not match directory "demo"/);
    },
  );
  withRepo({ "skills/demo/SKILL.md": "---\nname: demo\ndescription:\n---\n\nBody.\n" }, (root) => {
    const { status, out } = runChecker(root, [...bodyArgs(root, ""), "--changed", "docs/notes.md"]);
    assert.equal(status, 1, out);
    assert.match(out, /"description" is empty/);
  });
});

test("packaging: package.json without the bundle or registration entry is a violation", () => {
  withRepo(
    {
      "package.json": JSON.stringify({
        name: "fixture-plugin",
        type: "module",
        files: ["server.ts", "lib"],
        bb: { name: "Fixture", skills: [] },
      }),
    },
    (root) => {
      const { status, out } = runChecker(root, [...bodyArgs(root, ""), "--changed", "docs/notes.md"]);
      assert.equal(status, 1, out);
      assert.match(out, /"files" must include "skills"/);
      assert.match(out, /"bb\.skills" must include "skills"/);
    },
  );
});

test("a documented tool absent from every role surface is named as a violation", () => {
  withRepo(
    { "skills/demo/SKILL.md": `---\nname: demo\ndescription: Demo.\n---\n\nCall \`ultragoal_retired\` now.\n` },
    (root) => {
      const { status, out } = runChecker(root, [...bodyArgs(root, ""), "--changed", "docs/notes.md"]);
      assert.equal(status, 1, out);
      assert.match(out, /ultragoal_retired/);
      assert.match(out, /skills\/demo\/SKILL\.md/);
    },
  );
});

test("a documented tool unknown to the registry is named as a violation", () => {
  withRepo(
    { "skills/demo/SKILL.md": `---\nname: demo\ndescription: Demo.\n---\n\nCall \`ultragoal_frobnicate\` now.\n` },
    (root) => {
      const { status, out } = runChecker(root, [...bodyArgs(root, ""), "--changed", "docs/notes.md"]);
      assert.equal(status, 1, out);
      assert.match(out, /ultragoal_frobnicate/);
    },
  );
});

test("role-aware allowance: a worker-only registered tool is accepted, prose parameters are ignored", () => {
  withRepo(
    {
      "skills/demo/SKILL.md":
        "---\nname: demo\ndescription: Demo.\n---\n\n" +
        "Workers close the slice with `slice_done`. Also `plan_status`, `token_budget` and `remove_item_ids` " +
        "are parameters, not tools.\n",
      "templates/goals/continuation.md": "Close with `slice_done`.\n",
    },
    (root) => {
      const { status, out } = runChecker(root, [...bodyArgs(root, ""), "--changed", "docs/notes.md"]);
      assert.equal(status, 0, out);
    },
  );
});

test("the payload supplies the body and changed paths for a fork PR with no token", () => {
  withRepo({}, (root) => {
    const eventPath = join(root, "event.json");
    writeFileSync(
      eventPath,
      JSON.stringify({
        pull_request: {
          body: GOOD_NONE,
          base: { sha: "a".repeat(40) },
          head: { sha: "b".repeat(40), repo: { fork: true, full_name: "someone/fork" } },
        },
      }),
    );
    const env = { GITHUB_EVENT_PATH: eventPath, GITHUB_TOKEN: "" };
    const none = runChecker(root, ["--changed", "lib/collab.ts"], env);
    assert.equal(none.status, 0, none.out);
    const behavior = runChecker(root, ["--changed", "server.ts"], env);
    assert.equal(behavior.status, 0, "the payload body must satisfy the declaration");
  });
});

test("base/head from the payload resolve the diff with local git, never the API", () => {
  withRepo({}, (root) => {
    const git = (...args) => {
      const proc = spawnSync(
        "git",
        ["-C", root, "-c", "user.name=gate", "-c", "user.email=gate@example.invalid", "-c", "commit.gpgsign=false", ...args],
        { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } },
      );
      assert.equal(proc.status, 0, `git ${args.join(" ")}: ${proc.stderr}`);
      return proc.stdout.trim();
    };
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "baseline");
    const base = git("rev-parse", "HEAD");

    writeFileSync(join(root, "skills/demo/SKILL.md"), `${SKILL_DOC}\nNew section.\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "pr");
    const head = git("rev-parse", "HEAD");

    const eventPath = join(root, "event.json");
    writeFileSync(eventPath, JSON.stringify({ pull_request: { body: GOOD_NONE, base: { sha: base }, head: { sha: head } } }));
    const contradictory = runChecker(root, [], { GITHUB_EVENT_PATH: eventPath });
    assert.equal(contradictory.status, 1, contradictory.out);
    assert.match(contradictory.out, /skills\/demo\/SKILL\.md/);

    // Partial/empty data: the same sha on both sides yields an empty diff.
    writeFileSync(eventPath, JSON.stringify({ pull_request: { body: "", base: { sha: head }, head: { sha: head } } }));
    const empty = runChecker(root, [], { GITHUB_EVENT_PATH: eventPath });
    assert.equal(empty.status, 0, empty.out);
  });
});

test("usage and setup errors exit 2", () => {
  withRepo({}, (root) => {
    assert.equal(runChecker(root, ["--nope"]).status, 2);
    assert.equal(runChecker(root, [...bodyArgs(root, GOOD_NONE), "--changed", "lib/collab.ts"]).status, 0);
    assert.equal(runChecker(root, ["--body-file", join(root, "missing.md"), "--changed", "server.ts"]).status, 2);
    const missingRoot = spawnSync(process.execPath, [CHECKER, "--root", join(root, "nope"), "--changed", "server.ts"], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_EVENT_PATH: "" },
    });
    assert.equal(missingRoot.status, 2, missingRoot.stderr);
  });
});

test("the evaluation entry point is exported and --json reports the same result", () => {
  withRepo({}, (root) => {
    const pass = evaluateSkillImpact({ root, body: GOOD_NONE, changedPaths: ["lib/collab.ts"] });
    assert.equal(pass.ok, true, JSON.stringify(pass.violations));
    const fail = evaluateSkillImpact({ root, body: "", changedPaths: ["server.ts"] });
    assert.equal(fail.ok, false);
    assert.ok(fail.violations.some((violation) => violation.rule === "missing-declaration"));

    const { status, out } = runChecker(root, [...bodyArgs(root, GOOD_NONE), "--changed", "lib/collab.ts", "--json"]);
    assert.equal(status, 0, out);
    const parsed = JSON.parse(out);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.violations, []);
    assert.deepEqual(parsed.changed, ["lib/collab.ts"]);
  });
});

test("the workflow always reports, reruns on body edits, and holds no write token", () => {
  const workflow = readFileSync(WORKFLOW, "utf8");
  assert.match(workflow, /on:\s*\n\s*pull_request:/);
  assert.match(workflow, /types:\s*\[opened, synchronize, reopened, edited\]/);
  assert.match(workflow, /permissions:\s*\n\s*contents:\s*read/);
  assert.doesNotMatch(workflow, /contents:\s*write/);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /name:\s*skill-impact/);
  assert.match(workflow, /node scripts\/check-skill-impact\.mjs/);
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.doesNotMatch(workflow, /paths(-ignore)?:/);
  assert.doesNotMatch(workflow, /github\.event\.pull_request\.body/);
});

test("the unedited PR template fails the gate until an author makes a real choice", () => {
  const template = readFileSync(TEMPLATE, "utf8");
  assert.match(template, /Skill impact:\s*updated/);
  assert.match(template, /Skill impact:\s*none/);
  withRepo({}, (root) => {
    const { status, out } = runChecker(root, [
      ...bodyArgs(root, template),
      "--changed",
      "server.ts,skills/demo/SKILL.md",
    ]);
    assert.equal(status, 1, out);
  });
});

test("the checker passes this repository's own registry, packaging and docs", () => {
  const scratch = mkdtempSync(join(tmpdir(), "skill-impact-self-"));
  try {
    const bodyPath = join(scratch, "body.md");
    writeFileSync(bodyPath, GOOD_NONE);
    const none = runChecker(REPO_ROOT, ["--body-file", bodyPath, "--changed", "server.ts,lib/collab.ts"]);
    assert.equal(none.status, 0, none.out);
    writeFileSync(bodyPath, GOOD_UPDATED);
    const updated = runChecker(REPO_ROOT, [
      "--body-file",
      bodyPath,
      "--changed",
      "server.ts,skills/ultragoal/SKILL.md",
    ]);
    assert.equal(updated.status, 0, updated.out);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
