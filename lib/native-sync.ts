import type { BbPluginApi } from "@get-bb/plugin-sdk";

// Passive projection of provider thread events, latest sequence wins:
// item/started + item/completed toolCall events for native subagent Task
// calls, scoped to the open turn. A task is live iff it started in the open
// turn and has not completed. When the turn ends, liveness is empty by
// construction — stale ghosts are impossible.

export interface LiveNativeTask {
  /** Provider item id of the Task tool call — stable for started/completed pairing. */
  key: string;
  startedSeq: number;
  startedAt: number;
  tool: string;
}

const PAGE_SIZE = 1000;
const MAX_PAGES_PER_SYNC = 8;
// Cursor interrupts pending Task calls when steered input lands mid-turn and
// never emits item/completed for them (measured: every orphaned Task start on
// the reference thread had a turn/input/accepted right after it). Survivors
// that do outlive a steering boundary complete within ~7 minutes of it. So a
// pending task stays live for GRACE_MS after the latest steering input, and
// for HARD_TTL_MS when no steering has landed since it started.
const STEER_GRACE_MS = 5 * 60_000;
const HARD_TTL_MS = 30 * 60_000;

export type ThreadEventsRead =
  | { ok: true; events: Array<Record<string, unknown>> }
  | { ok: false; reason: string };

export interface ThreadEventsReadArgs {
  threadId: string;
  types?: readonly [string, ...string[]];
  order?: "asc" | "desc";
  limit?: string;
  afterSeq?: string;
  /**
   * Read the whole filtered range up to the newest matching event observed
   * before paging (the high-water mark) instead of one page.
   */
  throughHighWater?: boolean;
}

/** A page is a bare array or an `{events|items}` wrapper; anything else is a
 * malformed read, never an empty one. */
function rowsOfPage(result: unknown): Array<Record<string, unknown>> | null {
  let page: unknown = result;
  if (!Array.isArray(page)) {
    const wrapped = (page ?? {}) as { events?: unknown; items?: unknown };
    page = Array.isArray(wrapped.events) ? wrapped.events : wrapped.items;
  }
  if (!Array.isArray(page)) return null;
  const rows: Array<Record<string, unknown>> = [];
  for (const row of page) {
    if (!row || typeof row !== "object") return null;
    rows.push(row as Record<string, unknown>);
  }
  return rows;
}

