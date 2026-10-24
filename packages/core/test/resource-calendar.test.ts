import { describe, expect, it } from "vitest";
import {
  composeResourceCalendar,
  maximumResourceCalendarPeople,
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
      tracked: [{ personId: 1, spentDate: "2026-10-13", roundedSeconds: 900 }],
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
    expect(JSON.stringify(out)).not.toContain("99");
    expect(JSON.stringify(out)).not.toContain("Secret");
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
    for (const weekStartDay of ["saturday", "sunday", "monday"] as const) {
      const out = composeResourceCalendar(
        context,
        { ...query, from: "2026-10-14", to: "2026-10-14" },
        { ...base, weekStartDay },
      );
      expect(out.weekStarts).toHaveLength(1);
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

  it("[unit] revision changes with any contributing row revision", () => {
    const a = composeResourceCalendar(context, query, {
      ...base,
      allocations: [alloc({})],
    });
    const b = composeResourceCalendar(context, query, {
      ...base,
      allocations: [alloc({ revision: 2 })],
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
});
