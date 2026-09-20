import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createDecisionStore, type DecisionStore } from "./decisions.ts";
import {
  createRootWakeupStore,
  decisionAnswerMarker,
  decisionAnswerMessage,
  decisionIdsInTimeline,
  deliverAnsweredDecisions,
  type PendingDecision,
  type RootWakeupStore,
} from "./decision-delivery.ts";
import { createGoalStore } from "./store.ts";

const hosts: FakePluginHost[] = [];

afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()!.harness.lifecycle.dispose();
});

function hostWithStore(pluginId: string, preCreateOldTable = false): { decisions: DecisionStore } {
  const host = createFakePluginHost({ pluginId });
  hosts.push(host);
  if (preCreateOldTable) {
    // The column must be added to a database that predates it, which is every
    // existing deployment: CREATE TABLE IF NOT EXISTS alone would never touch it.
    host.bb.storage.database().exec(`
      CREATE TABLE goal_decisions (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        question TEXT NOT NULL,
        context TEXT,
        options TEXT,
        status TEXT NOT NULL,
        answer TEXT,
        created_at INTEGER NOT NULL,
        answered_at INTEGER
      );
      INSERT INTO goal_decisions (
        id, thread_id, question, status, answer, created_at, answered_at
      ) VALUES ('dec_legacy', 'thr_root', 'Answered before delivery existed?', 'answered', 'yes', 1, 2);
    `);
  }
  const goals = createGoalStore(host.bb);
  // An owner decision is keyed by a goal row and #38 fails closed without one,
  // so a delivery test must own a real goal before it can request a decision.
  goals.set({ threadId: "thr_root", objective: "Deliver answered decisions", status: "active" });
  return { decisions: createDecisionStore(host.bb) };
}

function pending(id: string, answer = "yes"): PendingDecision {
  return { id, question: `Question for ${id}?`, answer };
}

/** A wakeup ledger over its own fake host, so durability is real SQLite state. */
function wakeupHost(pluginId: string): {
  store: RootWakeupStore;
  db: ReturnType<FakePluginHost["bb"]["storage"]["database"]>;
} {
  const host = createFakePluginHost({ pluginId });
  hosts.push(host);
  const db = host.bb.storage.database();
  return { store: createRootWakeupStore(db), db };
}

function rowCount(
  db: ReturnType<FakePluginHost["bb"]["storage"]["database"]>,
  threadId?: string,
): number {
  const row =
    threadId === undefined
      ? (db.prepare("SELECT COUNT(*) AS n FROM goal_root_wakeups").get() as { n: number })
      : (db
          .prepare("SELECT COUNT(*) AS n FROM goal_root_wakeups WHERE thread_id = ?")
          .get(threadId) as { n: number });
  return row.n;
}

describe("owner decision delivery state", () => {
  it("adds delivered_at to a database created before the column existed", () => {
    const { decisions } = hostWithStore("decision-migrate-test", true);
    // Reading the column proves the migration ran; a missing column throws here.
    // The legacy answered row proves the upgrade neither drops history nor
    // backfills it as delivered — an owner answer still waiting on the root is
    // surfaced by the sweep after the migration, not silently marked done.
    assert.deepEqual(
      decisions.listUndelivered("thr_root").map((decision) => decision.id),
      ["dec_legacy"],
    );
  });

  it("keeps an answered decision undelivered until markDelivered records the steer", () => {
    const { decisions } = hostWithStore("decision-state-test");
    const requested = decisions.request("thr_root", { question: "Proceed?", options: ["Yes"] });
    assert.equal(requested.deliveredAt, null);
    assert.deepEqual(decisions.listUndelivered("thr_root"), []);

    const answered = decisions.resolve("thr_root", requested.id, "answered", "Yes")!;
    assert.equal(answered.status, "answered");
    assert.equal(answered.deliveredAt, null);
    assert.deepEqual(
      decisions.listUndelivered("thr_root").map((decision) => decision.id),
      [requested.id],
    );

    decisions.markDelivered("thr_root", requested.id);
    assert.deepEqual(decisions.listUndelivered("thr_root"), []);
    assert.notEqual(decisions.get("thr_root", requested.id)!.deliveredAt, null);
  });

  it("never treats a withdrawn decision as an owner answer awaiting delivery", () => {
    const { decisions } = hostWithStore("decision-withdrawn-test");
    const requested = decisions.request("thr_root", { question: "Proceed?" });
    decisions.resolve("thr_root", requested.id, "withdrawn", "moot now");
    assert.deepEqual(decisions.listUndelivered("thr_root"), []);
  });
});

