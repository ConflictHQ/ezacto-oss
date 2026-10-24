import { describe, expect, it } from "vitest";
import {
  calendarEventKey,
  calendarSyncWindow,
  planCalendarSync,
  runCalendarSync,
  type CalendarProposalSnapshot,
  type CalendarSyncAction,
} from "../src/index.js";
import { FakeCalendarSource, sourceEvent } from "./support/fake-calendar-source.js";

const held = (
  event: ReturnType<typeof sourceEvent>,
  status: CalendarProposalSnapshot["status"],
  version: string | null = event.version,
) => new Map<string, CalendarProposalSnapshot>([[calendarEventKey(event), { status, version }]]);

describe("calendar sync window (issue 428)", () => {
  it("[unit] defaults to the past 14 days and no future", () => {
    expect(calendarSyncWindow("2026-10-24T12:00:00.000Z")).toEqual({
      from: "2026-10-10T12:00:00.000Z",
      to: "2026-10-24T12:00:00.000Z",
    });
  });

  it("[unit] caps a configured window and refuses negatives", () => {
    expect(calendarSyncWindow("2026-10-24T00:00:00.000Z", { past: 9_999, future: -5 })).toEqual({
      from: "2026-07-26T00:00:00.000Z",
      to: "2026-10-24T00:00:00.000Z",
    });
  });
});

describe("calendar event eligibility (issue 428)", () => {
  const kinds = (events: ReturnType<typeof sourceEvent>[]) =>
    planCalendarSync(events, new Map()).map((action) => action.kind);

  it("[unit] proposes a timed busy meeting", () => {
    expect(kinds([sourceEvent()])).toEqual(["propose"]);
  });

  it.each([
    ["all-day", { allDay: true }],
    ["declined", { response: "declined" as const }],
    ["free", { showAs: "free" as const }],
    ["out of office", { showAs: "oof" as const }],
    ["zero length", { endsAt: "2026-10-20T15:00:00.000Z" }],
  ])("[unit] does not propose a %s event", (_label, overrides) => {
    expect(kinds([sourceEvent(overrides)])).toEqual([]);
  });

  it("[unit] gives each recurring instance its own identity", () => {
    const a = sourceEvent({ occurrence: "2026-10-20" });
    const b = sourceEvent({ occurrence: "2026-10-27" });
    expect(planCalendarSync([a, b], new Map())).toHaveLength(2);
    expect(calendarEventKey(a)).not.toEqual(calendarEventKey(b));
  });
});

describe("what an edit or cancellation does (issue 428)", () => {
  it("[unit] an edit of a still-proposed event updates it", () => {
    const event = sourceEvent({ version: "v2", summary: "Planning (moved)" });
    expect(planCalendarSync([event], held(event, "proposed", "v1"))).toEqual([{ kind: "update", event }]);
  });

  it("[unit] an edit after accept flags the proposal and never touches the entry", () => {
    const event = sourceEvent({ version: "v2" });
    expect(planCalendarSync([event], held(event, "accepted", "v1"))).toEqual([{ kind: "flag_changed", event }]);
  });

  it("[unit] a cancellation cancels an open proposal but never an accepted one", () => {
    const event = sourceEvent({ cancelled: true });
    expect(planCalendarSync([event], held(event, "proposed"))).toEqual([{ kind: "cancel", event }]);
    expect(planCalendarSync([event], held(event, "accepted"))).toEqual([]);
  });

  it("[unit] a discarded or cancelled meeting is never re-proposed or reopened", () => {
    const event = sourceEvent({ version: "v2" });
    expect(planCalendarSync([event], held(event, "discarded", "v1"))).toEqual([]);
    expect(planCalendarSync([event], held(event, "cancelled", "v1"))).toEqual([]);
  });

  it("[unit] an edit that makes an open proposal ineligible withdraws it", () => {
    const event = sourceEvent({ version: "v2", allDay: true });
    expect(planCalendarSync([event], held(event, "proposed", "v1"))).toEqual([{ kind: "cancel", event }]);
  });

  it("[unit] replaying the same events against the resulting state plans nothing", () => {
    const events = [sourceEvent(), sourceEvent({ eventId: "evt-2" })];
    const state = new Map<string, CalendarProposalSnapshot>();
    const first = planCalendarSync(events, state);
    for (const action of first) {
      state.set(calendarEventKey(action.event), { status: "proposed", version: action.event.version });
    }
    expect(first).toHaveLength(2);
    expect(planCalendarSync(events, state)).toEqual([]);
  });
});

describe("running a sync pass against a source (issue 428)", () => {
  const base = { now: "2026-10-24T12:00:00.000Z", existing: new Map<string, CalendarProposalSnapshot>() };

  it("[unit] reads every page and returns the final cursor", async () => {
    const source = new FakeCalendarSource([[sourceEvent()], [sourceEvent({ eventId: "evt-2" })]]);
    const outcome = await runCalendarSync({ ...base, source, cursor: null });
    expect(outcome.status).toBe("connected");
    expect(outcome.cursor).toBe("cursor-2");
    expect(outcome.actions.map((a: CalendarSyncAction) => a.event.eventId)).toEqual(["evt-1", "evt-2"]);
    expect(source.requests.map((r) => r.page)).toEqual([null, "1"]);
  });

  it("[unit] resumes from a cursor", async () => {
    const source = new FakeCalendarSource([[]]);
    await runCalendarSync({ ...base, source, cursor: "cursor-1" });
    expect(source.requests[0]?.cursor).toBe("cursor-1");
  });

  it("[unit] an expired cursor re-reads the window in full", async () => {
    const source = new FakeCalendarSource([[sourceEvent()]]);
    source.expireCursors = true;
    const outcome = await runCalendarSync({ ...base, source, cursor: "stale" });
    expect(source.requests.map((r) => r.cursor)).toEqual(["stale", null]);
    expect(outcome.status).toBe("connected");
    expect(outcome.actions).toHaveLength(1);
  });

  it("[unit] a refused grant is needs_reauth, keeps the cursor and is not retried", async () => {
    const source = new FakeCalendarSource([[sourceEvent()]]);
    source.refuseGrant = true;
    const outcome = await runCalendarSync({ ...base, source, cursor: "cursor-1" });
    expect(outcome).toEqual({ status: "needs_reauth", cursor: "cursor-1", actions: [] });
    expect(source.requests).toHaveLength(1);
  });

  it("[unit] other failures propagate so the caller retries from the same cursor", async () => {
    const source = new FakeCalendarSource([[]]);
    source.listEvents = async () => {
      throw new Error("provider down");
    };
    await expect(runCalendarSync({ ...base, source, cursor: "cursor-1" })).rejects.toThrow("provider down");
  });
});
