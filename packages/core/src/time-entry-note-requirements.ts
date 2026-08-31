export const minimumTimeEntryNoteLength = 1;
export const maximumTimeEntryNoteLength = 10_000;

export type TimeEntryNoteRequirementSource =
  "organization" | "person" | "project" | "pair";

export interface TimeEntryNoteRequirementInput {
  organization: Readonly<{
    required: boolean;
    minimumLength: number;
  }>;
  projectMinimumLength: number | null;
  personMinimumLength: number | null;
  pairMinimumLength: number | null;
}

export interface EffectiveTimeEntryNoteRequirement {
  minimumLength: number;
  source: TimeEntryNoteRequirementSource;
}

const assertMinimumLength = (value: number | null, field: string): void => {
  if (
    value !== null &&
    (!Number.isSafeInteger(value) ||
      value < minimumTimeEntryNoteLength ||
      value > maximumTimeEntryNoteLength)
  ) {
    throw new RangeError(
      `${field} must be null or an integer between ${minimumTimeEntryNoteLength} and ${maximumTimeEntryNoteLength}`,
    );
  }
};

/**
 * Resolves the strongest applicable note rule without consulting storage or a
 * clock. Equal strengths use the stable pair > project > person > organization
 * provenance order so every caller can explain the same effective policy.
 */
export const resolveTimeEntryNoteRequirement = (
  input: Readonly<TimeEntryNoteRequirementInput>,
): EffectiveTimeEntryNoteRequirement | null => {
  if (typeof input.organization.required !== "boolean") {
    throw new TypeError("organization required must be a boolean");
  }
  assertMinimumLength(
    input.organization.minimumLength,
    "organization minimum length",
  );
  assertMinimumLength(input.projectMinimumLength, "project minimum length");
  assertMinimumLength(input.personMinimumLength, "person minimum length");
  assertMinimumLength(input.pairMinimumLength, "pair minimum length");

  const candidates: readonly EffectiveTimeEntryNoteRequirement[] = [
    ...(input.pairMinimumLength === null
      ? []
      : [{ source: "pair" as const, minimumLength: input.pairMinimumLength }]),
    ...(input.projectMinimumLength === null
      ? []
      : [
          {
            source: "project" as const,
            minimumLength: input.projectMinimumLength,
          },
        ]),
    ...(input.personMinimumLength === null
      ? []
      : [
          {
            source: "person" as const,
            minimumLength: input.personMinimumLength,
          },
        ]),
    ...(input.organization.required
      ? [
          {
            source: "organization" as const,
            minimumLength: input.organization.minimumLength,
          },
        ]
      : []),
  ];

  let effective: EffectiveTimeEntryNoteRequirement | null = null;
  for (const candidate of candidates) {
    if (
      effective === null ||
      candidate.minimumLength > effective.minimumLength
    ) {
      effective = candidate;
    }
  }
  return effective;
};

/** Unicode-code-point length after ECMAScript whitespace trimming. */
export const timeEntryNoteLength = (
  notes: string | null | undefined,
): number => {
  if (notes === null || notes === undefined) return 0;
  if (typeof notes !== "string")
    throw new TypeError("notes must be a string or null");
  return Array.from(notes.trim()).length;
};

export class TimeEntryNoteRequirementError extends Error {
  readonly code = "time_entry_note_too_short";
  readonly field = "notes";
  readonly minimumLength: number;
  readonly actualLength: number;
  readonly source: TimeEntryNoteRequirementSource;

  constructor(
    requirement: Readonly<EffectiveTimeEntryNoteRequirement>,
    actualLength: number,
  ) {
    super(
      `Time entry notes must contain at least ${requirement.minimumLength} Unicode code points after trimming.`,
    );
    this.name = "TimeEntryNoteRequirementError";
    this.minimumLength = requirement.minimumLength;
    this.actualLength = actualLength;
    this.source = requirement.source;
  }
}

export const assertTimeEntryNoteRequirement = (
  notes: string | null | undefined,
  requirement: Readonly<EffectiveTimeEntryNoteRequirement> | null,
): void => {
  if (requirement === null) return;
  assertMinimumLength(requirement.minimumLength, "effective minimum length");
  const actualLength = timeEntryNoteLength(notes);
  if (actualLength < requirement.minimumLength) {
    throw new TimeEntryNoteRequirementError(requirement, actualLength);
  }
};
