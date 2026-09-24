# Owner decision wakeups

UltraGoal's durable wakeup reconciliation targets the Plugin SDK contract in
`package.json` (`bb >= 0.39`, `@get-bb/plugin-sdk >= 0.4.8`). The supported BB
surface is:

- `threads.get`, `threads.send`, and `threads.timeline` for root status,
  dispatch, and authoritative history;
- `threads.queuedMessages.list`, `.create`, and `.update` for a queued wake's
  durable identity and optimistic `updatedAt` check;
- `threads.interactions.list` for provider-bound interaction state.

The wakeup ledger records `pending`, `queued`, `dispatched`, and `unknown`
outcomes. A queued message is edited only through the exact persisted message
id. A failed or unreadable queue/history read holds reconciliation; a failed
send is recorded as `unknown`. Neither case authorizes a blind resend or
adoption of another queued message.

The ledger is one row per owning root. Its revision is incremented for every
event, and settlement uses a compare-and-set revision so events arriving during
an asynchronous send remain outstanding for the next reconciliation pass.
