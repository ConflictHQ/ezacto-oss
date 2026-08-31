import { describe, expect, it } from "vitest";
import {
  assertTimeEntryNoteRequirement,
  maximumTimeEntryNoteLength,
  minimumTimeEntryNoteLength,
  resolveTimeEntryNoteRequirement,
  timeEntryNoteLength,
  TimeEntryNoteRequirementError,
  type TimeEntryNoteRequirementInput,
  type TimeEntryNoteRequirementSource,
} from "../src/time-entry-note-requirements.js";

const input = (
  changes: Partial<TimeEntryNoteRequirementInput> = {},
): TimeEntryNoteRequirementInput => ({
  organization: changes.organization ?? { required: true, minimumLength: 10 },
  projectMinimumLength: changes.projectMinimumLength ?? null,
  personMinimumLength: changes.personMinimumLength ?? null,
  pairMinimumLength: changes.pairMinimumLength ?? null,
});

const sources = [
  "organization",
  "person",
  "project",
  "pair",
] as const satisfies readonly TimeEntryNoteRequirementSource[];

describe("time-entry note requirements", () => {
  for (let mask = 0; mask < 16; mask += 1) {
    const enabled = new Set(
      sources.filter((_source, index) => (mask & (1 << index)) !== 0),
    );
    it(`[unit] resolves applicability combination ${mask.toString(2).padStart(4, "0")} by numeric maximum`, () => {
      const candidate = input({
        organization: {
          required: enabled.has("organization"),
          minimumLength: 11,
        },
        personMinimumLength: enabled.has("person") ? 22 : null,
        projectMinimumLength: enabled.has("project") ? 33 : null,
        pairMinimumLength: enabled.has("pair") ? 44 : null,
      });
      const expected = [...sources]
        .reverse()
        .find((source) => enabled.has(source));
      expect(resolveTimeEntryNoteRequirement(candidate)).toEqual(
        expected === undefined
          ? null
          : {
              source: expected,
              minimumLength:
                expected === "organization"
                  ? 11
                  : expected === "person"
                    ? 22
                    : expected === "project"
                      ? 33
                      : 44,
            },
      );
    });
  }

  it.each([
    ["organization", [50, 40, 30, 20]],
    ["person", [20, 50, 40, 30]],
    ["project", [20, 30, 50, 40]],
    ["pair", [20, 30, 40, 50]],
  ] as const)(
    "[unit] chooses %s when it alone has the strongest numeric rule",
    (expectedSource, [organization, person, project, pair]) => {
      expect(
        resolveTimeEntryNoteRequirement(
          input({
            organization: { required: true, minimumLength: organization },
            personMinimumLength: person,
            projectMinimumLength: project,
            pairMinimumLength: pair,
          }),
        ),
      ).toEqual({ source: expectedSource, minimumLength: 50 });
    },
  );

  for (let mask = 1; mask < 16; mask += 1) {
    const tied = new Set(
      sources.filter((_source, index) => (mask & (1 << index)) !== 0),
    );
    const expected = [...sources].reverse().find((source) => tied.has(source))!;
    it(`[unit] resolves equal-strength provenance ${mask.toString(2).padStart(4, "0")} as ${expected}`, () => {
      expect(
        resolveTimeEntryNoteRequirement(
          input({
            organization: {
              required: tied.has("organization"),
              minimumLength: 25,
            },
            personMinimumLength: tied.has("person") ? 25 : null,
            projectMinimumLength: tied.has("project") ? 25 : null,
            pairMinimumLength: tied.has("pair") ? 25 : null,
          }),
        ),
      ).toEqual({ source: expected, minimumLength: 25 });
    });
  }

  it("[unit] treats a disabled organization and empty scoped rules as optional", () => {
    const requirement = resolveTimeEntryNoteRequirement(
      input({ organization: { required: false, minimumLength: 9_999 } }),
    );
    expect(requirement).toBeNull();
    expect(() =>
      assertTimeEntryNoteRequirement(null, requirement),
    ).not.toThrow();
    expect(() =>
      assertTimeEntryNoteRequirement("   ", requirement),
    ).not.toThrow();
  });

  it.each([
    [0, "organization"],
    [10_001, "organization"],
    [1.5, "organization"],
    [0, "project"],
    [10_001, "person"],
    [1.5, "pair"],
  ] as const)(
    "[unit] rejects invalid %s minimum %s at the pure boundary",
    (minimumLength, source) => {
      const candidate = input();
      if (source === "organization") {
        candidate.organization = { required: false, minimumLength };
      } else if (source === "project") {
        candidate.projectMinimumLength = minimumLength;
      } else if (source === "person") {
        candidate.personMinimumLength = minimumLength;
      } else {
        candidate.pairMinimumLength = minimumLength;
      }
      expect(() => resolveTimeEntryNoteRequirement(candidate)).toThrow(
        RangeError,
      );
    },
  );

  it("[unit] accepts both configured minimum boundaries", () => {
    expect(
      resolveTimeEntryNoteRequirement(
        input({
          organization: {
            required: true,
            minimumLength: minimumTimeEntryNoteLength,
          },
          pairMinimumLength: maximumTimeEntryNoteLength,
        }),
      ),
    ).toEqual({ source: "pair", minimumLength: maximumTimeEntryNoteLength });
  });

  it("[unit] counts trimmed Unicode code points rather than UTF-16 code units", () => {
    expect(timeEntryNoteLength("\u00a0😀a\u0301\u3000")).toBe(3);
    expect(timeEntryNoteLength(null)).toBe(0);
    expect(timeEntryNoteLength(undefined)).toBe(0);
  });

  it("[unit] throws the typed requirement error with explainable policy facts", () => {
    const requirement = { source: "project", minimumLength: 4 } as const;
    let thrown: unknown;
    try {
      assertTimeEntryNoteRequirement("  😀ab  ", requirement);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(TimeEntryNoteRequirementError);
    expect(thrown).toMatchObject({
      name: "TimeEntryNoteRequirementError",
      code: "time_entry_note_too_short",
      field: "notes",
      minimumLength: 4,
      actualLength: 3,
      source: "project",
    });
    expect((thrown as Error).message).toMatch(/at least 4 Unicode code points/);
  });

  it("[unit] accepts an exact trimmed code-point minimum", () => {
    expect(() =>
      assertTimeEntryNoteRequirement(" \n😀ab\t ", {
        source: "pair",
        minimumLength: 3,
      }),
    ).not.toThrow();
  });
});
