#!/usr/bin/env node
// Deterministic, read-only skill-maintenance gate for pull requests.
//
// It answers three repository-local questions with no network, no writes and no
// dependencies beyond Node's standard library:
//
//   1. declaration — does the PR body declare its skill impact honestly?
//   2. packaging   — is every bundled skill present, registered and parseable?
//   3. tool names  — is every tool name documented in skills/ or templates/
//                    available on at least one registered role surface?
//
// Inputs come from explicit flags, otherwise from the GitHub `pull_request`
// event payload at GITHUB_EVENT_PATH. Changed paths come from --changed or from
// a local `git diff --name-only <base>...<head>`; the GitHub API is never
// called, so fork PRs need no token or secret.
//
//   node scripts/check-skill-impact.mjs [--root DIR] [--body-file FILE]
//     [--changed path,path] [--base SHA] [--head SHA] [--json]
//
// Exit 0 pass | 1 violations (one stdout line per violation) | 2 usage/setup.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const BEHAVIOR_AFFECTING_FILES = new Set(["server.ts", "host.ts", "contract.ts", "host-contract.ts"]);
const PLACEHOLDER_RATIONALES = new Set([
  "todo",
  "tbd",
  "n/a",
  "na",
  "none",
  "no impact",
  "not applicable",
  "no change",
]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage"]);
const DECLARATION_LINE = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?Skill impact:\s*(.*)$/i;
const DECLARATION_BODY = /^(updated|none)\s*(—|–|-)\s*([\s\S]*)$/i;

/** A path whose change can alter tool, command, orchestration, permission or instruction behavior. */
export function isBehaviorAffectingPath(path) {
  if (BEHAVIOR_AFFECTING_FILES.has(path)) return true;
  if (path.startsWith("lib/")) return !path.endsWith(".test.ts");
  return path.startsWith("skills/") || path.startsWith("templates/");
}

/**
 * Parse one candidate declaration line.
 * Returns null when the line is not a declaration, `{ problem }` when it is
 * malformed, and `{ kind, rationale }` when it is well formed.
 */
export function parseDeclarationLine(line) {
  const line_ = line.match(DECLARATION_LINE);
  if (!line_) return null;
  const declaration = line_[1].match(DECLARATION_BODY);
  if (!declaration) {
    return { problem: `malformed "Skill impact:" line — expected "Skill impact: updated|none <separator> rationale"` };
  }
  const kind = declaration[1].toLowerCase();
  const rationale = declaration[3].trim();
  if (!rationale) return { problem: `"Skill impact: ${kind}" has an empty rationale` };
  if (/<[^>]*>/.test(rationale)) return { problem: `"Skill impact: ${kind}" rationale still contains a template placeholder` };
  const bare = rationale.replace(/\.+$/, "").trim().toLowerCase();
  if (PLACEHOLDER_RATIONALES.has(bare)) {
    return { problem: `"Skill impact: ${kind}" rationale is the placeholder "${bare}"` };
  }
  return { kind, rationale };
}

function declarationViolations(body, changed) {
  const violations = [];
  const lines = String(body ?? "").split(/\r?\n/);
  const attempts = [];
  lines.forEach((line, index) => {
    const parsed = parseDeclarationLine(line);
    if (parsed) attempts.push({ line: index + 1, parsed });
  });

  const skillsOrTemplates = changed.filter((p) => p.startsWith("skills/") || p.startsWith("templates/"));
  const behaviorAffecting = changed.filter(isBehaviorAffectingPath);

  if (attempts.length === 0) {
    if (behaviorAffecting.length > 0) {
      violations.push({
        rule: "missing-declaration",
        message: `behavior-affecting change requires exactly one "Skill impact:" declaration in the PR body (changed: ${behaviorAffecting.slice(0, 5).join(", ")})`,
      });
    }
    return { violations, declaration: null };
  }

  if (attempts.length > 1) {
    violations.push({
      rule: "duplicate-declaration",
      message: `${attempts.length} "Skill impact:" declarations found (lines ${attempts.map((a) => a.line).join(", ")}); exactly one is required`,
    });
  }

  let first = null;
  for (const attempt of attempts) {
    const { parsed } = attempt;
    if (parsed.problem) {
      violations.push({ rule: "malformed-declaration", message: `line ${attempt.line}: ${parsed.problem}` });
      continue;
    }
    first ??= { ...parsed, line: attempt.line };
    if (parsed.kind === "updated" && skillsOrTemplates.length === 0) {
      violations.push({
        rule: "declaration-contradiction",
        message: `line ${attempt.line}: "Skill impact: updated" requires at least one changed skills/** or templates/** path`,
      });
    }
    if (parsed.kind === "none" && skillsOrTemplates.length > 0) {
      violations.push({
        rule: "declaration-contradiction",
        message: `line ${attempt.line}: "Skill impact: none" contradicts a changed skill or template path (${skillsOrTemplates.slice(0, 5).join(", ")})`,
      });
    }
  }

  return { violations, declaration: first };
}

function readDirectory(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function listFiles(dir, accept) {
  const found = [];
  const walk = (current) => {
    for (const entry of readDirectory(current).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && accept(path)) found.push(path);
    }
  };
  walk(dir);
  return found;
}

const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};
const isDirectory = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

