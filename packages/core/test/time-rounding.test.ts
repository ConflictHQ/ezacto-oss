import { describe, expect, it } from "vitest";
import {
  assertTimeRoundingPolicy,
  defaultTimeRounding,
  describeTimeRounding,
  effectiveTimeRounding,
  legacyTimeRoundings,
  roundTimeSeconds,
  timeRoundingFromLegacy,
  timeRoundingIncrementLabel,
  timeRoundingIncrements,
  timeRoundingModes,
  type TimeRoundingMinutes,
  type TimeRoundingMode,
} from "../src/time-rounding.js";

/**
 * Issue 949. Each mode against each increment, at the three places a rounding
 * rule can be wrong by a second: exactly on an increment, one second under it,
 * and one second over it -- and, for `nearest`, either side of the half.
 */
const expectations = (
  mode: TimeRoundingMode,
  minutes: TimeRoundingMinutes,
): ReadonlyArray<readonly [label: string, seconds: number, expected: number]> => {
  const step = minutes * 60;
  const on = 2 * step;
  const half = step / 2;
  switch (mode) {
    case "exact":
      return [
        ["zero", 0, 0],
        ["exactly on", on, on],
        ["1 s under", on - 1, on - 1],
        ["1 s over", on + 1, on + 1],
      ];
    case "up":
      return [
        ["zero", 0, 0],
        ["1 s", 1, step],
        ["exactly on", on, on],
        ["1 s under", on - 1, on],
        ["1 s over", on + 1, on + step],
      ];
    case "down":
      return [
        ["zero", 0, 0],
        ["1 s", 1, 0],
        ["exactly on", on, on],
        ["1 s under", on - 1, on - step],
        ["1 s over", on + 1, on],
      ];
    case "nearest":
      return [
        ["zero", 0, 0],
        ["1 s", 1, 0],
        ["exactly on", on, on],
        ["1 s under", on - 1, on],
        ["1 s over", on + 1, on],
        ["1 s under the half", on + half - 1, on],
        ["exactly the half", on + half, on + step],
        ["1 s over the half", on + half + 1, on + step],
      ];
  }
};

describe("time rounding", () => {
  for (const mode of timeRoundingModes) {
    for (const minutes of timeRoundingIncrements) {
      it(`[unit] rounds ${mode} to ${minutes} min at every boundary`, () => {
        for (const [label, seconds, expected] of expectations(mode, minutes)) {
          expect(
            roundTimeSeconds(seconds, { mode, minutes }),
            `${mode}/${minutes} ${label} (${seconds} s)`,
          ).toBe(expected);
        }
      });
    }
  }

  it("[unit] offers exactly the four directions and six increments the issue names", () => {
    expect(timeRoundingModes).toEqual(["exact", "up", "down", "nearest"]);
    expect(timeRoundingIncrements).toEqual([6, 10, 15, 20, 30, 60]);
    expect(timeRoundingIncrements.map(timeRoundingIncrementLabel)).toEqual([
      "6 min (1/10 hour)",
      "10 min (1/6 hour)",
      "15 min (1/4 hour)",
      "20 min (1/3 hour)",
      "30 min (1/2 hour)",
      "1 hour",
    ]);
  });

  it("[unit] refuses a negative, fractional or unsafe duration and an unknown rule", () => {
    expect(() => roundTimeSeconds(-1, defaultTimeRounding)).toThrow(/non-negative/);
    expect(() => roundTimeSeconds(1.5, { mode: "up", minutes: 6 })).toThrow(/safe integer/);
    expect(() => roundTimeSeconds(Number.MAX_SAFE_INTEGER + 1, defaultTimeRounding)).toThrow(
      /safe integer/,
    );
    expect(() =>
      roundTimeSeconds(60, { mode: "sideways" as TimeRoundingMode, minutes: 6 }),
    ).toThrow(/mode/);
    expect(() =>
      roundTimeSeconds(60, { mode: "up", minutes: 5 as TimeRoundingMinutes }),
    ).toThrow(/increment/);
    expect(() =>
      roundTimeSeconds(Number.MAX_SAFE_INTEGER, { mode: "up", minutes: 60 }),
    ).toThrow(/safe integer range/);
    expect(assertTimeRoundingPolicy({ mode: "down", minutes: 20 })).toEqual({
      mode: "down",
      minutes: 20,
    });
  });

  it("[unit] maps every value of the old single setting to the rule it meant", () => {
    expect(
      Object.fromEntries(legacyTimeRoundings.map((legacy) => [legacy, timeRoundingFromLegacy(legacy)])),
    ).toEqual({
      none: { mode: "exact", minutes: 15 },
      nearest_6: { mode: "nearest", minutes: 6 },
      nearest_15: { mode: "nearest", minutes: 15 },
      nearest_30: { mode: "nearest", minutes: 30 },
      up_6: { mode: "up", minutes: 6 },
      up_15: { mode: "up", minutes: 15 },
      up_30: { mode: "up", minutes: 30 },
    });
  });

  it("[unit] lets a project's own rule win over the organization's, and says which applied", () => {
    const organization = { mode: "up", minutes: 15 } as const;
    expect(effectiveTimeRounding(organization, null)).toEqual({
      mode: "up",
      minutes: 15,
      source: "organization",
    });
    expect(effectiveTimeRounding(organization, { mode: "exact", minutes: 6 })).toEqual({
      mode: "exact",
      minutes: 6,
      source: "project",
    });
  });

  it("[unit] describes a rule in words that read inside a sentence", () => {
    expect(describeTimeRounding({ mode: "exact", minutes: 30 })).toBe("exact (no rounding)");
    expect(describeTimeRounding({ mode: "up", minutes: 15 })).toBe("rounded up to 15 min");
    expect(describeTimeRounding({ mode: "down", minutes: 60 })).toBe("rounded down to 1 hour");
    expect(describeTimeRounding({ mode: "nearest", minutes: 6 })).toBe(
      "rounded to the nearest 6 min",
    );
  });
});
