/**
 * How tracked time is rounded before it is billed (issue 949).
 *
 * Two independent choices: a direction -- leave the time exact, or round it
 * up, down, or to the nearest increment -- and the increment itself, in whole
 * minutes that are a clean fraction of an hour. The organization sets one rule
 * and a project may set its own, because client contracts differ.
 *
 * The rounded figure is stored per entry (`rounded_seconds`) when the entry is
 * saved, and that stored figure is what invoices, reports and approvals read.
 * A rule therefore applies to time saved after it is chosen; time already on
 * an invoice keeps the hours it was billed at.
 */

export const timeRoundingModes = ["exact", "up", "down", "nearest"] as const;
export type TimeRoundingMode = (typeof timeRoundingModes)[number];

/** 1/10, 1/6, 1/4, 1/3, 1/2 and 1 hour. */
export const timeRoundingIncrements = [6, 10, 15, 20, 30, 60] as const;
export type TimeRoundingMinutes = (typeof timeRoundingIncrements)[number];

export interface TimeRoundingPolicy {
  readonly mode: TimeRoundingMode;
  /**
   * Kept with `exact` too, so switching rounding back on returns to the
   * increment that was in use rather than to a default nobody chose.
   */
  readonly minutes: TimeRoundingMinutes;
}

/** Where an entry's rule came from: the organization's, or its project's own. */
export type TimeRoundingSource = "organization" | "project";

export interface EffectiveTimeRounding extends TimeRoundingPolicy {
  readonly source: TimeRoundingSource;
}

/** A fresh instance rounds nothing. */
export const defaultTimeRounding: TimeRoundingPolicy = {
  mode: "exact",
  minutes: 15,
};

export const isTimeRoundingMode = (value: unknown): value is TimeRoundingMode =>
  typeof value === "string" &&
  (timeRoundingModes as readonly string[]).includes(value);

export const isTimeRoundingMinutes = (
  value: unknown,
): value is TimeRoundingMinutes =>
  typeof value === "number" &&
  (timeRoundingIncrements as readonly number[]).includes(value);

export const assertTimeRoundingPolicy = (
  policy: Readonly<{ mode: unknown; minutes: unknown }>,
): TimeRoundingPolicy => {
  if (!isTimeRoundingMode(policy.mode)) {
    throw new RangeError(`unsupported time rounding mode: ${String(policy.mode)}`);
  }
  if (!isTimeRoundingMinutes(policy.minutes)) {
    throw new RangeError(
      `unsupported time rounding increment: ${String(policy.minutes)}`,
    );
  }
  return { mode: policy.mode, minutes: policy.minutes };
};

/**
 * The rule that applies to an entry on this project: the project's own where
 * it has one, else the organization's.
 */
export const effectiveTimeRounding = (
  organization: TimeRoundingPolicy,
  project: TimeRoundingPolicy | null,
): EffectiveTimeRounding =>
  project === null
    ? { ...organization, source: "organization" }
    : { ...project, source: "project" };

/**
 * Rounds a duration under a rule. Half an increment rounds up under
 * `nearest`, as it always has here; exactly on an increment never moves.
 *
 * Only native durations are rounded, and those are never negative: a negative
 * entry is an imported correction, which keeps the figure its source gave it.
 */
export const roundTimeSeconds = (
  seconds: number,
  policy: TimeRoundingPolicy,
): number => {
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    throw new RangeError("seconds must be a non-negative safe integer");
  }
  const { mode, minutes } = assertTimeRoundingPolicy(policy);
  if (mode === "exact") return seconds;
  const increment = minutes * 60;
  const quotient = Math.floor(seconds / increment);
  const remainder = seconds % increment;
  const rounded =
    (mode === "down"
      ? quotient
      : mode === "up"
        ? quotient + (remainder === 0 ? 0 : 1)
        : quotient + (remainder * 2 >= increment ? 1 : 0)) * increment;
  if (!Number.isSafeInteger(rounded)) {
    throw new RangeError("rounded seconds exceed safe integer range");
  }
  return rounded;
};

/**
 * The single enum the organization used to hold (`organizations.time_rounding`,
 * migration 0000), and the rule each value is now. Migration 0101 backfills the
 * new columns with exactly this mapping; the old column stays and is unused.
 */
export const legacyTimeRoundings = [
  "none",
  "nearest_6",
  "nearest_15",
  "nearest_30",
  "up_6",
  "up_15",
  "up_30",
] as const;
export type LegacyTimeRounding = (typeof legacyTimeRoundings)[number];

export const timeRoundingFromLegacy = (
  legacy: LegacyTimeRounding,
): TimeRoundingPolicy => {
  if (legacy === "none") return defaultTimeRounding;
  const [mode, minutes] = legacy.split("_") as [string, string];
  return assertTimeRoundingPolicy({ mode, minutes: Number(minutes) });
};

const incrementNames: Readonly<Record<TimeRoundingMinutes, string>> = {
  6: "6 min",
  10: "10 min",
  15: "15 min",
  20: "20 min",
  30: "30 min",
  60: "1 hour",
};

const incrementFractions: Readonly<Record<TimeRoundingMinutes, string>> = {
  6: "1/10 hour",
  10: "1/6 hour",
  15: "1/4 hour",
  20: "1/3 hour",
  30: "1/2 hour",
  60: "1 hour",
};

/** What an increment is called in a picker: `15 min (1/4 hour)`, `1 hour`. */
export const timeRoundingIncrementLabel = (minutes: TimeRoundingMinutes): string =>
  minutes === 60
    ? incrementNames[minutes]
    : `${incrementNames[minutes]} (${incrementFractions[minutes]})`;

export const timeRoundingModeLabels: Readonly<Record<TimeRoundingMode, string>> = {
  exact: "Exact (no rounding)",
  up: "Round up",
  down: "Round down",
  nearest: "Round to the nearest",
};

/**
 * The rule in words, lower case so it can sit inside a sentence:
 * `rounded up to 15 min`, `exact (no rounding)`.
 */
export const describeTimeRounding = (policy: TimeRoundingPolicy): string => {
  const { mode, minutes } = assertTimeRoundingPolicy(policy);
  const increment = incrementNames[minutes];
  switch (mode) {
    case "exact":
      return "exact (no rounding)";
    case "up":
      return `rounded up to ${increment}`;
    case "down":
      return `rounded down to ${increment}`;
    case "nearest":
      return `rounded to the nearest ${increment}`;
  }
};
