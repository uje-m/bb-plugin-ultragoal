# Contributing

This repository is a bb plugin whose behavior reaches users through three
surfaces: the registered tools in `server.ts`, the orchestration and permission
rules in non-test `lib/**`, and the instruction text shipped in `skills/**` and
`templates/**`. A change to any of them can silently change how every provider
runs an UltraGoal, so every such PR states its skill impact in the PR body and
CI validates that statement.

## Skill impact declaration

A behavior-affecting path is any of:

- `server.ts`, `host.ts`, `contract.ts`, `host-contract.ts`
- `lib/**`, except `lib/**/*.test.ts`
- `skills/**`
- `templates/**`

When the diff touches at least one of those paths, the PR body must contain
**exactly one** declaration line:

```text
Skill impact: updated — <what tool, command, orchestration, permission or instruction-template behavior changed>
Skill impact: none — <why this change touches no behavior those surfaces depend on>
```

Format rules, all enforced by the check:

- an optional list marker — blockquote, heading and emphasis decoration around
  the keyword is tolerated — then the exact keyword `Skill impact:`, then
  `updated` or `none`, then a separator (`—`, `–` or `-`), then a rationale;
- the rationale must be real prose: not empty, no `<placeholder>` text, and not
  a bare `todo`, `tbd`, `n/a`, `na`, `none`, `no impact`, `not applicable` or
  `no change`;
- `updated` requires at least one changed `skills/**` or `templates/**` path;
- `none` contradicts a changed `skills/**` or `templates/**` path;
- two declarations (even identical ones) fail the check, as does a malformed
  line.

A diff that touches none of those paths needs no declaration, but a declaration
that is present is still validated. `.github/pull_request_template.md` carries
the section; replace the rationale placeholder before opening the PR, because
the unedited template deliberately fails the check.

## What the check also validates

- **Bundled skills.** Every directory under `skills/` must contain a `SKILL.md`
  with non-empty `name` and `description` frontmatter, and `name` must equal the
  directory name. `package.json` must list `skills` in `files` and in
  `bb.skills`.
- **Documented tool names.** Inline code names in `skills/**/*.md` and
  `templates/**` are compared against the canonical registry derived from
  `bb.agents.registerTool({ name: ... })`, `COLLAB_TOOL_NAMES` and the `tools:`
  surfaces in `server.ts`. A documented name that exists on no role surface is a
  violation; a name available only on a worker/verifier surface is fine.

## Run it locally

```sh
node scripts/check-skill-impact.mjs --no-diff                # this checkout, diff rules see an empty diff
node scripts/check-skill-impact.mjs --changed server.ts,skills/ultragoal/SKILL.md
node scripts/check-skill-impact.mjs --body-file pr-body.md --changed server.ts
node scripts/check-skill-impact.mjs --base origin/main --head HEAD
node scripts/check-skill-impact.mjs --json                   # machine-readable result
node --test scripts/check-skill-impact.test.mjs              # checker's own tests
```

Exit codes: `0` pass, `1` violations (one `skill-impact:` line per violation),
`2` usage or setup error. The checker is dependency-free, never writes files and
never uses the network. Flags are `--root`, `--body-file`, `--changed`, `--base`,
`--head`, `--no-diff` and `--json`; anything not passed explicitly falls back to
the `pull_request` payload at `GITHUB_EVENT_PATH` (body, `base.sha`,
`head.sha`), and changed paths fall back to a local
`git diff --name-only --no-renames -z <base>...<head>` (renames and deletions
are visible as changes to their old path, and non-ASCII paths are not quoted).
With no changed-path source at all — no `--changed`, no `--base` with `--head`,
no payload carrying both shas, no `--no-diff` — the check exits `2` instead of
silently evaluating an empty diff and reporting success.

## CI and the required check

`.github/workflows/skill-impact.yml` runs on `pull_request` with types
`[opened, synchronize, reopened, edited]`, so PR-body edits re-run it. It is
read-only (`permissions: contents: read`), checks out with
`fetch-depth: 0` and `persist-credentials: false`, reads PR metadata from the
event payload file rather than interpolating it into shell text, and has no
`paths:` filter so it reports on every PR.

The job and status name is exactly **`skill-impact`**. This is an activation gap
an owner must close once: a workflow alone is not a merge gate, so the owner has
to add `skill-impact` as a required status check in the repository's branch
protection or ruleset. Until that is done the check reports but does not block
a merge. This repository does not mutate branch protection from a PR.

## Slice acceptance checklist

- [ ] The branch is one behavioral concern and can be reverted on its own.
- [ ] The diff stays inside the file fence named by the slice or issue.
- [ ] The PR body carries exactly one honest skill-impact declaration line.
- [ ] Behavior changes have a focused runnable check (happy path plus an edge
      case), and it passes locally.
- [ ] Type and test commands for the touched area were run and their results are
      in the PR description.
- [ ] No new dependency was added without an explicit decision recorded in the
      slice.

## Release review checklist

- [ ] `npm ci && npx tsc --noEmit -p tsconfig.json` is clean.
- [ ] `npx tsx --test --test-concurrency=4 lib/*.test.ts` is green.
- [ ] `node --test scripts/check-skill-impact.test.mjs` is green.
- [ ] Every bundled skill has valid frontmatter and `package.json` still lists
      `skills` in `files` and `bb.skills`.
- [ ] Every tool name documented in `skills/**` and `templates/**` exists on a
      registered role surface.
- [ ] `skills/**` and `templates/**` changes were reviewed as instruction
      behavior, not as prose: they change what workers and roots are told to do.
- [ ] `package.json` version and `CHANGELOG.md` reflect the release.
- [ ] The release PR is green on `skill-impact` and every other required check,
      and it is landed by merge, not by squashing unfinished slices together.