function parseFrontmatter(text) {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end === -1) return null;
  const fields = {};
  for (const line of text.slice(text.indexOf("\n") + 1, end).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!match) continue;
    fields[match[1].toLowerCase()] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return fields;
}

function packagingViolations(root) {
  const violations = [];
  const packagePath = join(root, "package.json");
  if (!isFile(packagePath)) {
    return [{ rule: "packaging", message: "package.json is missing" }];
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch (error) {
    return [{ rule: "packaging", message: `package.json is not valid JSON: ${error.message}` }];
  }

  const files = Array.isArray(pkg.files) ? pkg.files : [];
  const declaredRoots = Array.isArray(pkg.bb?.skills) ? pkg.bb.skills : [];
  if (!files.includes("skills")) {
    violations.push({ rule: "packaging", message: 'package.json "files" must include "skills"' });
  }
  if (!declaredRoots.includes("skills")) {
    violations.push({ rule: "packaging", message: 'package.json "bb.skills" must include "skills"' });
  }

  const roots = new Set(declaredRoots);
  if (isDirectory(join(root, "skills"))) roots.add("skills");
  for (const skillRoot of [...roots].sort()) {
    const absolute = join(root, skillRoot);
    if (!isDirectory(absolute)) {
      violations.push({ rule: "packaging", message: `declared skill root "${skillRoot}" does not exist` });
      continue;
    }
    const skills = readDirectory(absolute)
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    if (skills.length === 0) {
      violations.push({ rule: "packaging", message: `declared skill root "${skillRoot}" contains no skill directory` });
    }
    for (const name of skills) {
      const docPath = join(absolute, name, "SKILL.md");
      const label = `${skillRoot}/${name}/SKILL.md`;
      if (!isFile(docPath)) {
        violations.push({ rule: "packaging", message: `${label} is missing (every directory under ${skillRoot}/ must ship a SKILL.md)` });
        continue;
      }
      const fields = parseFrontmatter(readFileSync(docPath, "utf8"));
      if (!fields) {
        violations.push({ rule: "packaging", message: `${label} has no YAML frontmatter` });
        continue;
      }
      if (!fields.name) violations.push({ rule: "packaging", message: `${label} frontmatter "name" is empty` });
      else if (fields.name !== name) {
        violations.push({
          rule: "packaging",
          message: `${label} frontmatter name "${fields.name}" does not match directory "${name}"`,
        });
      }
      if (!fields.description) violations.push({ rule: "packaging", message: `${label} frontmatter "description" is empty` });
    }
  }
  return violations;
}

function readBracketBody(text, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    if (text[index] === "[") depth += 1;
    else if (text[index] === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, index);
    }
  }
  return text.slice(openIndex + 1);
}