async function readEventPage(
  bb: BbPluginApi,
  args: ThreadEventsReadArgs,
): Promise<ThreadEventsRead> {
  try {
    const rows = rowsOfPage(
      await bb.sdk.threads.events.list({
        threadId: args.threadId,
        types: args.types,
        order: args.order,
        limit: args.limit,
        afterSeq: args.afterSeq,
      } as never),
    );
    if (rows === null) return { ok: false, reason: "malformed event page" };
    return { ok: true, events: rows };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The one event reader this plugin classifies from. An SDK error, a malformed
 * page, or a history it could not page through to the high-water mark is a
 * FAILED read, never an empty one: "no evidence" and "evidence of nothing" are
 * different answers and only the caller may decide to treat them alike.
 * Filtering and paging args (`types`, `order`, `afterSeq`, `limit`, bare-array
 * or `{events|items}` shape) behave exactly as the SDK exposes them.
 */
export async function readThreadEvents(
  bb: BbPluginApi,
  args: ThreadEventsReadArgs,
): Promise<ThreadEventsRead> {
  if (!args.throughHighWater) return readEventPage(bb, args);
  const newest = await readEventPage(bb, {
    threadId: args.threadId,
    types: args.types,
    order: "desc",
    limit: "1",
  });
  if (!newest.ok) return newest;
  const newestRow = newest.events[0];
  // A row this reader cannot place on the sequence line is unreadable evidence,
  // not the top of an empty history.
  const mark = newestRow === undefined ? 0 : numericSeq(newestRow);
  if (mark === null) return { ok: false, reason: "event page carried no numeric sequence" };
  const events: Array<Record<string, unknown>> = [];
  let cursor = args.afterSeq ?? "0";
  // A cursor already at or past the mark has nothing left to read.
  let complete = mark === 0 || Number(cursor) >= mark;
  for (let page = 0; page < MAX_PAGES_PER_SYNC && !complete; page += 1) {
    const read = await readEventPage(bb, {
      threadId: args.threadId,
      types: args.types,
      order: "asc",
      afterSeq: cursor,
      limit: String(PAGE_SIZE),
    });
    if (!read.ok) return read;
    const rows = read.events;
    if (rows.length === 0) break;
    const last = numericSeq(rows.at(-1));
    if (last === null) return { ok: false, reason: "event page carried no numeric sequence" };
    events.push(...rows);
    cursor = String(last);
    if (last >= mark) complete = true;
  }
  if (!complete) {
    return {
      ok: false,
      reason: `event history truncated before sequence ${mark} after ${MAX_PAGES_PER_SYNC} pages`,
    };
  }
  return { ok: true, events };
}

/** Fail-silent page read for the native-task liveness scan, which must degrade
 * to "no visible tasks" rather than take its caller down with it. */
async function listEvents(
  bb: BbPluginApi,
  args: ThreadEventsReadArgs,
): Promise<Array<Record<string, unknown>>> {
  const read = await readThreadEvents(bb, args);
  return read.ok ? read.events : [];
}

function seqOf(row: Record<string, unknown>): number {
  return numericSeq(row) ?? 0;
}

/** The row's sequence, or null when the row cannot be placed on the sequence
 * line at all (which the strict reader treats as a malformed page). */
function numericSeq(row: unknown): number | null {
  if (!row || typeof row !== "object") return null;
  const seq = (row as Record<string, unknown>).seq;
  return typeof seq === "number" && Number.isFinite(seq) ? seq : null;
}

function toolCallOf(
  row: Record<string, unknown>,
): { id: string; tool: string } | null {
  const data = row.data;
  if (!data || typeof data !== "object") return null;
  const item = (data as Record<string, unknown>).item;
  if (!item || typeof item !== "object") return null;
  const rec = item as Record<string, unknown>;
  if (rec.type !== "toolCall") return null;
  const id = typeof rec.id === "string" ? rec.id : "";
  const tool = typeof rec.tool === "string" ? rec.tool : "";
  if (!id || !tool) return null;
  return { id, tool };
}

function isNativeTaskTool(tool: string): boolean {
  return /^task\b/i.test(tool) || /^delegate\b/i.test(tool);
}

interface TurnScan {
  boundarySeq: number;
  cursorSeq: number;
  lastInputSeq: number;
  lastInputAt: number;
  open: Map<string, { seq: number; at: number; tool: string }>;
}

const scans = new Map<string, TurnScan>();

function createdAtOf(row: Record<string, unknown>): number {
  const value = row.createdAt;
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

/**
 * One live entry per native subagent Task call in the open turn, in start
 * order. Incremental: each call only reads events after the last scanned
 * sequence, so long turns are paged through once and then tailed cheaply.
 */
export async function listLiveNativeTasks(
  bb: BbPluginApi,
  threadId: string,
): Promise<LiveNativeTask[]> {
  const boundary = await listEvents(bb, {
    threadId,
    types: ["turn/started", "turn/completed"],
    order: "desc",
    limit: "1",
  });
  const latest = boundary[0];
  if (!latest || latest.type !== "turn/started") {
    scans.delete(threadId);
    return [];
  }
  const boundarySeq = seqOf(latest);
  let scan = scans.get(threadId);
  if (!scan || scan.boundarySeq !== boundarySeq) {
    scan = {
      boundarySeq,
      cursorSeq: boundarySeq,
      lastInputSeq: 0,
      lastInputAt: 0,
      open: new Map(),
    };
    scans.set(threadId, scan);
  }

  for (let page = 0; page < MAX_PAGES_PER_SYNC; page += 1) {
    const rows = await listEvents(bb, {
      threadId,
      types: ["item/started", "item/completed", "turn/completed", "turn/input/accepted"],
      order: "asc",
      afterSeq: String(scan.cursorSeq),
      limit: String(PAGE_SIZE),
    });
    if (rows.length === 0) break;
    for (const row of rows) {
      const seq = seqOf(row);
      if (seq > scan.cursorSeq) scan.cursorSeq = seq;
      if (row.type === "turn/completed") {
        scans.delete(threadId);
        return [];
      }
      if (row.type === "turn/input/accepted") {
        scan.lastInputSeq = seq;
        scan.lastInputAt = createdAtOf(row);
        continue;
      }
      const call = toolCallOf(row);
      if (!call) continue;
      if (row.type === "item/started") {
        if (isNativeTaskTool(call.tool)) {
          scan.open.set(call.id, { seq, at: createdAtOf(row), tool: call.tool });
        }
      } else {
        // Completion may carry a rewritten tool name (OpenCode retitles the
        // task call with the subagent's title), so match by id only —
        // filtering by tool here left every completed task dangling open.
        scan.open.delete(call.id);
      }
    }
    if (rows.length < PAGE_SIZE) break;
  }

  const now = Date.now();
  const live: Array<[string, { seq: number; at: number; tool: string }]> = [];
  for (const entry of scan.open.entries()) {
    const [, value] = entry;
    const steeredSince = scan.lastInputSeq > value.seq;
    const alive = steeredSince
      ? now - scan.lastInputAt < STEER_GRACE_MS
      : now - value.at < HARD_TTL_MS;
    if (alive) live.push(entry);
  }
  return live
    .sort((a, b) => a[1].seq - b[1].seq)
    .map(([key, value]) => ({
      key,
      startedSeq: value.seq,
      startedAt: value.at,
      tool: value.tool,
    }));
}

/** True when any native Task call is pending in the open turn (pre-grace). */
export function hasPendingNativeTasks(threadId: string): boolean {
  const scan = scans.get(threadId);
  if (!scan) return false;
  const now = Date.now();
  for (const value of scan.open.values()) {
    const steeredSince = scan.lastInputSeq > value.seq;
    const alive = steeredSince
      ? now - scan.lastInputAt < STEER_GRACE_MS
      : now - value.at < HARD_TTL_MS;
    if (alive) return true;
  }
  return false;
}

export function forgetNativeScan(threadId: string): void {
  scans.delete(threadId);
}
