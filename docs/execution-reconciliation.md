# Execution configuration reconciliation

Evidence checked on 2026-09-15 against fork main
`8e28bc091be780e1679c3669c1d553dfe9f0818b`. This is a source and planning
receipt, not deployment evidence. The fork tracker remains the system of record;
this document explains how the merged artifacts relate to the outstanding draft.

## Merged artifacts

| PR | Merge commit | Scope and check receipt |
| --- | --- | --- |
| [#14](https://github.com/uje-m/bb-plugin-ultragoal/pull/14) | `138f649cd129983c24d18d8ab5e0ecff0cbe06e5` | Exposes `add_slice` to workers and intake, rejects verifier mutation, preserves the root plan surface. PR reports 219 tests with test-concurrency=2, `npx tsc --noEmit`, and `bb plugin build` passing at `a2c0d3c`; these historical checks were read, not rerun here. |
| [#17](https://github.com/uje-m/bb-plugin-ultragoal/pull/17) | `827b5a9fcbcb47279b5613be0b88276c381f7066` | Stop/abort and execution-evidence research; PR reports 45 pinned source citations validated and `git diff --check` passing. |
| [#18](https://github.com/uje-m/bb-plugin-ultragoal/pull/18) | `a014a9ba0b7d32cd3fca1191dce88923d5d1d6e9` | Execution and recovery glossary in `CONTEXT.md`; PR reports `git diff --check` passing. |
| [#20](https://github.com/uje-m/bb-plugin-ultragoal/pull/20) | `a0ef05be9c42f83491aa878dc8a197e2255d7790` | Launch-evidence glossary in `CONTEXT.md`; PR reports `git diff --check` passing. |

GitHub reports all four PRs merged, with no configured status checks and no
submitted PR reviews in their review lists. Merge receipts do not establish
independent review approval. Number [#19](https://github.com/uje-m/bb-plugin-ultragoal/issues/19)
is the intake-capacity issue, not a merged PR. No later code-slice completion is
inferred from this baseline.

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

These are specification decisions. PR #20 records their vocabulary; it does
not implement them. They do not resolve the distinct questions in #7 or #8.

## Outstanding issue dispositions

| Issue | Disposition at this baseline | Remaining acceptance |
| --- | --- | --- |
| [#1](https://github.com/uje-m/bb-plugin-ultragoal/issues/1) | OPEN — draft specification | Reconcile its original proposals with resolved #3–#6 and obtain the separate #7/#8 decisions before declaring the full specification implementation-ready. The draft's historical baseline observations are not current deployment claims. |
| [#2](https://github.com/uje-m/bb-plugin-ultragoal/issues/2) | OPEN — decision map | #3–#6 are resolved; #7/#8 remain the decision frontier. Q5–Q7 above belong to #6. Independently reviewable build tickets and the completed specification are still required for its destination. |
| [#7](https://github.com/uje-m/bb-plugin-ultragoal/issues/7) | OPEN — owner decision missing | Decide whether verifier non-editing requires host permission compatibility or separately enforced read-only execution, identify the proving public capability, and define rejection before allocation. `auto` alone is not proof. PR #14 rejects plan mutation but does not settle this environment contract. |
| [#8](https://github.com/uje-m/bb-plugin-ultragoal/issues/8) | OPEN — owner decision missing | Decide dirty/external work detection, stop failure, restart, cancellation, second edits, and durable old-to-new mapping/target lifetime during rolling replacement. No rolling-replacement approval follows from Q5–Q7. |
| [#12](https://github.com/uje-m/bb-plugin-ultragoal/issues/12) | OPEN — source fix merged; installation acceptance outstanding | PR #14 supplies the source publication receipt. Separately authorized installation must still prove the installed artifact and callable worker/intake/verifier/root surfaces. Do not attribute reconnect/compaction tool loss or blocked-worker healing to this fix. |

At reconciliation, #7 and #8 have no decision comments. No issue above is fully
satisfied, so none is closed by this documentation change.

## Release boundary

The [release handoff receipt](https://github.com/uje-m/bb-plugin-ultragoal/issues/12#issuecomment-5663463518)
records PR #14 as merged and **not installed live**, with publication/install
authority revoked at that handoff. This is a historical receipt, not a fresh
inspection of the running plugin. Subsequent source publication does not prove
installation. The Q5–Q7 receipt grants no installation, restart, deployment, or
live-workflow migration authority. This reconciliation performs none of those
actions and makes no claim about the currently installed artifact.