// Canonical registry: every registerTool name literal plus the COLLAB_TOOL_NAMES
// array literal, read from the target root only. Role surfaces: the `tools:`
// string arrays in server.ts (root, worker/verifier and any other role branch).
function collectRegistry(root) {
  const registered = new Set();
  const collab = new Set();
  const sources = listFiles(root, (path) => /\.(ts|tsx|mts|cts|mjs|cjs|js)$/.test(path));
  for (const source of sources) {
    const text = readFileSync(source, "utf8");
    for (const match of text.matchAll(/registerTool\s*\(\s*\{/g)) {
      const name = text.slice(match.index, match.index + 400).match(/\bname\s*:\s*"([^"]+)"/);
      if (name) registered.add(name[1]);
    }
    for (const match of text.matchAll(/COLLAB_TOOL_NAMES\s*=\s*\[([\s\S]*?)\]/g)) {
      for (const name of match[1].matchAll(/"([^"]+)"/g)) collab.add(name[1]);
    }
  }
  const surfaces = new Set();
  const serverPath = join(root, "server.ts");
  if (isFile(serverPath)) {
    const text = readFileSync(serverPath, "utf8");
    for (const match of text.matchAll(/tools\s*:\s*\[/g)) {
      const body = readBracketBody(text, match.index + match[0].length - 1);
      for (const name of body.matchAll(/"([^"]+)"/g)) surfaces.add(name[1]);
      if (/\.\.\.\s*COLLAB_TOOL_NAMES\b/.test(body)) for (const name of collab) surfaces.add(name);
    }
  }
  return { registry: new Set([...registered, ...collab]), surfaces };
}

function documentedTools(root) {
  const docs = [
    ...listFiles(join(root, "skills"), (path) => path.endsWith(".md")),
    ...listFiles(join(root, "templates"), () => true),
  ].sort();
  const documented = [];
  for (const doc of docs) {
    const path = relative(root, doc).split(sep).join("/");
    for (const match of readFileSync(doc, "utf8").matchAll(/`([^`\n]+)`/g)) {
      const name = match[1].trim();
      if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(name)) continue;
      documented.push({ name, path });
    }
  }
  return documented;
}

function toolNameViolations(root) {
  const { registry, surfaces } = collectRegistry(root);
  const families = new Set([...registry].map((name) => name.slice(0, name.indexOf("_"))));
  const violations = [];
  const seen = new Set();
  for (const { name, path } of documentedTools(root)) {
    const family = name.slice(0, name.indexOf("_"));
    if (!families.has(family) || surfaces.has(name)) continue;
    const key = `${name}\u0000${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    violations.push({
      rule: "unknown-tool-name",
      message: `${path} documents \`${name}\`, which is not available on any registered tool surface`,
    });
  }
  return violations;
}

/** Evaluate the gate against a repository root, a PR body and an explicit changed-path list. */
export function evaluateSkillImpact({ root = process.cwd(), body = "", changedPaths = [] } = {}) {
  const rootDir = resolve(root);
  const changed = [...new Set(changedPaths.map((path) => String(path).trim().replace(/^\.\//, "")).filter(Boolean))];
  const { violations: declarationIssues, declaration } = declarationViolations(body, changed);
  const violations = [...declarationIssues, ...packagingViolations(rootDir), ...toolNameViolations(rootDir)];
  return { ok: violations.length === 0, violations, declaration, changed };
}

class UsageError extends Error {}

function parseArgs(argv) {
  const flags = { root: null, bodyFile: null, changed: null, base: null, head: null, json: false };
  const takeValue = (arg, index) => {
    if (index >= argv.length) throw new UsageError(`${arg} requires a value`);
    return argv[index];
  };
  for (let index = 0; index < argv.length; index += 1) {
    const [arg, inline] = argv[index].startsWith("--") && argv[index].includes("=")
      ? [argv[index].slice(0, argv[index].indexOf("=")), argv[index].slice(argv[index].indexOf("=") + 1)]
      : [argv[index], null];
    switch (arg) {
      case "--root":
        flags.root = inline ?? takeValue(arg, ++index);
        break;
      case "--body-file":
        flags.bodyFile = inline ?? takeValue(arg, ++index);
        break;
      case "--changed":
        flags.changed = inline ?? takeValue(arg, ++index);
        break;
      case "--base":
        flags.base = inline ?? takeValue(arg, ++index);
        break;
      case "--head":
        flags.head = inline ?? takeValue(arg, ++index);
        break;
      case "--json":
        flags.json = true;
        break;
      default:
        throw new UsageError(`unknown argument "${argv[index]}"`);
    }
  }
  return flags;
}

function readEventPayload() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return {};
  let event;
  try {
    event = JSON.parse(readFileSync(eventPath, "utf8"));
  } catch (error) {
    throw new UsageError(`GITHUB_EVENT_PATH ${eventPath} is not readable JSON: ${error.message}`);
  }
  const pullRequest = event?.pull_request ?? {};
  return { body: pullRequest.body ?? "", base: pullRequest.base?.sha ?? "", head: pullRequest.head?.sha ?? "" };
}

function resolveInputs(flags) {
  const root = resolve(flags.root ?? process.cwd());
  if (!isDirectory(root)) throw new UsageError(`--root ${root} is not a directory`);

  const payload = readEventPayload();
  const body = flags.bodyFile ? readFile(flags.bodyFile) : payload.body;

  let changedPaths;
  if (flags.changed !== null) {
    changedPaths = flags.changed.split(",");
  } else {
    const base = flags.base || payload.base;
    const head = flags.head || payload.head;
    changedPaths = base && head ? gitChangedPaths(root, base, head) : [];
  }
  return { root, body, changedPaths };
}

function readFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new UsageError(`--body-file ${path} is not readable: ${error.message}`);
  }
}

function gitChangedPaths(root, base, head) {
  try {
    return execFileSync("git", ["-C", root, "diff", "--name-only", `${base}...${head}`], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }).split("\n");
  } catch (error) {
    const detail = String(error.stderr ?? error.message).trim();
    throw new UsageError(`git diff --name-only ${base}...${head} failed: ${detail}`);
  }
}

function main(argv = process.argv.slice(2)) {
  let flags;
  try {
    flags = parseArgs(argv);
    const { root, body, changedPaths } = resolveInputs(flags);
    const result = evaluateSkillImpact({ root, body, changedPaths });
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ ...result, root }, null, 2)}\n`);
    } else {
      for (const violation of result.violations) {
        process.stdout.write(`skill-impact: ${violation.rule}: ${violation.message}\n`);
      }
    }
    return result.ok ? 0 : 1;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`skill-impact: usage: ${error.message}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
