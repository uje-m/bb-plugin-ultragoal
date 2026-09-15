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
