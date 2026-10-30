import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  composeResourceCalendar,
  maximumResourceCalendarPeople,
  maximumResourceCalendarPlaceholders,
  organizationLocalDate,
  resourceCalendarContext,
  TrackedResourceInputError,
  type ResourceCalendarRows,
} from "../src/index.js";

const hours = (count: number) => count * 3_600;
const context = resourceCalendarContext(
  new Date("2026-10-14T12:00:00Z"),
  "UTC",
  "monday",
);
const base: ResourceCalendarRows = {
  weekStartDay: "monday",
  people: [
    { id: 1, name: "Ada", weeklyCapacitySeconds: hours(35), archived: false },
    { id: 2, name: "Bo", weeklyCapacitySeconds: 0, archived: false },
    { id: 3, name: "Cy", weeklyCapacitySeconds: hours(35), archived: true },
  ],
  visibleProjects: [{ id: 10, name: "Visible" }],
  allocations: [],
  placeholders: [],
  timeOff: [],
  holidays: [],
  tracked: [],
};
const query = { view: "team", from: "2026-10-12", to: "2026-10-25" } as const;
const alloc = (over: object) => ({
  id: 1,
  personId: 1,
  projectId: 10,
  projectArchived: false,
  startDate: "2026-10-12",
  endDate: "2026-10-12",
  plannedSecondsPerWeek: hours(10),
  revision: 1,
  ...over,
});

