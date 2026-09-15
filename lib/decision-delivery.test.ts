import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createDecisionStore, type DecisionStore } from "./decisions.ts";
import {
  decisionAnswerMarker,
  decisionAnswerMessage,
  decisionIdsInTimeline,
  deliverAnsweredDecisions,
  type PendingDecision,
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

describe("owner decision delivery state", () => {
  it("adds delivered_at to a database created before the column existed", () => {
    const { decisions } = hostWithStore("decision-migrate-test", true);
    // Reading the column proves the migration ran; a missing column throws here.
    assert.deepEqual(decisions.listUndelivered("thr_root"), []);
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
      send: async (decision, message) => {
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
