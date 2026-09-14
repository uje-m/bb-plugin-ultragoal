# Stop, abort, and actual-execution evidence

*Research for [issue #4](https://github.com/uje-m/bb-plugin-ultragoal/issues/4), 2026-09-15. Product code was kept read-only. Sources are limited to bb-plugin-ultragoal at `382de4978da038f306e776fbdc2b458605b87e1d` and public get-bb/bb 0.43.1 at `cca4bd98fab926d8a87dcf137b7b673724f1a1f5`.*

## Decision

The current public BB contracts are sufficient to distinguish these settled lifecycle outcomes, including after a frontend or plugin reload:

1. **Ordinary idle**: the thread is `idle`; the relevant request was accepted by the provider runtime; its turn completed normally; and there is no applicable `manual-stop` interruption.
2. **Explicit stop after execution began**: a `manual-stop` interruption applies to a request that has a matching provider-originated `turn/input/accepted`; the thread has settled from `stopping` to `idle` or `error`.
3. **First-request abort before provider acceptance**: the thread's first `client/turn/requested` exists, a later `manual-stop` applies to it, no `turn/input/accepted.clientRequestId` matches that request, and the thread has settled. During the transition the result is `stop_pending`, not yet an abort.

`idle` alone is never evidence of any of those outcomes. Neither is the return value of `threads.stop`, an UltraGoal `agentRunning` boolean, the child DTO returned by `threads.spawn`, `executionInputSources`, or a plugin configuration callback.

One pre-dispatch case remains impossible to reconstruct from BB alone: stopping a thread while it is still `pending`. BB defines `pending` as “no dispatch ever occurred,” but the stop route treats it as a quiescent runtime release and emits no `manual-stop`. A product that must remember “the user tried to abort before even the first request was recorded” needs its own durable intent receipt written before calling BB. This is distinct from the implementation-ready first-request abort above, where `client/turn/requested` already exists.

For execution identity, BB can currently prove a provider runtime accepted a particular host-resolved request. It cannot provider-attest the complete actual tuple. Model, reasoning effort, and service tier must be presented as **host-resolved and provider-accepted request values**, not “actual,” except that a provider-originated `provider/modelFallback` is authoritative evidence of the fallback model. Permission mode is authoritative as BB's effective host policy after host clamping; there is no normalized receipt that the provider's own sandbox independently reported the same mode.

## Source baseline and terminology

The public source checkout identifies itself as BB 0.43.1 ([`packages/bb-app/package.json:1-4`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/packages/bb-app/package.json#L1-L4)), matching the active `bb --version` result used for this research. The plugin declares BB `>=0.39` and Plugin SDK `>=0.4.8` ([`package.json:36-39`](https://github.com/uje-m/bb-plugin-ultragoal/blob/382de4978da038f306e776fbdc2b458605b87e1d/package.json#L36-L39)). Contracts added after the minimum engine therefore need either an engine-floor increase or a feature check before implementation.

This report uses four deliberately different evidence levels:

| Level | Meaning | Safe UI wording |
|---|---|---|
| requested | A caller supplied a value to `spawn`/`send`; it may never have dispatched. | Requested |
| resolved | BB resolved defaults, overrides, capability checks, and host policy, then recorded the outbound request. | Resolved / dispatched |
| accepted | A provider-runtime event links the resolved request ID to a real provider session. | Provider accepted request |
| provider-reported | A normalized provider-originated event explicitly reports the field. | Actual, naming the evidence |

“Accepted” does not silently promote every field in the request to provider-reported fact.

## Authoritative lifecycle contract

### State is useful, but not sufficient

BB 0.43.1 exposes `pending`, `idle`, `starting`, `active`, `stopping`, and `error`. `pending` explicitly means the thread has never cleared a dispatch attempt and has no provisioned session ([`packages/domain/src/thread-status.ts:3-18`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/packages/domain/src/thread-status.ts#L3-L18)). The lifecycle table makes stop intent durable only from `starting` or `active`: `stop.requested` moves either state to `stopping`, then `stop.settled` moves it to `idle` ([`packages/domain/src/thread-lifecycle.ts:30-65`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/packages/domain/src/thread-lifecycle.ts#L30-L65)).

This gives reliable transient meanings:

- `pending`: no first request dispatched;
- `starting` or `active`: work may be in flight, but acceptance must still come from events;
- `stopping`: an applied stop is in flight;
- `idle`: quiescent only—the reason it became idle must come from events;
- `error`: quiescent after failure, not ordinary idle.

The public stop route returns the same `{ok: true}` shape after calling the lifecycle service ([`apps/server/src/routes/threads/actions.ts:364-372`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/apps/server/src/routes/threads/actions.ts#L364-L372)). The service interrupts a live runtime, cancels a starting/provisioning thread, but merely releases an already-quiescent runtime ([`apps/server/src/services/threads/thread-lifecycle.ts:1377-1424`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/apps/server/src/services/threads/thread-lifecycle.ts#L1377-L1424)). Its upstream fixture verifies that stopping an idle runtime leaves status `idle` and appends no `system/thread/interrupted` event ([`apps/server/test/public/public-thread-stop-runtime.test.ts:32-64`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/apps/server/test/public/public-thread-stop-runtime.test.ts#L32-L64)). Consequently, `threads.stop({threadId}) -> {ok:true}` is command completion, not a classification receipt.

### Events supply the missing reason and execution boundary

The relevant durable events are:

- `client/turn/requested`: server-originated outbound request with `requestId` and the resolved execution tuple ([`packages/domain/src/thread-events.ts:77-103`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/packages/domain/src/thread-events.ts#L77-L103));
- `turn/input/accepted`: provider-originated event with `providerThreadId` and `clientRequestId` ([`packages/domain/src/provider-event.ts:475-507`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/packages/domain/src/provider-event.ts#L475-L507));
- `turn/completed`: provider-originated terminal event whose status is `completed`, `failed`, or `interrupted` ([`packages/domain/src/provider-event.ts:48-53`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/packages/domain/src/provider-event.ts#L48-L53), [`:491-498`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/packages/domain/src/provider-event.ts#L491-L498));
- `system/thread/interrupted`: server-originated event with reason `manual-stop`, `host-daemon-restarted`, or `provider-turn-idle` ([`packages/domain/src/thread-events.ts:271-286`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/packages/domain/src/thread-events.ts#L271-L286));
- `system/thread-provisioning` with status `cancelled`, useful corroboration for a stop during first provisioning ([`packages/domain/src/thread-events.ts:305-323`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/packages/domain/src/thread-events.ts#L305-L323)).

The request-to-acceptance join is intentional, not an inferred naming convention. BB's database helper first reads `turn/input/accepted.clientRequestId`, then finds `client/turn/requested.requestId` with the same value ([`packages/db/src/data/events.ts:1880-1905`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/packages/db/src/data/events.ts#L1880-L1905)); its bulk lookup applies the same join ([`packages/db/src/data/events.ts:2011-2036`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/packages/db/src/data/events.ts#L2011-L2036)). The agent-runtime fixture proves acceptance is emitted only after an accepted command and carries that exact request ID ([`packages/agent-runtime/src/runtime.input-accepted.test.ts:38-86`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/packages/agent-runtime/src/runtime.input-accepted.test.ts#L38-L86)).

The first request is recorded when provisioning begins, before `requestThreadStart` dispatches it to the daemon ([`apps/server/src/services/threads/thread-provisioning.ts:219-250`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/apps/server/src/services/threads/thread-provisioning.ts#L219-L250)). Therefore the absence of a matching acceptance, once the stop is settled and the event stream has been fully read, means the provider runtime did not accept that request. BB's provider-provisioning fixture exercises this path: stop during the initial provider creation settles the thread back to `idle`, tears the abandoned environment down, and permits a later fresh start ([`apps/server/test/threads/environment-providers.test.ts:2955-3014`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/apps/server/test/threads/environment-providers.test.ts#L2955-L3014)).

### Classification rules

Classify one request generation at a time. A generation begins at a `client/turn/requested` sequence and ends immediately before the next non-retry request. Match retries using `retryOfRequestId`; do not let a later retry's acceptance prove the original attempt was accepted.

| Result | Required evidence | Evidence that disqualifies it |
|---|---|---|
| `never_dispatched` | current status `pending`; no `client/turn/requested` | any request event |
| `running_unconfirmed` | `starting`/`active`; request exists; no matching acceptance yet | settled status |
| `running_accepted` | `starting`/`active`; matching acceptance exists | applicable manual stop |
| `stop_pending` | status `stopping`; applicable `manual-stop` exists | none—do not guess the settled subtype yet |
| `ordinary_idle` | status `idle`; matching acceptance; scoped `turn/completed.status=completed`; no applicable manual stop | interrupted/failed completion or manual stop |
| `first_request_aborted` | first request exists; applicable manual stop; no matching acceptance anywhere in the settled generation; status `idle` or `error` | matching acceptance, even if sequenced after the stop event because of delivery race |
| `stopped_after_acceptance` | request and matching acceptance; applicable manual stop; settled `idle`/`error`; normally an interrupted completion | no matching acceptance |
| `failed` | status `error` without a manual stop, or terminal failure | manual stop classification takes precedence only for the same generation |
| `evidence_unavailable` | SDK read failed, pagination incomplete, malformed event, or history boundary unavailable | never turn this into a negative fact |

Association rules:

1. Use `requestId === clientRequestId`, not timing, to associate request and acceptance.
2. Use event sequence and the request-generation interval to associate a thread-scoped `manual-stop` with a request.
3. Use the acceptance event's turn scope to associate `turn/completed`.
4. Treat an acceptance for the same request as decisive even if it is persisted after the manual-stop event; this closes the stop/accept race.
5. Finalize a negative claim (“not accepted”) only after status is no longer `starting`, `active`, or `stopping` and all event pages through the observed terminal high-water mark have been read.
6. Do not classify `host-daemon-restarted` or `provider-turn-idle` as an explicit user stop.

## Reload-safe observation contract

Plugins can access the full public SDK ([`packages/plugin-sdk/src/backend-contract.ts:1928-1945`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/packages/plugin-sdk/src/backend-contract.ts#L1928-L1945)). `threads.events.list` supports event-type filters, ascending/descending ordering, and sequence pagination ([`packages/sdk/src/areas/threads.ts:379-387`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/packages/sdk/src/areas/threads.ts#L379-L387), [`:503-506`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/packages/sdk/src/areas/threads.ts#L503-L506)). That durable stream, combined with `threads.get`, is the source of truth.

The standard plugin lifecycle callback is only a wake-up. Its `thread.idle` payload contains the thread and last assistant text, but no transition reason ([`packages/plugin-sdk/src/backend-contract.ts:267-281`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/packages/plugin-sdk/src/backend-contract.ts#L267-L281)). BB deliberately emits curated callbacks only after transitions into `active`, `idle`, or `error`, not into `stopping` ([`apps/server/src/services/plugins/plugin-thread-events.ts:71-93`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/apps/server/src/services/plugins/plugin-thread-events.ts#L71-L93)). Callback delivery is fire-and-forget, and a plugin disposed between the transition and dispatch receives nothing ([`apps/server/src/services/plugins/plugin-runtime.ts:795-825`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/apps/server/src/services/plugins/plugin-runtime.ts#L795-L825)).

Implementation contract:

1. On plugin load, pane refresh, `thread.active`, `thread.idle`, `thread.failed`, and optional `experimental_thread.events`, call a single projector.
2. The projector reads `threads.get({threadId})`, then pages these event types in sequence order: `client/turn/requested`, `turn/input/accepted`, `turn/completed`, `system/thread/interrupted`, `system/thread-provisioning`, and `provider/modelFallback`.
3. Rebuild the latest generation from durable history. An in-memory cursor may optimize a live tail, but it must be discardable; reload starts from a durable request boundary.
4. Publish a snapshot only after status and event high-water agree. If status changes during the read, retry the bounded projection once or return `evidence_unavailable`/`transitioning`.
5. Never convert an SDK error to an empty event list. Empty means “read succeeded and there were no events”; error means “unknown.”

BB itself also recovers a durable `stopping` thread when a daemon reconnects: if the daemon still reports it active, BB requests stop again; otherwise BB finalizes it ([`apps/server/src/services/threads/thread-lifecycle.ts:1764-1807`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/apps/server/src/services/threads/thread-lifecycle.ts#L1764-L1807)). The plugin need not invent a second stop loop.

For a frontend reload, the existing pane's periodic refresh already provides a reconciliation wake-up ([`app.tsx:291-296`](https://github.com/uje-m/bb-plugin-ultragoal/blob/382de4978da038f306e776fbdc2b458605b87e1d/app.tsx#L291-L296)); the server snapshot must recompute evidence rather than relying on component state.

### Pre-request intent receipt

If issue #4 requires remembering a stop pressed while BB still reports `pending`, persist a plugin-owned receipt before the stop call:

```ts
type StopIntentReceipt = {
  actionId: string;
  threadId: string;
  requestedAt: number;
  preStatus: "pending" | "starting" | "active" | "stopping" | "idle" | "error";
  preEventHighWater: number;
  outcome: "requested" | "settled" | "failed";
  settledClassification: RunLifecycleEvidence["kind"] | null;
};
```

On reload, reconcile every `outcome: "requested"` receipt against BB status and event history before rendering it. This receipt proves UltraGoal issued the command; it does not prove BB applied a stop. For `pending` with no request event, the honest label is `abort_requested_before_dispatch`, not `first_request_aborted`. Preventing a later queued first request also requires cancelling that queued message; `threads.stop` alone does not establish that fact.

The receipt should extend the existing goal/collaboration persistence rather than creating a parallel credential or runtime store. If history of multiple stop attempts is required, a new table needs a written design reason because the current goal and collaboration rows only represent latest state.

## Actual-execution evidence

### What BB records

BB records the resolved execution tuple on `client/turn/requested`; the schema calls recorded execution values historical facts ([`packages/domain/src/thread-events.ts:43-48`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/packages/domain/src/thread-events.ts#L43-L48)). Resolution chooses model, permission mode, reasoning level, and service tier after considering explicit input, overrides, the last execution, project defaults, provider validation, and the host permission ceiling ([`apps/server/src/services/threads/thread-execution-plan.ts:254-348`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/apps/server/src/services/threads/thread-execution-plan.ts#L254-L348)). BB then converts the result into runtime options and a concrete permission policy ([`apps/server/src/services/threads/thread-commands.ts:190-240`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/apps/server/src/services/threads/thread-commands.ts#L190-L240)) and passes provider ID plus those options to the host daemon ([`packages/host-daemon-contract/src/commands.ts:207-221`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/packages/host-daemon-contract/src/commands.ts#L207-L221), [`:275-300`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/packages/host-daemon-contract/src/commands.ts#L275-L300)).

That is stronger than an echo of caller values, but it remains a host-side dispatch record until joined to `turn/input/accepted`.

### Field-by-field contract

| Field | Best authoritative public evidence now | Honest conclusion |
|---|---|---|
| provider | `threads.get().providerId` (thread record) plus a matching provider-originated acceptance carrying `providerThreadId` | Actual provider runtime/session accepted the request. The public thread schema stores provider ID and status ([`packages/domain/src/thread.ts:393-418`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/packages/domain/src/thread.ts#L393-L418)). |
| model | accepted request's `execution.model`; replace with a turn-scoped `provider/modelFallback.fallbackModel` when present | “Dispatched model” unless fallback is provider-reported. The normalized provider schema's only positive model report is fallback ([`packages/domain/src/provider-event.ts:669-686`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/packages/domain/src/provider-event.ts#L669-L686)). |
| reasoning effort | accepted request's `execution.reasoningLevel` | “Dispatched reasoning,” not provider-confirmed actual reasoning. No normalized provider event reports it. |
| service tier | accepted request's `execution.serviceTier` | “Dispatched tier,” not provider-confirmed billing/serving tier. No normalized provider event reports it. |
| permission mode | accepted request's `execution.permissionMode`, after host clamping; runtime mapping yields scope/reviewer | Effective BB host policy for that run. Do not claim independent provider-sandbox attestation. The policy mapping is explicit ([`packages/domain/src/shared-types.ts:495-525`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/packages/domain/src/shared-types.ts#L495-L525)). |

The normalized provider-event union carries `providerThreadId` on actual provider activity and carries no model/reasoning/tier/permission tuple on `turn/input/accepted` or `turn/completed` ([`packages/domain/src/provider-event.ts:475-507`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/packages/domain/src/provider-event.ts#L475-L507)). This absence is the blocker to a truthful “actual execution” tuple.

The plugin's current spawn path does not meet this contract. It calculates fields and sends them as spawn arguments with `executionInputSources`, then trusts the returned child ([`lib/collab.ts:774-830`](https://github.com/uje-m/bb-plugin-ultragoal/blob/382de4978da038f306e776fbdc2b458605b87e1d/lib/collab.ts#L774-L830)). These values prove requested provenance only. Likewise, `PluginAgentConfigurationContext.provider.{id,model}` is resolved synchronously at `thread.start`/`turn.submit`, before the next provider session starts or resumes ([`packages/plugin-sdk/src/backend-contract.ts:1043-1092`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/packages/plugin-sdk/src/backend-contract.ts#L1043-L1092), [`:1502-1524`](https://github.com/get-bb/bb/blob/cca4bd98fab926d8a87dcf137b7b673724f1a1f5/packages/plugin-sdk/src/backend-contract.ts#L1502-L1524)); it is not provider acknowledgement.

### Needed upstream contract for a fully actual tuple

If the UI must use the word “actual” for every field, BB needs a normalized provider/runtime receipt. The smallest extension is an optional `executionEvidence` object on `turn/input/accepted` (or a new event keyed by the same `clientRequestId`):

```ts
type ExecutionFieldEvidence<T> = {
  value: T;
  source: "host-enforced" | "host-dispatched" | "provider-reported";
};

type AcceptedExecutionEvidence = {
  providerId: ExecutionFieldEvidence<string>;       // runtime-session
  model: ExecutionFieldEvidence<string>;
  reasoningLevel: ExecutionFieldEvidence<string>;
  serviceTier: ExecutionFieldEvidence<string>;
  permissionMode: ExecutionFieldEvidence<string>;  // normally host-enforced
};
```

The source tag is mandatory. Providers that do not report reasoning or tier must leave those fields `host-dispatched`; BB must not manufacture `provider-reported` certainty. This change belongs in get-bb/bb, not UltraGoal.

## Current UltraGoal gaps and implementation slice

Current behavior loses the evidence at several boundaries:

- `GoalSnapshot` exposes only `agentRunning: boolean` and no lifecycle or execution evidence ([`contract.ts:150-169`](https://github.com/uje-m/bb-plugin-ultragoal/blob/382de4978da038f306e776fbdc2b458605b87e1d/contract.ts#L150-L169)).
- The pane labels an active-but-not-running goal “Idle,” but labels every non-ticking timer “Stopped,” conflating ordinary quiescence with an explicit stop ([`app.tsx:38-44`](https://github.com/uje-m/bb-plugin-ultragoal/blob/382de4978da038f306e776fbdc2b458605b87e1d/app.tsx#L38-L44), [`:496-501`](https://github.com/uje-m/bb-plugin-ultragoal/blob/382de4978da038f306e776fbdc2b458605b87e1d/app.tsx#L496-L501)).
- `stopThread` sets the in-memory running flag false before calling BB, catches the failure, and returns no receipt; `pauseGoal` persists `paused` before stopping root and crew ([`server.ts:2318-2329`](https://github.com/uje-m/bb-plugin-ultragoal/blob/382de4978da038f306e776fbdc2b458605b87e1d/server.ts#L2318-L2329), [`:2374-2384`](https://github.com/uje-m/bb-plugin-ultragoal/blob/382de4978da038f306e776fbdc2b458605b87e1d/server.ts#L2374-L2384)).
- Agent projection maps BB `stopping` straight to `stopped`; after BB reaches `idle`, it maps based on output text and loses stop provenance ([`lib/collab.ts:103-115`](https://github.com/uje-m/bb-plugin-ultragoal/blob/382de4978da038f306e776fbdc2b458605b87e1d/lib/collab.ts#L103-L115)).
- The existing reusable event scanner is `lib/native-sync.ts`, but its wrapper converts every SDK failure to `[]` ([`lib/native-sync.ts:28-45`](https://github.com/uje-m/bb-plugin-ultragoal/blob/382de4978da038f306e776fbdc2b458605b87e1d/lib/native-sync.ts#L28-L45)). That behavior is acceptable for a best-effort liveness projection and unsafe for negative evidence such as “never accepted.”

Implementation-ready product changes:

1. Extend the event-reading code in `lib/native-sync.ts`; do not add a second generic event service. Add a strict mode/result that distinguishes `{ok:true, events}` from `{ok:false, error}` and supports typed sequence pagination.
2. Add `RunLifecycleEvidence` and `ExecutionEvidence` schemas to `contract.ts`, then expose them on each agent and, where relevant, the root snapshot. Keep `agentRunning` temporarily only if another consumer still requires it; the pane must render from the richer state.
3. Make `stopThread` return a receipt with pre-status, post-status, event high-water, request ID, and classification. Set in-memory running false only from observed BB terminal state. Surface partial crew-stop failures rather than swallowing them.
4. Let `pauseGoal` durably prevent new scheduling first, stop root/crew, then reconcile each receipt. “Goal paused” and “all provider turns confirmed stopped” are separate fields.
5. On load and refresh, rebuild evidence from BB; callbacks only trigger refresh. This is what makes reload correct.
6. Render `Idle`, `Stop pending`, `Aborted before provider acceptance`, `Stopped after provider acceptance`, `Failed`, or `Evidence unavailable`. Reserve `Stopped` for a core-confirmed manual stop.
7. Render execution values with their evidence labels. Never copy spawn inputs into an `actual*` field.

Suggested snapshot shape:

```ts
type RunLifecycleEvidence =
  | { kind: "never_dispatched" }
  | { kind: "running_unconfirmed"; requestId: string }
  | { kind: "running_accepted"; requestId: string; turnId: string }
  | { kind: "stop_pending"; requestId: string | null; stopSeq: number }
  | { kind: "ordinary_idle"; requestId: string; completionSeq: number }
  | { kind: "first_request_aborted"; requestId: string; stopSeq: number }
  | { kind: "stopped_after_acceptance"; requestId: string; turnId: string; stopSeq: number }
  | { kind: "failed"; reason: string | null }
  | { kind: "evidence_unavailable"; reason: string };

type ExecutionEvidence = {
  requestId: string;
  providerId: string;
  providerThreadId: string;
  model: { value: string; level: "accepted-request" | "provider-reported-fallback" };
  reasoningLevel: { value: string; level: "accepted-request" };
  serviceTier: { value: string; level: "accepted-request" };
  permissionMode: { value: string; level: "host-effective" };
};
```

## Required verification fixtures

No existing UltraGoal test covers stop/abort evidence. The implementation ticket should add pure projector fixtures before wiring UI:

1. `pending`, no events -> `never_dispatched`.
2. request -> matching acceptance -> completed -> `ordinary_idle`.
3. first request -> manual stop -> provisioning cancelled -> settled idle, no acceptance -> `first_request_aborted`.
4. request -> matching acceptance -> manual stop -> interrupted completion -> `stopped_after_acceptance`.
5. request -> manual stop -> late matching acceptance -> interrupted completion -> `stopped_after_acceptance`, never abort.
6. status `stopping` -> `stop_pending` even if the stop RPC returned.
7. host restart/provider watchdog interruption -> failed/unknown, never explicit stop.
8. event-list failure or truncated pagination -> `evidence_unavailable`, never abort.
9. instantiate a fresh projector over the same durable rows -> identical result (plugin/frontend reload).
10. stop an idle runtime -> ordinary idle plus immediate `already_quiescent` command result, never a durable manual stop.
11. requested values differ from the recorded request -> recorded values win; a matching acceptance raises them only to accepted-request evidence.
12. provider fallback -> displayed model changes to fallback with provider-reported evidence; later request starts a new generation.

The BB upstream suite already supplies primary-source fixtures for accepted-command emission, idle-runtime release, and stop during first provisioning. It does not appear to contain a single end-to-end fixture asserting the full first-request sequence `requested -> manual-stop -> no accepted -> settled`, nor a reconnect test that begins with a persisted `stopping` row and proves re-dispatch/finalization. Those are upstream coverage gaps, not blockers to the UltraGoal projector tests.

## Blockers and limits

- **Hard blocker for a fully “actual” tuple:** no public normalized provider receipt reports model (except fallback), reasoning effort, service tier, or provider-native permission mode. UltraGoal can ship accurately labeled resolved/accepted evidence now; it cannot honestly relabel it actual.
- **Hard gap for a stop while still `pending`:** BB writes no manual-stop event and the thread has no request ID. A durable UltraGoal intent receipt can remember the action across reload, but only BB can provide a core-confirmed pre-dispatch cancellation event. Cancelling any queued first message must be explicit.
- **Compatibility:** BB 0.43.1's `pending` state and typed event filters are the researched contract. Confirm availability at the plugin's declared BB `>=0.39` floor or raise that floor.
- **Error semantics:** current best-effort event wrappers swallow read failures. Implementation must preserve unknown/error or it will manufacture false abort evidence.
- **No live-system experiment was run:** the task prohibited using an installed plugin or active UltraGoal. Conclusions come from current product source, public BB implementation, and upstream fixtures only.
