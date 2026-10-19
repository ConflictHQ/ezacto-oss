import { describe, expect, it } from "vitest";
import {
  assertTimeOffFields,
  maximumTimeOffSecondsPerDay,
  TrackedResourceInputError,
  timeOffSecondsInWeek,
} from "../src/index.js";

const hours = (count: number) => count * 3_600;
const valid = {
  startDate: "2026-10-12",
  endDate: "2026-10-14",
  kind: "vacation",
  secondsPerDay: null,
} as const;

describe("time off rules (issue 1007)", () => {
  it("[unit] accepts a whole-day range and a part-day figure", () => {
    expect(() => assertTimeOffFields(valid)).not.toThrow();
    expect(() => assertTimeOffFields({ ...valid, secondsPerDay: hours(4) })).not.toThrow();
    expect(() =>
      assertTimeOffFields({ ...valid, secondsPerDay: maximumTimeOffSecondsPerDay }),
    ).not.toThrow();
  });

  it("[unit] refuses bad dates, a backwards range, an unknown kind and a bad figure", () => {
    expect(() => assertTimeOffFields({ ...valid, startDate: "2026-02-30" })).toThrow(
      expect.objectContaining({ field: "start_date", reasonCode: "invalid_date" }),
    );
    expect(() => assertTimeOffFields({ ...valid, endDate: "2026-10-11" })).toThrow(
      expect.objectContaining({ field: "end_date", reasonCode: "invalid_range" }),
    );
    expect(() => assertTimeOffFields({ ...valid, kind: "sabbatical" })).toThrow(
      expect.objectContaining({ field: "kind", reasonCode: "unsupported" }),
    );
    for (const secondsPerDay of [0, -1, 1.5, maximumTimeOffSecondsPerDay + 1]) {
      expect(() => assertTimeOffFields({ ...valid, secondsPerDay })).toThrow(
        TrackedResourceInputError,
      );
    }
  });

  it("[unit] a whole day removes a fifth of the weekly capacity, weekends nothing", () => {
    // 2026-10-05 is a Monday. Wednesday to Sunday off: Wed, Thu, Fri count.
    const entries = [{ startDate: "2026-10-07", endDate: "2026-10-11", secondsPerDay: null }];
    expect(timeOffSecondsInWeek(entries, "2026-10-05", hours(40))).toBe(hours(24));
    // Part-time: 20 hours a week is 4 hours a day.
    expect(timeOffSecondsInWeek(entries, "2026-10-05", hours(20))).toBe(hours(12));
  });

  it("[unit] counts only the days inside the week, whichever day the week starts", () => {
    const entries = [{ startDate: "2026-10-09", endDate: "2026-10-13", secondsPerDay: hours(2) }];
    // Monday-start week 5 Oct: Fri 9. Next week 12 Oct: Mon 12, Tue 13.
    expect(timeOffSecondsInWeek(entries, "2026-10-05", hours(40))).toBe(hours(2));
    expect(timeOffSecondsInWeek(entries, "2026-10-12", hours(40))).toBe(hours(4));
    // Sunday-start week 11 Oct: Mon 12, Tue 13; the Saturday-Sunday 10 and 11 are skipped.
    expect(timeOffSecondsInWeek(entries, "2026-10-11", hours(40))).toBe(hours(4));
    expect(timeOffSecondsInWeek(entries, "2026-10-19", hours(40))).toBe(0);
  });

  it("[unit] never removes more than the capacity", () => {
    const entries = [{ startDate: "2026-10-05", endDate: "2026-10-09", secondsPerDay: hours(24) }];
    expect(timeOffSecondsInWeek(entries, "2026-10-05", hours(40))).toBe(hours(40));
    expect(timeOffSecondsInWeek([], "2026-10-05", hours(40))).toBe(0);
  });
});