describe("resource calendar contract (issue 1192)", () => {
  it("[unit] keeps identical hidden-demand semantics without reading private placeholder identities", () => {
    const hidden = {
      id: 44,
      projectId: 99,
      projectArchived: false,
      name: "Private demand",
      startDate: "2026-10-12",
      endDate: "2026-10-12",
      plannedSecondsPerWeek: 3600,
      revision: 0,
    };
    const expected = composeResourceCalendar(context, query, {
      ...base,
      placeholders: [hidden],
    });
    const minimized = { ...base, hasHiddenPlaceholderDemand: true };
    expect(composeResourceCalendar(context, query, minimized)).toEqual(
      expected,
    );
    expect(
      composeResourceCalendar(context, { ...query, personId: 1 }, minimized)
        .hasOtherScope,
    ).toBe(false);
    expect(
      composeResourceCalendar(context, { ...query, cursor: 1 }, minimized)
        .hasOtherScope,
    ).toBe(false);
    expect(JSON.stringify(expected)).not.toContain("Private demand");
  });
  it("[unit] counts the full weekly amount for a single touched day and never prorates", () => {
    const out = composeResourceCalendar(context, query, {
      ...base,
      allocations: [alloc({ startDate: "2026-10-18", endDate: "2026-10-19" })],
    });
    const weeks = out.people[0]!.weeks;
    expect(weeks.map((week) => week.plannedSeconds)).toEqual([
      hours(10),
      hours(10),
    ]);
  });

  it("[unit] sums disjoint ranges in one week and flags zero capacity over-allocation", () => {
    const out = composeResourceCalendar(context, query, {
      ...base,
      allocations: [
        alloc({ id: 1, endDate: "2026-10-13" }),
        alloc({
          id: 2,
          personId: 2,
          startDate: "2026-10-12",
          endDate: "2026-10-12",
        }),
        alloc({ id: 3, startDate: "2026-10-15", endDate: "2026-10-16" }),
      ],
    });
    expect(out.people[0]!.weeks[0]!.plannedSeconds).toBe(hours(20));
    expect(out.people[1]!.weeks[0]!.availableSeconds).toBe(0);
    expect(out.people[1]!.weeks[0]!.overAllocated).toBe(true);
  });

  it("[unit] omits archived people and plans on archived projects but keeps their actuals", () => {
    const out = composeResourceCalendar(context, query, {
      ...base,
      allocations: [alloc({ projectArchived: true })],
      tracked: [
        {
          personId: 1,
          projectId: 10,
          spentDate: "2026-10-13",
          roundedSeconds: 900,
        },
      ],
    });
    expect(out.people.map((person) => person.personId)).toEqual([1, 2]);
    expect(out.people[0]!.weeks[0]!.plannedSeconds).toBe(0);
    expect(out.people[0]!.weeks[0]!.trackedSeconds).toBe(900);
  });

  it("[unit] subtracts holidays and leave once per day and stays separate from tracked", () => {
    const out = composeResourceCalendar(context, query, {
      ...base,
      holidays: [{ date: "2026-10-12" }, { date: "2026-10-17" }],
      timeOff: [
        {
          personId: 1,
          startDate: "2026-10-12",
          endDate: "2026-10-12",
          secondsPerDay: null,
        },
      ],
    });
    expect(out.people[0]!.weeks[0]!.availableSeconds).toBe(hours(28));
  });

  it("[unit] labels hidden-project hours without naming them or their private leave", () => {
    const out = composeResourceCalendar(context, query, {
      ...base,
      allocations: [
        alloc({ id: 1 }),
        alloc({ id: 2, projectId: 99, plannedSecondsPerWeek: hours(5) }),
      ],
      placeholders: [
        {
          id: 7,
          projectId: 99,
          projectArchived: false,
          name: "Secret",
          startDate: "2026-10-12",
          endDate: "2026-10-12",
          plannedSecondsPerWeek: hours(8),
          revision: 1,
        },
      ],
    });
    const week = out.people[0]!.weeks[0]!;
    expect(week.plannedSeconds).toBe(hours(15));
    expect(week.otherScopePlannedSeconds).toBe(hours(5));
    expect(week.projects).toEqual([
      { projectId: 10, plannedSeconds: hours(10) },
    ]);
    expect(out.hasOtherScope).toBe(true);
    expect(out.unassigned).toEqual([]);
    expect(JSON.stringify(out)).not.toMatch(/"projectId":99|Secret/u);
    expect(out.unassigned).toEqual([]);
    const placeholderOnly = composeResourceCalendar(context, query, {
      ...base,
      allocations: [],
      placeholders: [
        {
          id: 7,
          projectId: 99,
          projectArchived: false,
          name: "Secret",
          startDate: "2026-10-12",
          endDate: "2026-10-12",
          plannedSecondsPerWeek: hours(8),
          revision: 1,
        },
      ],
    });
    expect(placeholderOnly.unassigned).toEqual([]);
    expect(placeholderOnly.hasOtherScope).toBe(true);
  });

  it("[unit] keeps placeholder demand out of every person total", () => {
    const out = composeResourceCalendar(context, query, {
      ...base,
      placeholders: [
        {
          id: 7,
          projectId: 10,
          projectArchived: false,
          name: "Designer",
          startDate: "2026-10-14",
          endDate: "2026-10-20",
          plannedSecondsPerWeek: hours(12),
          revision: 3,
        },
      ],
    });
    expect(
      out.unassigned.map((row) => [row.weekStart, row.plannedSeconds]),
    ).toEqual([
      ["2026-10-12", hours(12)],
      ["2026-10-19", hours(12)],
    ]);
    expect(
      out.people.every((person) =>
        person.weeks.every((week) => week.plannedSeconds === 0),
      ),
    ).toBe(true);
  });

  it("[unit] project view scopes plans to its project", () => {
    const out = composeResourceCalendar(
      context,
      { ...query, view: "project", projectId: 10 },
      {
        ...base,
        visibleProjects: [
          { id: 10, name: "A" },
          { id: 11, name: "B" },
        ],
        allocations: [alloc({}), alloc({ id: 2, projectId: 11 })],
      },
    );
    expect(out.people[0]!.weeks[0]!.plannedSeconds).toBe(hours(10));
  });

  it("[unit] pages people with a stable cursor and bounds the limit", () => {
    const first = composeResourceCalendar(
      context,
      { ...query, limit: 1 },
      base,
    );
    expect(first.people.map((person) => person.personId)).toEqual([1]);
    expect(first.nextCursor).toBe(1);
    const second = composeResourceCalendar(
      context,
      { ...query, limit: 1, cursor: first.nextCursor! },
      base,
    );
    expect(second.people.map((person) => person.personId)).toEqual([2]);
    expect(second.nextCursor).toBeNull();
    expect(() =>
      composeResourceCalendar(
        context,
        { ...query, limit: maximumResourceCalendarPeople + 1 },
        base,
      ),
    ).toThrow(TrackedResourceInputError);
  });

  it("[unit] supports every week start and rejects an unbounded or backwards range", () => {
    // 2026-10-14 is a Wednesday.
    const expected = {
      saturday: "2026-10-10",
      sunday: "2026-10-11",
      monday: "2026-10-12",
    } as const;
    for (const weekStartDay of ["saturday", "sunday", "monday"] as const) {
      const out = composeResourceCalendar(
        context,
        { ...query, from: "2026-10-14", to: "2026-10-14" },
        { ...base, weekStartDay },
      );
      expect(out.weekStarts).toEqual([expected[weekStartDay]]);
    }
    expect(() =>
      composeResourceCalendar(context, { ...query, to: "2028-01-01" }, base),
    ).toThrow(TrackedResourceInputError);
    expect(() =>
      composeResourceCalendar(
        context,
        { ...query, from: "2026-10-20", to: "2026-10-12" },
        base,
      ),
    ).toThrow(TrackedResourceInputError);
    expect(() =>
      composeResourceCalendar(
        context,
        { view: "project", from: query.from, to: query.to },
        base,
      ),
    ).toThrow(TrackedResourceInputError);
  });

  it("[unit] revision is stable for equal input and changes with a planned amount", () => {
    const a = composeResourceCalendar(context, query, {
      ...base,
      allocations: [alloc({})],
    });
    const b = composeResourceCalendar(context, query, {
      ...base,
      allocations: [alloc({ plannedSecondsPerWeek: hours(11) })],
    });
    expect(a.revision).not.toBe(b.revision);
    expect(a.revision).toBe(
      composeResourceCalendar(context, query, {
        ...base,
        allocations: [alloc({})],
      }).revision,
    );
  });

  it("[unit] server context uses the organization date across device zones and DST", () => {
    const instant = new Date("2026-10-18T03:30:00Z");
    expect(organizationLocalDate(instant, "America/Los_Angeles")).toBe(
      "2026-10-17",
    );
    expect(organizationLocalDate(instant, "Pacific/Auckland")).toBe(
      "2026-10-18",
    );
    expect(
      resourceCalendarContext(instant, "America/Los_Angeles", "monday")
        .currentWeekStart,
    ).toBe("2026-10-12");
    expect(
      resourceCalendarContext(instant, "America/Los_Angeles", "saturday")
        .currentWeekStart,
    ).toBe("2026-10-17");
    // US fall-back 2026-11-01: 06:30Z is still 23:30 on Oct 31 in Los Angeles, 05:30Z is 22:30.
    expect(
      organizationLocalDate(
        new Date("2026-11-01T06:30:00Z"),
        "America/Los_Angeles",
      ),
    ).toBe("2026-10-31");
    expect(
      organizationLocalDate(
        new Date("2026-11-01T08:30:00Z"),
        "America/Los_Angeles",
      ),
    ).toBe("2026-11-01");
    expect(() => organizationLocalDate(instant, "Not/AZone")).toThrow(
      TrackedResourceInputError,
    );
  });

  it("[unit] revision tracks time off, holidays, capacity and tracked time", () => {
    const rev = (rows: Partial<ResourceCalendarRows>) =>
      composeResourceCalendar(context, query, { ...base, ...rows }).revision;
    const original = rev({});
    expect(original).toMatch(/^[0-9a-f]{64}$/u);
    const changed = [
      rev({ holidays: [{ date: "2026-10-13" }] }),
      rev({
        timeOff: [
          {
            personId: 1,
            startDate: "2026-10-13",
            endDate: "2026-10-13",
            secondsPerDay: hours(2),
          },
        ],
      }),
      rev({
        people: base.people.map((person) =>
          person.id === 1
            ? { ...person, weeklyCapacitySeconds: hours(30) }
            : person,
        ),
      }),
      rev({
        tracked: [
          {
            personId: 1,
            projectId: 10,
            spentDate: "2026-10-13",
            roundedSeconds: 900,
          },
        ],
      }),
    ];
    for (const value of changed) expect(value).not.toBe(original);
    expect(new Set(changed).size).toBe(changed.length);
  });

  it("[unit] revision ignores rows that never reach the output", () => {
    const withRows = (extra: object[]) =>
      composeResourceCalendar(
        context,
        { ...query, view: "project", projectId: 10, personId: 1 },
        {
          ...base,
          visibleProjects: [
            { id: 10, name: "A" },
            { id: 11, name: "B" },
          ],
          allocations: [alloc({}), ...extra.map((row) => alloc(row))],
        },
      ).revision;
    const original = withRows([]);
    // Other people (filtered out), archived people, and other projects' plans on a
    // person outside the page change nothing the caller can see.
    expect(withRows([{ id: 2, personId: 2, projectId: 11, revision: 5 }])).toBe(
      original,
    );
    expect(withRows([{ id: 3, personId: 2, projectId: 99, revision: 9 }])).toBe(
      original,
    );
    expect(withRows([{ id: 4, personId: 3 }])).toBe(original);
    expect(
      withRows([{ id: 5, startDate: "2026-10-19", endDate: "2026-10-19" }]),
    ).not.toBe(original);
  });

  it("[unit] partial leave subtracts its seconds per day and holidays win when larger", () => {
    const out = composeResourceCalendar(context, query, {
      ...base,
      holidays: [{ date: "2026-10-14" }],
      timeOff: [
        {
          personId: 1,
          startDate: "2026-10-12",
          endDate: "2026-10-14",
          secondsPerDay: hours(3),
        },
      ],
    });
    // Mon and Tue lose 3h each; Wed is a 7h holiday that outweighs 3h leave.
    expect(out.people[0]!.weeks[0]!.availableSeconds).toBe(hours(35 - 13));
  });

  it("[unit] uses current capacity per person and never goes below zero", () => {
    const out = composeResourceCalendar(context, query, {
      ...base,
      people: [
        {
          id: 1,
          name: "Ada",
          weeklyCapacitySeconds: hours(20),
          archived: false,
        },
      ],
      timeOff: [
        {
          personId: 1,
          startDate: "2026-10-12",
          endDate: "2026-10-18",
          secondsPerDay: hours(24),
        },
      ],
    });
    expect(out.people[0]!.weeks[0]!.availableSeconds).toBe(0);
    expect(out.people[0]!.weeks[1]!.availableSeconds).toBe(hours(20));
  });

  it("[unit] snaps a range across a DST change to the same week boundaries", () => {
    const out = composeResourceCalendar(
      context,
      { ...query, from: "2026-10-30", to: "2026-11-02" },
      base,
    );
    expect(out.weekStarts).toEqual(["2026-10-26", "2026-11-02"]);
  });

  it("[unit] project view scopes tracked time and labels hidden tracked time", () => {
    const rows: ResourceCalendarRows = {
      ...base,
      visibleProjects: [
        { id: 10, name: "A" },
        { id: 11, name: "B" },
      ],
      allocations: [
        alloc({}),
        alloc({ id: 2, projectId: 11, plannedSecondsPerWeek: hours(30) }),
      ],
      tracked: [
        {
          personId: 1,
          projectId: 10,
          spentDate: "2026-10-13",
          roundedSeconds: 3600,
        },
        {
          personId: 1,
          projectId: 11,
          spentDate: "2026-10-13",
          roundedSeconds: 7200,
        },
        {
          personId: 1,
          projectId: 99,
          spentDate: "2026-10-13",
          roundedSeconds: 1800,
        },
      ],
    };
    const project = composeResourceCalendar(
      context,
      { ...query, view: "project", projectId: 10 },
      rows,
    ).people[0]!.weeks[0]!;
    expect(project.plannedSeconds).toBe(hours(10));
    expect(project.trackedSeconds).toBe(3600);
    expect(project.otherScopeTrackedSeconds).toBe(0);
    // Over-allocation compares the whole person (40h) with availability (35h).
    expect(project.personPlannedSeconds).toBe(hours(40));
    expect(project.overAllocated).toBe(true);

    const team = composeResourceCalendar(context, query, rows);
    const week = team.people[0]!.weeks[0]!;
    expect(week.trackedSeconds).toBe(3600 + 7200 + 1800);
    expect(week.otherScopeTrackedSeconds).toBe(1800);
    expect(team.hasOtherScope).toBe(true);
    expect(JSON.stringify(team)).not.toMatch(/"projectId":99/u);
  });

  it("[unit] project view does not call a person over-allocated for one small project", () => {
    const out = composeResourceCalendar(
      context,
      { ...query, view: "project", projectId: 10 },
      { ...base, allocations: [alloc({ plannedSecondsPerWeek: hours(10) })] },
    );
    expect(out.people[0]!.weeks[0]!.overAllocated).toBe(false);
  });

  it("[unit] project view labels hidden whole-person planned hours behind overAllocated", () => {
    const out = composeResourceCalendar(
      context,
      { ...query, view: "project", projectId: 10 },
      {
        ...base,
        allocations: [
          alloc({ plannedSecondsPerWeek: hours(10) }),
          alloc({ id: 2, projectId: 99, plannedSecondsPerWeek: hours(30) }),
        ],
      },
    );
    const week = out.people[0]!.weeks[0]!;
    expect(week.plannedSeconds).toBe(hours(10));
    expect(week.otherScopePlannedSeconds).toBe(0);
    expect(week.personPlannedSeconds).toBe(hours(40));
    expect(week.personOtherScopePlannedSeconds).toBe(hours(30));
    expect(week.overAllocated).toBe(true);
    expect(out.hasOtherScope).toBe(true);
    expect(JSON.stringify(out)).not.toMatch(/"projectId":99/u);
  });

  it("[unit] bounds unassigned demand and skips it for a person filter or a later page", () => {
    const placeholders = Array.from(
      { length: maximumResourceCalendarPlaceholders + 5 },
      (_, index) => ({
        id: index + 1,
        projectId: 10,
        projectArchived: false,
        name: `P${index + 1}`,
        startDate: "2026-10-12",
        endDate: "2026-10-12",
        plannedSecondsPerWeek: hours(1),
        revision: 1,
      }),
    );
    const first = composeResourceCalendar(context, query, {
      ...base,
      placeholders,
    });
    expect(new Set(first.unassigned.map((row) => row.placeholderId)).size).toBe(
      maximumResourceCalendarPlaceholders,
    );
    expect(first.unassignedTruncated).toBe(true);
    const filtered = composeResourceCalendar(
      context,
      { ...query, personId: 1 },
      { ...base, placeholders },
    );
    expect(filtered.unassigned).toEqual([]);
    const later = composeResourceCalendar(
      context,
      { ...query, cursor: 1 },
      { ...base, placeholders },
    );
    expect(later.unassigned).toEqual([]);
    const small = composeResourceCalendar(context, query, {
      ...base,
      placeholders: placeholders.slice(0, 2),
    });
    expect(small.unassignedTruncated).toBe(false);
  });

  it("[unit] revision equals the SHA-256 of the canonical projection", () => {
    const out = composeResourceCalendar(context, query, {
      ...base,
      allocations: [alloc({})],
    });
    const body = {
      view: out.view,
      weekStarts: out.weekStarts,
      people: out.people,
      unassigned: out.unassigned,
      unassignedTruncated: out.unassignedTruncated,
      hasOtherScope: out.hasOtherScope,
      nextCursor: out.nextCursor,
    };
    const revision = out.revision;
    expect(revision).toBe(
      createHash("sha256").update(JSON.stringify(body)).digest("hex"),
    );
  });
});