describe("answered decision delivery sweep", () => {
  it("defaults delivered_at out of the request path", () => {
    const { decisions } = hostWithStore("decision-request-test");
    const requested = decisions.request("thr_root", { question: "Proceed?" });
    assert.equal(requested.deliveredAt, null);
  });

  it("sends every undelivered answer and records the delivery", async () => {
    const sent: string[] = [];
    const delivered: string[] = [];
    const rows = [pending("dec_a"), pending("dec_b")];
    const result = await deliverAnsweredDecisions({
      pending: rows,
      seenInTimeline: new Set(),
      send: async (_decision, message) => {
        sent.push(message);
        return true;
      },
      markDelivered: (decision) => delivered.push(decision.id),
    });
    assert.deepEqual(sent, rows.map(decisionAnswerMessage));
    assert.deepEqual(delivered, ["dec_a", "dec_b"]);
    assert.deepEqual(result, { delivered: 2, alreadyDelivered: 0, pending: 0 });
  });

  it("retries instead of dropping the answer when the root refuses the steer", async () => {
    const delivered: string[] = [];
    const result = await deliverAnsweredDecisions({
      pending: [pending("dec_a"), pending("dec_b")],
      seenInTimeline: new Set(),
      send: async (decision) => decision.id === "dec_a",
      markDelivered: (decision) => delivered.push(decision.id),
    });
    // dec_b's steer was refused (an open card, an in-flight turn): it stays
    // undelivered for the next pulse rather than vanishing from the board.
    assert.deepEqual(delivered, ["dec_a"]);
    assert.deepEqual(result, { delivered: 1, alreadyDelivered: 0, pending: 1 });
  });

  it("marks an answer already present in the timeline delivered without re-steering", async () => {
    let sends = 0;
    const delivered: string[] = [];
    const result = await deliverAnsweredDecisions({
      pending: [pending("dec_a")],
      seenInTimeline: new Set(["dec_a"]),
      send: async () => {
        sends += 1;
        return true;
      },
      markDelivered: (decision) => delivered.push(decision.id),
    });
    assert.equal(sends, 0);
    assert.deepEqual(delivered, ["dec_a"]);
    assert.deepEqual(result, { delivered: 0, alreadyDelivered: 1, pending: 0 });
  });

  it("recovers the reported stall: answers recorded while another card was open still reach the root", async () => {
    const { decisions } = hostWithStore("decision-stall-test");
    const diskRuling = decisions.request("thr_root", { question: "Reclaim the disk?", options: ["A"] });
    const launchRuling = decisions.request("thr_root", { question: "Launch as prepared?", options: ["Yes"] });
    // The owner answers one ruling while the other card is still open. The steer
    // is refused, but the answer is durable and visible as pending delivery —
    // the state that used to be indistinguishable from a clean board.
    decisions.resolve("thr_root", diskRuling.id, "answered", "A - full reclaim");
    assert.deepEqual(
      decisions.listUndelivered("thr_root").map((decision) => decision.id),
      [diskRuling.id],
    );
    assert.deepEqual(
      decisions.list("thr_root", "open").map((decision) => decision.id),
      [launchRuling.id],
    );

    // Answering the second clears the board; the sweep then delivers both.
    decisions.resolve("thr_root", launchRuling.id, "answered", "Launch as prepared");
    const sent: string[] = [];
    const result = await deliverAnsweredDecisions({
      pending: decisions.listUndelivered("thr_root"),
      seenInTimeline: new Set(),
      send: async (_decision, message) => {
        sent.push(message);
        return true;
      },
      markDelivered: (decision) => decisions.markDelivered("thr_root", decision.id),
    });
    assert.equal(result.delivered, 2);
    assert.equal(sent.length, 2);
    assert.deepEqual(decisions.listUndelivered("thr_root"), []);
  });
});

describe("timeline delivery detection", () => {
  it("finds the exact answer marker in nested timeline rows", () => {
    const marker = decisionAnswerMarker("dec_a");
    const rows = [
      { id: "row_1", content: [{ type: "text", text: `earlier chatter` }] },
      { id: "row_2", content: [{ type: "text", text: `${marker}: "Q?" -> yes.` }] },
    ];
    assert.deepEqual(decisionIdsInTimeline(rows, ["dec_a", "dec_b"]), new Set(["dec_a"]));
  });

  it("does not confuse one decision's marker with another's", () => {
    const rows = [`${decisionAnswerMarker("dec_a")}: done`];
    assert.deepEqual(decisionIdsInTimeline(rows, ["dec_ab"]), new Set());
  });
});

