import { describe, expect, it } from "vitest";
import {
  addDays,
  allocationCoversWeek,
  assertAllocationFields,
  capacityWeeks,
  isOverAllocated,
  maximumAllocationSecondsPerWeek,
  maximumCapacityWeeks,
  TrackedResourceInputError,
  weekStartOf,
} from "../src/index.js";

describe("planning weeks (issue 1007)", () => {
  it("[unit] a week begins on the organization's chosen day", () => {
    // 2026-10-07 is a Wednesday.
    expect(weekStartOf("2026-10-07", "monday")).toBe("2026-10-05");
    expect(weekStartOf("2026-10-07", "sunday")).toBe("2026-10-04");
    expect(weekStartOf("2026-10-07", "saturday")).toBe("2026-10-03");
    // A week start is its own week.
    expect(weekStartOf("2026-10-05", "monday")).toBe("2026-10-05");
    expect(weekStartOf("2026-10-11", "monday")).toBe("2026-10-05");
  });

  it("[unit] counts weeks from the one holding `from` to the one holding `to`", () => {
    expect(capacityWeeks("2026-10-07", "2026-10-27", "monday")).toEqual([
      "2026-10-05",
      "2026-10-12",
      "2026-10-19",
      "2026-10-26",
    ]);
    expect(capacityWeeks("2026-10-07", "2026-10-07", "monday")).toEqual(["2026-10-05"]);
  });

  it("[unit] refuses a backwards range and one wider than the limit", () => {
    expect(() => capacityWeeks("2026-10-12", "2026-10-05", "monday")).toThrow(TrackedResourceInputError);
    const first = "2026-01-05";
    expect(capacityWeeks(first, addDays(first, maximumCapacityWeeks * 7 - 1), "monday")).toHaveLength(
      maximumCapacityWeeks,
    );
    expect(() => capacityWeeks(first, addDays(first, maximumCapacityWeeks * 7), "monday")).toThrow(
      /at most 53 weeks/,
    );
  });

  it("[unit] a range covers every week it touches, even by one day", () => {
    const allocation = { startDate: "2026-10-11", endDate: "2026-10-12" };
    expect(allocationCoversWeek(allocation, "2026-10-05")).toBe(true);
    expect(allocationCoversWeek(allocation, "2026-10-12")).toBe(true);
    expect(allocationCoversWeek(allocation, "2026-10-19")).toBe(false);
    expect(allocationCoversWeek(allocation, "2026-09-28")).toBe(false);
  });
});

describe("allocation fields (issue 1007)", () => {
  const good = { startDate: "2026-10-05", endDate: "2026-10-25", plannedSecondsPerWeek: 57_600 };

  it("[unit] accepts a range, including a single day", () => {
    expect(() => assertAllocationFields(good)).not.toThrow();
    expect(() => assertAllocationFields({ ...good, endDate: good.startDate })).not.toThrow();
    expect(() =>
      assertAllocationFields({ ...good, plannedSecondsPerWeek: maximumAllocationSecondsPerWeek }),
    ).not.toThrow();
  });

  it("[unit] refuses an end before the start, a fake date and an out-of-range figure", () => {
    expect(() => assertAllocationFields({ ...good, endDate: "2026-10-04" })).toThrow(/must not precede/);
    expect(() => assertAllocationFields({ ...good, startDate: "2026-02-30" })).toThrow(/real canonical/);
    expect(() => assertAllocationFields({ ...good, plannedSecondsPerWeek: 0 })).toThrow(TrackedResourceInputError);
    expect(() => assertAllocationFields({ ...good, plannedSecondsPerWeek: 1.5 })).toThrow(TrackedResourceInputError);
    expect(() =>
      assertAllocationFields({ ...good, plannedSecondsPerWeek: maximumAllocationSecondsPerWeek + 1 }),
    ).toThrow(TrackedResourceInputError);
  });

  it("[unit] over-allocated means more than capacity, and exactly capacity is not", () => {
    expect(isOverAllocated(72_001, 72_000)).toBe(true);
    expect(isOverAllocated(72_000, 72_000)).toBe(false);
    expect(isOverAllocated(1, 0)).toBe(true);
  });
});
