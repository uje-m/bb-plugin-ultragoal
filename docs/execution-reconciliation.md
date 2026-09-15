# Execution configuration reconciliation

Evidence checked on 2026-09-15 against fork integration ref
`8e28bc091be780e1679c3669c1d553dfe9f0818b`. This is a source and planning
receipt, not deployment evidence. The fork tracker remains the system of record;
this document explains how the merged artifacts, the settled decisions, and the
fork implementation tickets relate.

## Merged artifacts

| PR | Merge commit | Scope and check receipt |
| --- | --- | --- |
| [#14](https://github.com/uje-m/bb-plugin-ultragoal/pull/14) | `138f649cd129983c24d18d8ab5e0ecff0cbe06e5` | Exposes `add_slice` to workers and intake, rejects verifier mutation, preserves the root plan surface. PR reports 219 tests with test-concurrency=2, `npx tsc --noEmit`, and `bb plugin build` passing at `a2c0d3c`; these historical checks were read, not rerun here. |
| [#17](https://github.com/uje-m/bb-plugin-ultragoal/pull/17) | `827b5a9fcbcb47279b5613be0b88276c381f7066` | Stop/abort and execution-evidence research; PR reports 45 pinned source citations validated and `git diff --check` passing. |
| [#18](https://github.com/uje-m/bb-plugin-ultragoal/pull/18) | `a014a9ba0b7d32cd3fca1191dce88923d5d1d6e9` | Execution and recovery glossary in `CONTEXT.md`; PR reports `git diff --check` passing. |
| [#20](https://github.com/uje-m/bb-plugin-ultragoal/pull/20) | `a0ef05be9c42f83491aa878dc8a197e2255d7790` | Launch-evidence glossary in `CONTEXT.md`; PR reports `git diff --check` passing. |
| [#16](https://github.com/uje-m/bb-plugin-ultragoal/pull/16) | `8e28bc091be780e1679c3669c1d553dfe9f0818b` | Refuses automatic integration of a worker environment that declares no merge base. This is the integration ref this reconciliation was read against. |

GitHub reports all five PRs merged, with no configured status checks and no
submitted PR reviews in their review lists. Merge receipts do not establish
independent review approval. Number [#19](https://github.com/uje-m/bb-plugin-ultragoal/issues/19)
is the intake-capacity issue, not a merged PR. No later code-slice completion is
inferred from this baseline.

## Owner rulings that completed the decision frontier

Both rulings were recorded on the fork tracker on 2026-09-15. They are quoted
here from the tracker; if this document and the tracker ever disagree, the
tracker comment is authoritative.

### #7 — the verifier's non-editing contract

Exact ruling, approved 2026-09-15 in UltraGoal decision `dec_mu239a7w_08ko65`,
recorded at
[#7 comment 5674132832](https://github.com/uje-m/bb-plugin-ultragoal/issues/7#issuecomment-5674132832):

- Verifier non-editing requires a separately enforced read-only execution environment; approval-mode naming alone is insufficient.
- Before allocation, resolve the complete verifier selection and prove that the selected provider/host combination can enforce the required read-only capability.
- Reject unavailable/unprovable capability and full-only verifier selections before reserving capacity, creating a worktree, or spawning a child.
- Never silently widen verifier permission, reinterpret `auto` as proof, or treat a request echo as enforcement evidence.
- Surface an actionable rejection naming the incompatible selection and the required read-only capability.
- Preserve worker goal-scoped permission independently; this ruling does not force workers into verifier policy.

This resolves the decision ticket and authorizes specification plus downstream
fork implementation through the existing reviewed, PR-based UltraGoal plan. It
grants no installation, restart, deployment, or live-workflow migration
authority. The ticket was closed with the resolution note at
[#7 comment 5674133076](https://github.com/uje-m/bb-plugin-ultragoal/issues/7#issuecomment-5674133076).

### #8 — rolling replacement interruption and recovery

Exact ruling, approved 2026-09-15 in UltraGoal decision `dec_mu2399hy_3el515`,
recorded at
[#8 comment 5674125633](https://github.com/uje-m/bb-plugin-ultragoal/issues/8#issuecomment-5674125633):

- Pin one immutable target execution revision for the lifetime of a rolling replacement.
- Replace one worker at a time and persist each old→new worker mapping with the target revision and evidence state.
- Pause without releasing ownership or capacity when dirty/external work, stop failure, or unknown evidence makes replacement unsafe.
- Resume the same durable roll after restart.
- Owner cancellation freezes the roll; it does not silently release or redispatch work.
- A second settings edit does not retarget the active roll. It applies to future ordinary launches and, if requested, a later roll.
- Preserve the slice brief, findings, checks, integration base, and durable ownership throughout replacement.

This resolves the decision ticket. It authorizes specification and downstream
fork implementation through the existing reviewed, PR-based UltraGoal plan. It
does not authorize plugin installation, restart, deployment, or live-workflow
migration. The ticket was closed with the resolution note at
[#8 comment 5674125796](https://github.com/uje-m/bb-plugin-ultragoal/issues/8#issuecomment-5674125796).

## Owner Q5–Q7 scope

The [exact owner receipt](https://github.com/uje-m/bb-plugin-ultragoal/issues/2#issuecomment-5673834619)
confirms the launch-ordering decisions already resolved in
[#6](https://github.com/uje-m/bb-plugin-ultragoal/issues/6#issuecomment-5672482237):

- Q5: after five minutes without matching acceptance, quarantine the launch,
  retain its slot, and emit one actionable escalation. Late evidence may
  reconcile it; elapsed time alone never releases or retries it.
- Q6: compare normalized launch intent with the canonical requested record
  joined to provider acceptance. Present unequal values are drift; missing
  values are unavailable. Provider-reported fallback is drift; equivalent
  null/default representations compare equal.
- Q7: settings readback includes the new revision and effective selection plus
  every live older-revision launch and its evidence state. A fallback dispatch
  after a settings commit must refresh or yield.

Q5–Q7 belong to #6 and are consumed by ticket T4 below. They do not resolve the
distinct questions in #7 or #8.

## Settled decision contract

The draft specification [#1](https://github.com/uje-m/bb-plugin-ultragoal/issues/1)
and the Wayfinder map [#2](https://github.com/uje-m/bb-plugin-ultragoal/issues/2)
proposed semantics and named two remaining owner decisions. Both decisions are
now recorded above, so the specification carries no unresolved question.

| Decision | Settled semantics | Consumed by |
| --- | --- | --- |
| [Inheritance and atomic selection edits](https://github.com/uje-m/bb-plugin-ultragoal/issues/3) | Unpinned fields inherit the current global default at each future launch; the complete resulting selection validates atomically; dependent pins are cleared explicitly in the same edit; no silent substitution, downgrade, or discard. | T2, T4, T5, T6 |
| [Stop, abort, and actual-execution evidence](https://github.com/uje-m/bb-plugin-ultragoal/issues/4) | Lifecycle and execution facts come only from a reload-safe durable event projection; unavailable evidence stays unavailable; dispatched or echoed values are never labeled actual. | T1, T4, T7, T8 |
| [Release and bounded recovery](https://github.com/uje-m/bb-plugin-ultragoal/issues/5) | Only durable evidence of manual stop, first-request abort, or terminal failure releases and requeues; uncertain effects quarantine ownership and capacity; retries are bounded at 15s/1m/5m and end in `launch blocked`; one pass per goal with a durable dirty generation. | T1, T8 |
| [Launch ordering and attestation](https://github.com/uje-m/bb-plugin-ultragoal/issues/6) | A durable execution revision orders dispatch; a launch intent precedes every dispatch; ownership promotes only on matching provider acceptance; confirmed drift fails closed; readback lists older-revision launches (including Q5–Q7). | T4, T5, T7 |
| [The verifier's non-editing contract](https://github.com/uje-m/bb-plugin-ultragoal/issues/7) | Verifier non-editing requires a separately enforced read-only environment, proven before allocation; unprovable or full-only selections are rejected before capacity, worktree, or child allocation; worker permission stays goal-scoped and independent. | T3, T8 |
| [Rolling replacement interruption and recovery](https://github.com/uje-m/bb-plugin-ultragoal/issues/8) | One immutable roll target revision; one worker at a time with a durable old→new mapping; pause without release; resume the same roll after restart; owner cancellation freezes; a second edit does not retarget. | T8 |

The conditions the draft left open are therefore closed: inheritance lifetime,
partial pins, cancellation evidence, stop failure, retry policy, the
update-versus-dispatch ordering boundary, unknown and mismatched attestation,
verifier enforcement, and rolling-replacement recovery. The draft's testing
seam is unchanged — the fake BB host driving real plugin registration, CLI, RPC,
agent tools, lifecycle events, reload, and real SQLite stores. Neither ruling
authorizes a controlled live check: proof that a provider actually enforces
read-only execution remains separately authorized work and must not be inferred
from a merged candidate.

## Fork implementation tickets

Eight tickets carry the settled contract. They adopt the scope and dependency
order of the eight upstream build tickets as references while owning their own
decisions and execution.

`T1` [#22](https://github.com/uje-m/bb-plugin-ultragoal/issues/22) · scheduler convergence after stop, abort, or release · upstream [#4](https://github.com/braedonsaunders/bb-plugin-ultragoal/issues/4) · depends on: frontier
`T2` [#23](https://github.com/uje-m/bb-plugin-ultragoal/issues/23) · global worker and verifier execution defaults · upstream [#5](https://github.com/braedonsaunders/bb-plugin-ultragoal/issues/5) · depends on: frontier
`T3` [#24](https://github.com/uje-m/bb-plugin-ultragoal/issues/24) · goal-scoped worker permission and proven read-only verifiers · upstream [#6](https://github.com/braedonsaunders/bb-plugin-ultragoal/issues/6) · depends on: frontier
`T4` [#25](https://github.com/uje-m/bb-plugin-ultragoal/issues/25) · launch from the latest persisted execution settings · upstream [#7](https://github.com/braedonsaunders/bb-plugin-ultragoal/issues/7) · depends on: T1
`T5` [#26](https://github.com/uje-m/bb-plugin-ultragoal/issues/26) · atomic execution configuration at start · upstream [#8](https://github.com/braedonsaunders/bb-plugin-ultragoal/issues/8) · depends on: T2
`T6` [#27](https://github.com/uje-m/bb-plugin-ultragoal/issues/27) · complete validated CLI execution controls · upstream [#9](https://github.com/braedonsaunders/bb-plugin-ultragoal/issues/9) · depends on: T2
`T7` [#28](https://github.com/uje-m/bb-plugin-ultragoal/issues/28) · effective and actual execution state everywhere · upstream [#10](https://github.com/braedonsaunders/bb-plugin-ultragoal/issues/10) · depends on: T2, T4
`T8` [#29](https://github.com/uje-m/bb-plugin-ultragoal/issues/29) · controlled rolling replacement for active workers · upstream [#11](https://github.com/braedonsaunders/bb-plugin-ultragoal/issues/11) · depends on: T1, T3, T4, T6

T5 is deliberately not a T8 dependency. T5 orders *goal creation* against its first
allocation, while a rolling replacement dispatches new workers inside an
already-created goal through T4's dispatch boundary; the draft's published
dependency order names exactly scheduler convergence, permissions, latest
persisted settings, and CLI controls for rolling replacement, and no ruling
adds an edge to atomic start.

Each ticket body carries one strict candidate-only Factory manifest — the same
shape as the earlier dry-run input, with `candidateOnly: true`, the file fence,
one write claim per fenced file, and the machine checks `npx tsc --noEmit` and
`npx tsx --test --test-concurrency=4 lib/*.test.ts`. Dependency edges are
explicit in the ticket body; the manifest's `files` and `claims` are generated
from a single fence list so they cannot disagree.

Boundaries that apply to all eight:

- **Candidate-only.** One direct `code-factory-pi` run produces a candidate on a
  branch in the fork checkout and stops. Factory Feeder is not used and no
  `ready-for-agent` label is applied, so nothing here can be sourced automatically.
- **Serialized staffing.** Candidates run one at a time. Dependency edges express
  specification order; because claims are file-granular, two tickets sharing a
  file are never staffed concurrently.
- **No release authority.** No push, PR, merge, default-branch landing, plugin
  installation or restart, deployment, live-goal or live-workflow migration, or
  CI/runner/merge-policy change follows from these tickets or from the rulings.

## Outstanding issue dispositions

| Issue | Disposition at this reconciliation | Remaining acceptance |
| --- | --- | --- |
| [#1](https://github.com/uje-m/bb-plugin-ultragoal/issues/1) | OPEN — reconciled draft | Its original proposals are reconciled above against resolved #3–#8, including the #7/#8 rulings. Closing it is a separate reviewed decision, not a side effect of filing tickets. |
| [#2](https://github.com/uje-m/bb-plugin-ultragoal/issues/2) | OPEN — decision map | Every decision ticket is closed and the eight implementation tickets above now exist. Remaining acceptance is scheduling them and the separately reviewed specification approval. |
| [#7](https://github.com/uje-m/bb-plugin-ultragoal/issues/7) | CLOSED — owner ruling `dec_mu239a7w_08ko65` | Implemented by T3 and consumed by T8; the enforced-read-only contract is not proven until T3's pre-allocation rejection and capability proof exist. |
| [#8](https://github.com/uje-m/bb-plugin-ultragoal/issues/8) | CLOSED — owner ruling `dec_mu2399hy_3el515` | Implemented by T8. No rolling-replacement approval follows from Q5–Q7. |
| [#12](https://github.com/uje-m/bb-plugin-ultragoal/issues/12) | OPEN — source fix merged; installation acceptance outstanding | PR #14 supplies the source publication receipt. Separately authorized installation must still prove the installed artifact and callable worker/intake/verifier/root surfaces. Do not attribute reconnect/compaction tool loss or blocked-worker healing to this fix. |

At reconciliation, no issue above is fully satisfied, so none is closed by this
documentation change. The rulings authorized specification and downstream fork
implementation; they did not authorize closing #1 or #2.

## Release boundary

The [release handoff receipt](https://github.com/uje-m/bb-plugin-ultragoal/issues/12#issuecomment-5663463518)
records PR #14 as merged and **not installed live**, with publication/install
authority revoked at that handoff. This is a historical receipt, not a fresh
inspection of the running plugin. Subsequent source publication does not prove
installation. The Q5–Q7 receipt and the #7/#8 rulings grant no installation,
restart, deployment, or live-workflow migration authority. This reconciliation
performs none of those actions and makes no claim about the currently installed
artifact; nothing in it was installed, restarted, deployed, or migrated.

## Verification

A standalone Node check was written before the change and run against this
worktree plus the fork tracker. It failed on the unreconciled state (37 of 47
assertions) and passes after it, asserting: every bullet of each owner ruling
appears verbatim in this document with its decision id and comment link; the
seven vocabulary terms added to `CONTEXT.md` are present; exactly the eight
program tickets are open with the upstream reference, dependency edge, and
candidate-only manifest described above; every fenced file exists in the tree
and matches its write claims and `maxChangedFiles`; #1 and #2 remain open with a
reconciliation receipt; and no installation or deployment is claimed. The check
is independent of the repository's own `npm test` and `npx tsc --noEmit` gates.