describe("durable per-root wakeup ledger", () => {
  it("coalesces a burst of 100 events into one row per root", () => {
    const { store, db } = wakeupHost("wakeup-coalesce-test");
    for (let index = 0; index < 100; index += 1) {
      store.note("thr_root_a", `change ${index}`, 1000 + index);
    }
    const row = store.get("thr_root_a")!;
    assert.equal(row.revision, 100, "the single row counts every event");
    assert.equal(row.settledRevision, 0);
    assert.equal(row.state, "pending");
    assert.equal(row.summary, "change 99");
    assert.equal(row.createdAt, 1000);
    assert.equal(row.updatedAt, 1099);
    assert.equal(row.queueMessageId, null);
    assert.equal(row.queueUpdatedAt, null);
    assert.equal(rowCount(db, "thr_root_a"), 1, "one row per root, not one row per event");
    assert.equal(store.outstanding("thr_root_a")?.revision, 100);

    store.note("thr_root_b", "second root", 2000);
    assert.equal(rowCount(db, "thr_root_b"), 1);
    assert.equal(store.outstanding("thr_root_b")?.revision, 1);
    assert.deepEqual(
      store.listOutstanding().map((entry) => entry.threadId),
      ["thr_root_a", "thr_root_b"],
      "each root owns its own outstanding wakeup",
    );
  });

  it("refuses a blank summary before writing and trims the one it stores", () => {
    const { store, db } = wakeupHost("wakeup-summary-test");
    assert.throws(() => store.note("thr_root", "   ", 1), /blank/i);
    assert.equal(store.get("thr_root"), null);
    assert.equal(rowCount(db), 0, "a refused note writes nothing at all");
    assert.equal(store.note("thr_root", "  padded  ", 5).summary, "padded");
  });

  it("reports nothing outstanding for a root that never woke", () => {
    const { store } = wakeupHost("wakeup-absent-test");
    assert.equal(store.get("thr_none"), null);
    assert.equal(store.outstanding("thr_none"), null);
    assert.deepEqual(store.listOutstanding(), []);
  });

  it("settles the observed revision exactly once and refuses duplicate, stale and absent settles", () => {
    const { store } = wakeupHost("wakeup-cas-test");
    store.note("thr_root", "one", 1);
    store.note("thr_root", "two", 2);
    store.note("thr_root", "three", 3);

    const settled = store.settle("thr_root", 3, { kind: "dispatched" }, 10)!;
    assert.equal(settled.settledRevision, 3);
    assert.equal(settled.state, "dispatched");
    assert.equal(store.outstanding("thr_root"), null);

    assert.equal(
      store.settle("thr_root", 3, { kind: "dispatched" }, 11),
      null,
      "the same revision cannot settle twice",
    );
    assert.equal(
      store.settle("thr_root", 1, { kind: "queued", messageId: "q1", queueUpdatedAt: 5 }, 12),
      null,
      "a stale revision cannot overwrite the committed settle",
    );
    assert.equal(
      store.settle("thr_absent", 1, { kind: "dispatched" }, 13),
      null,
      "a root with no row has nothing to settle",
    );
    assert.equal(store.get("thr_root")!.updatedAt, 10, "refused CAS attempts write nothing");
    assert.equal(store.get("thr_root")!.state, "dispatched");
  });

  it("keeps a queued message identity across later events instead of re-creating it", () => {
    const { store } = wakeupHost("wakeup-queue-identity-test");
    store.note("thr_root", "first", 1);
    const queued = store.settle(
      "thr_root",
      1,
      { kind: "queued", messageId: "q7", queueUpdatedAt: 5 },
      2,
    )!;
    assert.equal(queued.state, "queued");
    assert.equal(queued.queueMessageId, "q7");
    assert.equal(queued.queueUpdatedAt, 5);
    assert.equal(store.outstanding("thr_root"), null, "a queued message is the outstanding delivery");

    for (let index = 0; index < 5; index += 1) store.note("thr_root", `more ${index}`, 3 + index);
    const outstanding = store.outstanding("thr_root")!;
    assert.equal(outstanding.revision, 6);
    assert.equal(outstanding.state, "queued", "a queued row keeps its state through new events");
    assert.equal(outstanding.queueMessageId, "q7");
    assert.equal(outstanding.queueUpdatedAt, 5);
    assert.equal(outstanding.settledRevision, 1);
  });

  it("refuses a queued outcome with a blank message id or a non-finite timestamp", () => {
    const { store } = wakeupHost("wakeup-invalid-queue-test");
    store.note("thr_root", "work", 1);
    assert.throws(
      () => store.settle("thr_root", 1, { kind: "queued", messageId: "   ", queueUpdatedAt: 1 }, 2),
      /message id/,
    );
    assert.throws(
      () =>
        store.settle(
          "thr_root",
          1,
          { kind: "queued", messageId: "q1", queueUpdatedAt: Number.NaN },
          2,
        ),
      /finite/,
    );
    const row = store.get("thr_root")!;
    assert.equal(row.settledRevision, 0, "a half identity never records a settle");
    assert.equal(row.state, "pending");
    assert.equal(row.queueMessageId, null);
    assert.equal(row.updatedAt, 1);
  });

  it("retains an event that arrived during settlement and yields exactly one follow-up", () => {
    const { store } = wakeupHost("wakeup-during-settle-test");
    store.note("thr_root", "revision one", 1);
    store.note("thr_root", "revision two", 2);

    const applied = store.settle("thr_root", 1, { kind: "dispatched" }, 3)!;
    assert.equal(applied.settledRevision, 1, "the outcome covered only the revision it settled");
    assert.equal(applied.revision, 2, "the newer event is not lost");
    assert.equal(applied.state, "pending");
    assert.equal(store.outstanding("thr_root")!.revision, 2);

    const followUp = store.settle("thr_root", 2, { kind: "dispatched" }, 4)!;
    assert.equal(followUp.settledRevision, 2);
    assert.equal(store.outstanding("thr_root"), null, "exactly one follow-up clears the row");
    assert.equal(store.settle("thr_root", 2, { kind: "dispatched" }, 5), null);
  });

  it("records a queued identity even when a newer event keeps the row pending", () => {
    const { store } = wakeupHost("wakeup-during-settle-queued-test");
    store.note("thr_root", "one", 1);
    store.note("thr_root", "two", 2);
    const applied = store.settle(
      "thr_root",
      1,
      { kind: "queued", messageId: "q9", queueUpdatedAt: 7 },
      3,
    )!;
    assert.equal(applied.settledRevision, 1);
    assert.equal(applied.revision, 2);
    assert.equal(applied.state, "pending", "newer unsettled work is pending again");
    assert.equal(applied.queueMessageId, "q9", "the queued identity is still recorded");
    assert.equal(applied.queueUpdatedAt, 7);
    assert.equal(store.outstanding("thr_root")!.revision, 2);
  });

  it("keeps an unknown send outcome outstanding instead of settling it", () => {
    const { store } = wakeupHost("wakeup-unknown-test");
    store.note("thr_root", "uncertain send", 1);
    const applied = store.settle("thr_root", 1, { kind: "unknown" }, 2)!;
    assert.equal(applied.state, "unknown");
    assert.equal(applied.settledRevision, 0, "an unreadable outcome settles nothing");
    assert.equal(applied.updatedAt, 2);
    assert.equal(store.outstanding("thr_root")?.state, "unknown");

    store.note("thr_root", "more work", 3);
    const afterNote = store.outstanding("thr_root")!;
    assert.equal(afterNote.state, "unknown", "uncertainty survives later events");
    assert.equal(afterNote.revision, 2);
    assert.equal(afterNote.settledRevision, 0);
  });

  it("survives a reload through a second store over the same database", () => {
    const { store, db } = wakeupHost("wakeup-reload-test");
    store.note("thr_root", "pending across reload", 1);
    store.settle("thr_root", 1, { kind: "queued", messageId: "q9", queueUpdatedAt: 7 }, 2);
    store.note("thr_root", "arrived before the reload", 3);

    const reloaded = createRootWakeupStore(db);
    const row = reloaded.get("thr_root")!;
    assert.equal(row.queueMessageId, "q9");
    assert.equal(row.queueUpdatedAt, 7);
    assert.equal(row.revision, 2);
    assert.equal(row.settledRevision, 1);
    assert.equal(row.state, "queued");
    assert.equal(row.summary, "arrived before the reload");
    assert.equal(row.createdAt, 1);
    assert.equal(row.updatedAt, 3);
    assert.deepEqual(reloaded.outstanding("thr_root"), row);
  });
});
