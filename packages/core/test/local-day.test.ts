import { describe, expect, it } from "vitest";
import { dateInTimeZone, startOfDayInTimeZone, timeInTimeZone } from "../src/local-day.js";

/**
 * Issue 651. A running timer is filed against "today", and today is the
 * operator's, not UTC's.
 */

describe("the day an instant falls on", () => {
  it("[unit] is the local day, not the UTC one, on the evening the two differ", () => {
    // The report, exactly: 23:14 on Saturday 2026-09-12 at UTC-6 is already
    // Sunday in UTC. Every evening session after 18:00 local was landing on the
    // next day, and a Sunday-evening one in the next week's timesheet.
    //
    // Costa Rica rather than Chicago: the report says UTC-6, and Chicago is
    // UTC-5 in September. A zone that observes daylight saving would have made
    // this assertion true for half the year and quietly false for the other.
    const instant = "2026-09-13T05:14:58.220Z";
    expect(dateInTimeZone(instant, "UTC")).toBe("2026-09-13");
    expect(dateInTimeZone(instant, "America/Costa_Rica")).toBe("2026-09-12");
    expect(timeInTimeZone(instant, "America/Costa_Rica")).toBe("23:14");
  });

  it("[unit] works east of UTC too, where the roll goes the other way", () => {
    // 22:40 UTC on the 12th is already the 13th in Tokyo.
    const instant = "2026-09-12T22:40:00.000Z";
    expect(dateInTimeZone(instant, "Asia/Tokyo")).toBe("2026-09-13");
    expect(dateInTimeZone(instant, "UTC")).toBe("2026-09-12");
  });

  it("[unit] follows a daylight-saving change rather than a fixed offset", () => {
    // Chicago is UTC-5 in June and UTC-4... no: UTC-5 in summer, UTC-6 in
    // winter. The same 05:30Z reads 00:30 in June and 23:30 the previous day in
    // January, which a fixed offset could not produce.
    expect(timeInTimeZone("2026-06-01T05:30:00.000Z", "America/Chicago")).toBe("00:30");
    expect(timeInTimeZone("2026-01-01T05:30:00.000Z", "America/Chicago")).toBe("23:30");
    expect(dateInTimeZone("2026-01-01T05:30:00.000Z", "America/Chicago")).toBe("2025-12-31");
  });

  it("[unit] pads to the stored shape", () => {
    expect(dateInTimeZone("2026-01-05T12:00:00.000Z", "UTC")).toBe("2026-01-05");
    expect(timeInTimeZone("2026-01-05T04:05:00.000Z", "UTC")).toBe("04:05");
  });
});

describe("the instant a day begins", () => {
  it("[unit] is midnight UTC in UTC, and later west of it", () => {
    expect(startOfDayInTimeZone("2026-09-08", "UTC")).toBe("2026-09-08T00:00:00.000Z");
    expect(startOfDayInTimeZone("2026-09-08", "America/Costa_Rica")).toBe(
      "2026-09-08T06:00:00.000Z",
    );
  });

  it("[unit] is earlier east of UTC, on the previous UTC day", () => {
    expect(startOfDayInTimeZone("2026-09-08", "Asia/Tokyo")).toBe("2026-09-07T15:00:00.000Z");
  });

  it("[unit] follows the offset in force on that day, not today's", () => {
    expect(startOfDayInTimeZone("2026-01-15", "America/New_York")).toBe(
      "2026-01-15T05:00:00.000Z",
    );
    expect(startOfDayInTimeZone("2026-07-15", "America/New_York")).toBe(
      "2026-07-15T04:00:00.000Z",
    );
    // The day the clocks went forward began before the change, at UTC-5.
    expect(startOfDayInTimeZone("2026-03-08", "America/New_York")).toBe(
      "2026-03-08T05:00:00.000Z",
    );
    // The day after began at UTC-4.
    expect(startOfDayInTimeZone("2026-03-09", "America/New_York")).toBe(
      "2026-03-09T04:00:00.000Z",
    );
  });

  it("[unit] refuses what is not a real calendar day", () => {
    expect(() => startOfDayInTimeZone("2026-02-30", "UTC")).toThrow(RangeError);
    expect(() => startOfDayInTimeZone("2026-2-3", "UTC")).toThrow(RangeError);
  });
});
