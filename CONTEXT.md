# UltraGoal Orchestration

UltraGoal coordinates durable goals, slices, and provider-backed workers. This glossary distinguishes ownership, runtime lifecycle, and execution evidence so scheduling decisions do not infer one from another.

## Execution selection

**Goal override**:
An execution-selection field explicitly pinned for one goal instead of inherited from the current global default.
_Avoid_: Goal default, saved default

**Unpinned field**:
An execution-selection field that inherits the current global default when a future launch is resolved.
_Avoid_: Missing field, frozen default

**Effective selection**:
The complete, atomically validated selection produced from goal overrides and current global defaults for a future launch.
_Avoid_: Actual selection, requested selection

**Accepted request selection**:
The host-resolved selection attached to a request that the provider runtime accepted. It is not provider-reported proof of every field.
_Avoid_: Actual selection, echoed arguments

**Provider-reported evidence**:
An execution fact explicitly emitted by the provider, such as a model fallback.
_Avoid_: Requested value, inferred actual value

**Execution revision**:
The identity of one committed execution configuration that orders settings changes against child dispatch.
_Avoid_: Worker generation, display version

**Launch intent**:
The durable declaration of the execution revision and effective selection that one child dispatch must use.
_Avoid_: Spawn arguments, assignment

**Execution drift**:
A present canonical request or provider-reported value that contradicts the launch intent. Missing evidence is unavailable, not drift.
_Avoid_: Unknown execution, inherited change

**Launching unconfirmed**:
A dispatched launch intent for which the provider has not yet emitted matching acceptance.
_Avoid_: Assignment, launch blocked

## Verifier enforcement

**Enforced read-only execution environment**:
A verifier execution environment whose selected provider and host combination is proven to deny file and command mutation for the verifier's lifetime. Approval-mode naming alone does not establish it.
_Avoid_: Auto mode, approval gate, sandbox by name

**Verifier capability proof**:
Positive provider or host evidence, obtained before allocation, that the selected verifier execution can enforce the required read-only capability. A request echo is not proof.
_Avoid_: Requested value, assumed support, configured mode

**Pre-allocation verifier rejection**:
The refusal of a verifier selection whose read-only capability is unavailable or unprovable, before reserving capacity, creating a worktree, or spawning a child.
_Avoid_: Spawn failure, late validation, permission widening

**Goal-scoped worker permission**:
The permission policy one goal applies to its own workers. It is independent of the verifier policy and is never widened to accommodate a verifier provider.
_Avoid_: Installation default, global permission

## Ownership and recovery

**Assignment**:
Durable ownership of one open slice by one worker. It survives ordinary idle turns.
_Avoid_: Active turn, transient claim

**Reservation**:
Durable ownership of a slice and worker slot while a worker launch is being established.
_Avoid_: In-memory lock, cooldown

**Release**:
The durable relinquishment of an assignment or reservation after evidence shows replacement is safe.
_Avoid_: Stop, idle

**Ordinary idle**:
A normally completed provider turn whose worker retains its assignment.
_Avoid_: Released, stopped

**Quarantined attempt**:
An unresolved stop or launch for which an external writer might still exist. It retains ownership and capacity until reconciled.
_Avoid_: Failed launch, expired reservation

**Launch blocked**:
A slice whose bounded launch attempts conclusively failed and that requires a deliberate retry trigger or relevant execution-environment change.
_Avoid_: Quarantined attempt, ordinary pending

**Attempt generation**:
One initial launch and its bounded automatic retries, sharing one retry budget and one idempotent identity.
_Avoid_: Scheduler pass, individual retry

**Roll target revision**:
The one execution revision an active rolling replacement is pinned to for its whole lifetime. A later settings edit does not retarget it.
_Avoid_: Current revision, latest settings

**Replacement mapping**:
The durable per-worker record pairing each replaced worker with its successor, carrying the roll target revision and the successor's evidence state.
_Avoid_: Change log, in-memory transition

**Roll pause**:
Stopping a rolling replacement without releasing ownership or capacity because dirty or external work, stop failure, or unknown evidence makes replacement unsafe.
_Avoid_: Release, cancel

**Frozen roll**:
An owner-cancelled rolling replacement whose remaining ownership and slice context stay held. It neither releases nor redispatches work.
_Avoid_: Aborted roll, released roll
