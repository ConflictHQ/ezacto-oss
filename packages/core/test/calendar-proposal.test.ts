import { describe, expect, it } from "vitest";
import {
  calendarProposalEntryFields,
  calendarProposalTitle,
  TrackedResourceInputError,
  UNTITLED_CALENDAR_EVENT,
} from "../src/index.js";

describe("what a calendar proposal becomes (issue 428)", () => {
  it("[unit] in duration mode keeps the length and invents no start", () => {
    const fields = calendarProposalEntryFields({
      mode: "duration",
      startsAt: "2026-09-01T14:00:00.000Z",
      endsAt: "2026-09-01T15:30:00.000Z",
      timeZone: "UTC",
    });
    expect(fields).toEqual({ kind: "duration", spentDate: "2026-09-01", seconds: 5_400 });
    expect(fields).not.toHaveProperty("startedTime");
  });

  it("[unit] in start/end mode keeps the event's own times on the person's wall clock", () => {
    expect(
      calendarProposalEntryFields({
        mode: "start_end",
        startsAt: "2026-09-01T14:00:00.000Z",
        endsAt: "2026-09-01T15:30:00.000Z",
        timeZone: "America/Costa_Rica",
      }),
    ).toEqual({
      kind: "start_end",
      spentDate: "2026-09-01",
      startedTime: "08:00",
      endedTime: "09:30",
    });
  });

  it("[unit] files the entry on the person's local day, not UTC's", () => {
    // 02:00 UTC on the 2nd is 20:00 on the 1st in Costa Rica (UTC-6).
    expect(
      calendarProposalEntryFields({
        mode: "duration",
        startsAt: "2026-09-02T02:00:00.000Z",
        endsAt: "2026-09-02T03:00:00.000Z",
        timeZone: "America/Costa_Rica",
      }),
    ).toMatchObject({ spentDate: "2026-09-01" });
  });

  it("[unit] measures a duration across a daylight-saving change by elapsed time", () => {
    // New York springs forward on 2026-03-08: 01:30 to 03:30 local is one hour.
    expect(
      calendarProposalEntryFields({
        mode: "duration",
        startsAt: "2026-03-08T06:30:00.000Z",
        endsAt: "2026-03-08T07:30:00.000Z",
        timeZone: "America/New_York",
      }),
    ).toMatchObject({ seconds: 3_600 });
  });

  it("[unit] refuses a start/end event that runs past local midnight", () => {
    expect(() =>
      calendarProposalEntryFields({
        mode: "start_end",
        startsAt: "2026-09-01T23:00:00.000Z",
        endsAt: "2026-09-02T01:00:00.000Z",
        timeZone: "UTC",
      }),
    ).toThrow(TrackedResourceInputError);
  });

  it("[unit] accepts a start/end event that ends exactly at midnight", () => {
    expect(
      calendarProposalEntryFields({
        mode: "start_end",
        startsAt: "2026-09-01T23:00:00.000Z",
        endsAt: "2026-09-02T00:00:00.000Z",
        timeZone: "UTC",
      }),
    ).toEqual({
      kind: "start_end",
      spentDate: "2026-09-01",
      startedTime: "23:00",
      endedTime: "00:00",
    });
  });

  it("[unit] lets a duration entry span midnight, since it records no times", () => {
    expect(
      calendarProposalEntryFields({
        mode: "duration",
        startsAt: "2026-09-01T23:00:00.000Z",
        endsAt: "2026-09-02T01:00:00.000Z",
        timeZone: "UTC",
      }),
    ).toEqual({ kind: "duration", spentDate: "2026-09-01", seconds: 7_200 });
  });
});

describe("a proposal's title", () => {
  it("[unit] is trimmed, named when empty and no longer than a note may be", () => {
    expect(calendarProposalTitle("  Phase 1 review ")).toBe("Phase 1 review");
    expect(calendarProposalTitle("   ")).toBe(UNTITLED_CALENDAR_EVENT);
    expect(calendarProposalTitle(null)).toBe(UNTITLED_CALENDAR_EVENT);
    expect(calendarProposalTitle("x".repeat(20_000))).toHaveLength(10_000);
  });
});
