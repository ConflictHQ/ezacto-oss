import { uninvoicedGenerationPreview } from "@ezacto/core";
import BetterSqlite3 from "better-sqlite3";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import {
  createContainerDatabase,
  createD1Database,
} from "../../db/src/adapters.js";
import { migrateContainer, migrateD1 } from "../../db/src/migrate.js";
import {
  createReportRepository,
  DETAILED_TIME_ENTRY_LIMIT,
} from "../../db/src/reports.js";
import {
  createApiApp,
  installReportRoutes,
  serializeDetailedTime,
  type ApiAuthentication,
  type DetailedTimeReportRecord,
  type UserProfile,
} from "../src/index.js";

interface Harness {
  request(
    path: string,
    profile?: UserProfile,
    managerGrants?: readonly string[],
    userId?: number,
  ): Promise<Response>;
  /** The repository itself, for reports with no route yet. */
  reports: ReturnType<typeof createReportRepository>;
  run(sql: string, params: readonly unknown[]): Promise<void>;
  close(): Promise<void>;
}

const now = "2026-08-28T12:00:00.000Z";
const profiles: readonly UserProfile[] = [
  "member",
  "project_manager",
  "people_admin",
  "accounting",
  "executive_manager",
  "administrator",
];

const authentication: ApiAuthentication = {
  sessions: {
    resolve: async (request) => {
      const profile = request.headers.get(
        "x-test-profile",
      ) as UserProfile | null;
      if (profile === null || !profiles.includes(profile)) return null;
      return {
        type: "user",
        userId: Number(request.headers.get("x-test-user-id") ?? "1"),
        profile,
        managerGrants: (request.headers.get("x-test-manager-grants") ?? "")
          .split(",")
          .filter(Boolean),
        authentication: { kind: "session", sessionId: "reports-test" },
      };
    },
  },
};

const seedStatements = [
  {
    sql: `INSERT INTO organizations
      (name, currency, modules, created_at, updated_at) VALUES (?, 'USD', '{}', ?, ?)`,
    params: ["Report org", now, now],
  },
  {
    sql: `INSERT INTO users
      (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES
      (1, 'Report', 'Owner', 'administrator', '[]', ?, ?),
      (2, 'Unassigned', 'Viewer', 'member', '[]', ?, ?)`,
    params: [now, now, now, now],
  },
  {
    sql: `INSERT INTO clients
      (id, name, currency, parent_client_id, created_at, updated_at) VALUES
      (1, 'Root', 'USD', NULL, ?, ?),
      (2, 'Child', 'USD', 1, ?, ?),
      (3, 'Leaf', 'USD', 2, ?, ?),
      (4, 'Archived holder', 'USD', NULL, ?, ?)`,
    params: [now, now, now, now, now, now, now, now],
  },
  {
    sql: `INSERT INTO projects
      (id, client_id, name, code, billing_method, bill_by, hourly_rate_cents,
       budget_by, budget_seconds, cost_budget_cents, cost_budget_include_expenses,
       report_visibility, created_at, updated_at) VALUES
      (1, 1, 'Root project', 'ROOT', 'time_materials', 'project', 10000,
       'project', 72000, NULL, 0, 'managers', ?, ?),
      (2, 2, 'Child project', 'CHILD', 'time_materials', 'project', 12345,
       'task_fees', NULL, NULL, 0, 'everyone', ?, ?),
      (3, 3, 'Leaf project', 'LEAF', 'time_materials', 'project', 8000,
       'project_cost', NULL, 50000, 1, 'managers', ?, ?)`,
    params: [now, now, now, now, now, now],
  },
  {
    sql: `INSERT INTO projects
      (id, client_id, name, code, billing_method, bill_by, hourly_rate_cents,
       budget_by, budget_seconds, cost_budget_cents, cost_budget_include_expenses,
       report_visibility, is_active, created_at, updated_at) VALUES
      (4, 4, 'Archived project', 'ARCH', 'time_materials', 'project', 9000,
       'project', 7200, NULL, 0, 'managers', 0, ?, ?)`,
    params: [now, now],
  },
  {
    sql: `INSERT INTO tasks
      (id, name, created_at, updated_at) VALUES (1, 'Delivery', ?, ?)`,
    params: [now, now],
  },
  {
    sql: `INSERT INTO task_assignments
      (id, project_id, task_id, billable, budget_cents, created_at, updated_at) VALUES
      (11, 1, 1, 1, NULL, ?, ?),
      (12, 2, 1, 1, 30000, ?, ?),
      (13, 3, 1, 1, NULL, ?, ?),
      (14, 4, 1, 1, NULL, ?, ?)`,
    params: [now, now, now, now, now, now, now, now],
  },
  {
    sql: `INSERT INTO user_assignments
      (id, project_id, user_id, is_active, is_project_manager, created_at, updated_at) VALUES
      (21, 1, 1, 1, 1, ?, ?), (22, 2, 1, 1, 0, ?, ?),
      (23, 3, 1, 1, 0, ?, ?), (24, 2, 2, 0, 1, ?, ?),
      (25, 4, 1, 1, 0, ?, ?)`,
    params: [now, now, now, now, now, now, now, now, now, now],
  },
  {
    sql: `INSERT INTO time_entries
      (id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
       spent_date, seconds, seconds_without_timer, rounded_seconds, billable, budgeted,
       billable_rate_cents, cost_rate_cents, created_at, updated_at) VALUES
      (101, 1, 1, 1, 21, 11, '2026-08-10', 3600, 3600, 3600, 1, 1, 10000, 4000, ?, ?),
      (102, 1, 2, 1, 22, 12, '2026-08-11', 1800, 1800, 1800, 1, 1, 12345, 5000, ?, ?),
      (103, 1, 3, 1, 23, 13, '2026-08-12', 900, 900, 900, 1, 1, 8000, 6000, ?, ?),
      (104, 1, 4, 1, 25, 14, '2026-08-13', 3600, 3600, 3600, 1, 1, 9000, 3000, ?, ?)`,
    params: [now, now, now, now, now, now, now, now],
  },
  {
    sql: `INSERT INTO expense_categories
      (id, name, created_at, updated_at) VALUES (1, 'Travel', ?, ?)`,
    params: [now, now],
  },
  {
    sql: `INSERT INTO expenses
      (id, user_id, project_id, expense_category_id, spent_date, total_cost_cents,
       billable, created_at, updated_at) VALUES
      (201, 1, 1, 1, '2026-08-10', 2500, 1, ?, ?),
      (202, 1, 2, 1, '2026-08-11', 1000, 1, ?, ?),
      (203, 1, 3, 1, '2026-08-12', 500, 1, ?, ?),
      (204, 1, 4, 1, '2026-08-13', 700, 1, ?, ?)`,
    params: [now, now, now, now, now, now, now, now],
  },
] as const;

const createHarness = async (kind: "SQLite" | "D1"): Promise<Harness> => {
  let close: () => Promise<void>;
  let run: (sql: string, params: readonly unknown[]) => Promise<void>;
  let reports: ReturnType<typeof createReportRepository>;
  if (kind === "SQLite") {
    const sqlite = new BetterSqlite3(":memory:");
    migrateContainer(sqlite);
    reports = createReportRepository(createContainerDatabase(sqlite));
    run = async (statement, params) => {
      sqlite.prepare(statement).run(...params);
    };
    close = async () => {
      sqlite.close();
    };
  } else {
    const miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ["DB"],
    });
    const d1 = await miniflare.getD1Database("DB");
    await migrateD1(d1);
    reports = createReportRepository(createD1Database(d1));
    run = async (statement, params) => {
      await d1
        .prepare(statement)
        .bind(...params)
        .run();
    };
    close = async () => miniflare.dispose();
  }
  for (const statement of seedStatements)
    await run(statement.sql, statement.params);
  const app = createApiApp({
    authentication,
    installApi: (api) => installReportRoutes(api, reports),
  });
  return {
    request: (
      path,
      profile = "administrator",
      managerGrants = [],
      userId = 1,
    ) =>
      Promise.resolve(
        app.request(`https://api.test/api/v1${path}`, {
          headers: {
            origin: "https://api.test",
            "x-test-profile": profile,
            "x-test-manager-grants": managerGrants.join(","),
            "x-test-user-id": String(userId),
          },
        }),
      ),
    reports,
    run,
    close,
  };
};

const factories = [
  ["SQLite", () => createHarness("SQLite")],
  ["D1", () => createHarness("D1")],
] as const;

for (const [runtime, factory] of factories) {
  describe(`report API (${runtime})`, () => {
    let harness: Harness | undefined;
    afterEach(async () => harness?.close());

    it("[db] totals what each person cost, and refuses to total unrated hours", async () => {
      harness = await factory();
      const report = await harness.reports.contractorCost({
        from: "2026-08-01",
        to: "2026-08-31",
      });

      // 3600s @ 4000 + 1800s @ 5000 + 900s @ 6000 + 3600s @ 3000
      //   = 4000 + 2500 + 1500 + 3000 = 11000 cents
      expect(report.rows).toEqual([
        expect.objectContaining({
          userId: 1,
          roundedSeconds: 9900,
          costCents: 11_000,
          entriesWithoutRate: 0,
        }),
      ]);

      // Cost rates carry no currency of their own, so the figure is the
      // organization's currency -- never the project's billing currency, which
      // would relabel the number without converting it.
      expect(report.rows[0]!.currency).toBe("USD");
    });

    it("[db] answers null rather than a total that quietly omits unrated hours", async () => {
      harness = await factory();
      await harness.run(
        `INSERT INTO time_entries
          (id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
           spent_date, seconds, seconds_without_timer, rounded_seconds, billable, budgeted,
           billable_rate_cents, cost_rate_cents, created_at, updated_at)
         VALUES (199, 1, 1, 1, 21, 11, '2026-08-14', 3600, 3600, 3600, 1, 1, 10000, NULL, ?, ?)`,
        [now, now],
      );
      const report = await harness.reports.contractorCost({
        from: "2026-08-01",
        to: "2026-08-31",
      });

      // A total that silently drops the unrated hour looks payable and
      // underpays, and nothing in the number says which hour it left out. The
      // hours still total, because those are known.
      expect(report.rows[0]!.costCents).toBeNull();
      expect(report.rows[0]!.entriesWithoutRate).toBe(1);
      expect(report.rows[0]!.roundedSeconds).toBe(13_500);
    });

    /**
     * User 2's own week, seeded per test rather than into the shared fixture:
     * the contractor-cost report totals every person in the range, so a second
     * person in the fixture would change a number those tests state exactly.
     *
     * Deliberately unlike the fixture's entries: `seconds` and `rounded_seconds`
     * differ, one entry is non-billable, and one sits a day outside the range,
     * so a report that confused the two durations, ignored `billable`, or
     * ignored the dates cannot still produce these figures.
     */
    const seedMemberWeek = async (harness: Harness): Promise<void> => {
      // time_entries keys (user_assignment, project, user) as a triple, so this
      // member needs their own assignment on the root project before they can
      // have booked an hour to it.
      await harness.run(
        `INSERT INTO user_assignments
          (id, project_id, user_id, is_active, is_project_manager, created_at, updated_at)
         VALUES (26, 1, 2, 1, 0, ?, ?)`,
        [now, now],
      );
      await harness.run(
        `INSERT INTO time_entries
          (id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
           spent_date, seconds, seconds_without_timer, rounded_seconds, billable, budgeted,
           billable_rate_cents, cost_rate_cents, created_at, updated_at) VALUES
          (301, 2, 2, 1, 24, 12, '2026-08-05', 5400, 5400, 7200, 1, 1, 12345, 5000, ?, ?),
          (302, 2, 2, 1, 24, 12, '2026-08-06', 1800, 1800, 1800, 0, 0, NULL, 5000, ?, ?),
          (303, 2, 1, 1, 26, 11, '2026-08-07', 3600, 3600, 3600, 1, 1, 10000, 4000, ?, ?),
          (304, 2, 2, 1, 24, 12, '2026-07-31', 3600, 3600, 3600, 1, 1, 12345, 5000, ?, ?)`,
        [now, now, now, now, now, now, now, now],
      );
    };

    it("[api] totals a member's own hours by project, tracked and rounded apart", async () => {
      harness = await factory();
      await seedMemberWeek(harness);
      const response = await harness.request(
        "/reports/my-hours?from=2026-08-01&to=2026-08-31",
        "member",
        [],
        2,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as {
        data: {
          user_id: number;
          project_id: number | null;
          seconds: number;
          rounded_seconds: number;
          billable_seconds: number;
          time_entry_count: number;
          projects: Array<Record<string, unknown>>;
        };
      };

      // 5400 + 1800 tracked on Child project, 3600 on Root; the 31 July entry
      // is outside the range and the non-billable hour is out of the billable
      // column but not the tracked one.
      expect(body.data).toMatchObject({
        user_id: 2,
        project_id: null,
        seconds: 10_800,
        rounded_seconds: 12_600,
        billable_seconds: 10_800,
        time_entry_count: 3,
      });
      // Ordered by client, then project: "Child" before "Root".
      expect(body.data.projects).toEqual([
        {
          project_id: 2,
          project_name: "Child project",
          project_code: "CHILD",
          client_id: 2,
          client_name: "Child",
          seconds: 7200,
          rounded_seconds: 9000,
          billable_seconds: 7200,
          time_entry_count: 2,
        },
        {
          project_id: 1,
          project_name: "Root project",
          project_code: "ROOT",
          client_id: 1,
          client_name: "Root",
          seconds: 3600,
          rounded_seconds: 3600,
          billable_seconds: 3600,
          time_entry_count: 1,
        },
      ]);
    });

    it("[security] scopes a member's hours to that member, whatever the request says", async () => {
      harness = await factory();
      await seedMemberWeek(harness);
      const range = "from=2026-08-01&to=2026-08-31";

      // The fixture's 9900 tracked seconds belong to user 1. Nothing user 2 can
      // put in the address reaches them: user_id is not an accepted parameter,
      // and the person the report covers is the authenticated principal.
      const named = await harness.request(
        `/reports/my-hours?${range}&user_id=1`,
        "member",
        [],
        2,
      );
      expect(named.status, await named.clone().text()).toBe(422);

      const member = await harness.request(
        `/reports/my-hours?${range}`,
        "member",
        [],
        2,
      );
      const memberBody = (await member.json()) as {
        data: { user_id: number; seconds: number; projects: Array<{ project_id: number }> };
      };
      expect(memberBody.data.user_id).toBe(2);
      expect(memberBody.data.seconds).toBe(10_800);
      // Project 3 and project 4 carry only user 1's entries, so a report that
      // had widened past this member would name them.
      expect(memberBody.data.projects.map((project) => project.project_id)).toEqual([
        2, 1,
      ]);

      // The same endpoint, the same range, a different session: the account's
      // own administrator sees their hours and not the member's.
      const administrator = await harness.request(`/reports/my-hours?${range}`);
      const administratorBody = (await administrator.json()) as {
        data: { user_id: number; seconds: number; time_entry_count: number };
      };
      expect(administratorBody.data).toMatchObject({
        user_id: 1,
        seconds: 9900,
        time_entry_count: 4,
      });
    });

    it("[api] narrows one member's hours to a single project without widening the person", async () => {
      harness = await factory();
      await seedMemberWeek(harness);
      const response = await harness.request(
        "/reports/my-hours?from=2026-08-01&to=2026-08-31&project_id=2",
        "member",
        [],
        2,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as {
        data: {
          user_id: number;
          project_id: number | null;
          seconds: number;
          rounded_seconds: number;
          time_entry_count: number;
          projects: Array<{ project_id: number }>;
        };
      };
      expect(body.data).toMatchObject({
        user_id: 2,
        project_id: 2,
        seconds: 7200,
        rounded_seconds: 9000,
        time_entry_count: 2,
      });
      expect(body.data.projects.map((project) => project.project_id)).toEqual([2]);
    });

    it("[security] serves my-hours to every profile and hides no money in it", async () => {
      harness = await factory();
      // time_entries:read, not reports:read: these are the acting user's own
      // entries, so the three reporting profiles are not the ceiling. And no
      // money field appears for anybody, so there is nothing here to redact.
      const moneyFields = ["cost_cents", "billable_rate_cents", "total_cents"];
      for (const profile of profiles) {
        const response = await harness.request(
          "/reports/my-hours?from=2026-08-01&to=2026-08-31",
          profile,
        );
        expect(response.status, `${profile}: ${await response.clone().text()}`).toBe(
          200,
        );
        const body = (await response.json()) as {
          data: Record<string, unknown> & {
            projects: Array<Record<string, unknown>>;
          };
        };
        for (const field of moneyFields) {
          expect(Object.hasOwn(body.data, field), `${profile} ${field}`).toBe(false);
          expect(
            body.data.projects.some((project) => Object.hasOwn(project, field)),
            `${profile} ${field}`,
          ).toBe(false);
        }
      }
    });

    it("[security] serves contractor cost to an administrator and to nobody else", async () => {
      // Every column of this report is a cost, and cost authority is the
      // administrator's alone. Refusing the whole report beats serving one with
      // its numbers stripped, where a person with no rate and a rate the reader
      // may not see would look identical.
      harness = await factory();

      const allowed = await harness.request(
        "/reports/contractor?from=2026-08-01&to=2026-08-31",
      );
      expect(allowed.status, await allowed.clone().text()).toBe(200);
      const body = (await allowed.json()) as {
        data: { from: string; to: string; rows: { cost_cents: number | null }[] };
      };
      expect(body.data.from).toBe("2026-08-01");
      expect(body.data.to).toBe("2026-08-31");
      // The fixture has tracked time, so this must not be vacuously empty --
      // an empty set would satisfy every assertion below without measuring one.
      expect(body.data.rows.length).toBeGreaterThan(0);

      for (const profile of [
        "member",
        "project_manager",
        "people_admin",
        "accounting",
        "executive_manager",
      ] as const) {
        const refused = await harness.request(
          "/reports/contractor?from=2026-08-01&to=2026-08-31",
          profile,
        );
        expect(refused.status, `${profile} reached the contractor report`).toBe(403);
      }
    });

    it("[unit] keeps uninvoiced totals identical to the generation preview to the cent", async () => {
      harness = await factory();
      const response = await harness.request(
        "/reports/uninvoiced?from=2026-08-01&to=2026-08-31",
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as {
        data: { totals: unknown[] };
      };
      const expected = uninvoicedGenerationPreview({
        timeEntries: [
          {
            id: 101,
            currency: "USD",
            roundedSeconds: 3600,
            billableRateCents: 10000,
          },
          {
            id: 102,
            currency: "USD",
            roundedSeconds: 1800,
            billableRateCents: 12345,
          },
          {
            id: 103,
            currency: "USD",
            roundedSeconds: 900,
            billableRateCents: 8000,
          },
        ],
        expenses: [
          { id: 201, currency: "USD", totalCostCents: 2500 },
          { id: 202, currency: "USD", totalCostCents: 1000 },
          { id: 203, currency: "USD", totalCostCents: 500 },
        ],
      });
      expect(body.data.totals).toEqual(
        expected.map((total) => ({
          currency: total.currency,
          rounded_seconds: total.roundedSeconds,
          time_entry_count: total.timeEntryCount,
          unpriced_time_entry_count: total.unpricedTimeEntryCount,
          expense_count: total.expenseCount,
          time_cents: total.timeCents,
          expense_cents: total.expenseCents,
          total_cents: total.totalCents,
        })),
      );
      expect(body.data.totals).toEqual([
        expect.objectContaining({ total_cents: 22173 }),
      ]);
    });

    it("[api] rolls direct metrics through every level of a 3-level client tree", async () => {
      harness = await factory();
      const response = await harness.request(
        "/reports/client-rollups/1?from=2026-08-01&to=2026-08-31",
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as {
        data: {
          nodes: Array<{
            client_id: number;
            direct: { rounded_seconds: number };
            rollup: {
              rounded_seconds: number;
              time_budget_seconds: number;
              currencies: Array<Record<string, number | string>>;
            };
          }>;
        };
      };
      expect(
        body.data.nodes.map((node) => ({
          id: node.client_id,
          direct: node.direct.rounded_seconds,
          rollup: node.rollup.rounded_seconds,
        })),
      ).toEqual([
        { id: 1, direct: 3600, rollup: 6300 },
        { id: 2, direct: 1800, rollup: 2700 },
        { id: 3, direct: 900, rollup: 900 },
      ]);
      expect(body.data.nodes[0]!.rollup).toMatchObject({
        time_budget_seconds: 72000,
        currencies: [
          expect.objectContaining({
            currency: "USD",
            expense_cents: 4000,
            uninvoiced_total_cents: 22173,
            money_budget_cents: 80000,
            cost_cents: 8000,
          }),
        ],
      });
    });

    it("[api] keeps archived-project work out of the uninvoiced figures only", async () => {
      // Harvest reports uninvoiced work for active projects only, so an
      // archived project contributes nothing there or to the rollup's
      // uninvoiced columns — while the time it holds is still tracked, still
      // costed, and still spent against its budget.
      harness = await factory();
      const range = "from=2026-08-01&to=2026-08-31";

      const uninvoiced = await harness.request(
        `/reports/uninvoiced?${range}&client_id=4`,
      );
      expect(uninvoiced.status, await uninvoiced.clone().text()).toBe(200);
      const uninvoicedBody = (await uninvoiced.json()) as {
        data: { totals: unknown[] };
      };
      expect(uninvoicedBody.data.totals).toEqual([]);

      const rollup = await harness.request(`/reports/client-rollups/4?${range}`);
      const rollupBody = (await rollup.json()) as {
        data: { nodes: Array<{ direct: Record<string, unknown> }> };
      };
      expect(rollupBody.data.nodes[0]!.direct).toMatchObject({
        rounded_seconds: 3600,
        billable_seconds: 3600,
        currencies: [
          expect.objectContaining({
            currency: "USD",
            expense_cents: 700,
            uninvoiced_time_cents: 0,
            uninvoiced_expense_cents: 0,
            uninvoiced_total_cents: 0,
            cost_cents: 3000,
          }),
        ],
      });

      const budget = await harness.request(`/reports/project-budget/4?${range}`);
      const budgetBody = (await budget.json()) as {
        data: { grains: Array<Record<string, unknown>> };
      };
      expect(budgetBody.data.grains[0]).toMatchObject({
        budget_seconds: 7200,
        spent_seconds: 3600,
        remaining_seconds: 3600,
      });
    });

    it("[api] redacts project-budget money fields for all six profiles", async () => {
      harness = await factory();
      const fieldsByProfile: Record<UserProfile, string[]> = {
        member: [],
        project_manager: [],
        people_admin: [],
        accounting: ["budget_cents", "remaining_cents", "spent_cents"],
        executive_manager: ["budget_cents", "remaining_cents", "spent_cents"],
        administrator: ["budget_cents", "remaining_cents", "spent_cents"],
      };
      for (const profile of profiles) {
        const response = await harness.request(
          "/reports/project-budget/2?from=2026-08-01&to=2026-08-31",
          profile,
        );
        expect(
          response.status,
          `${profile}: ${await response.clone().text()}`,
        ).toBe(200);
        const body = (await response.json()) as {
          data: { grains: Array<Record<string, unknown>> };
        };
        const grain = body.data.grains[0]!;
        expect(
          ["budget_cents", "remaining_cents", "spent_cents"].filter((field) =>
            Object.hasOwn(grain, field),
          ),
          profile,
        ).toEqual(fieldsByProfile[profile]);
        if (profile === "administrator") {
          expect(grain).toMatchObject({
            budget_cents: 30000,
            spent_cents: 6173,
            remaining_cents: 23827,
          });
        }
      }

      const manager = await harness.request(
        "/reports/project-budget/2?from=2026-08-01&to=2026-08-31",
        "project_manager",
        ["billable_rates_manager"],
      );
      const managerGrain = (
        (await manager.json()) as {
          data: { grains: Array<Record<string, unknown>> };
        }
      ).data.grains[0]!;
      expect(managerGrain).toHaveProperty("spent_cents", 6173);
      expect(managerGrain).not.toHaveProperty("budget_cents");
      expect(managerGrain).not.toHaveProperty("remaining_cents");
    });

    it("[api] separates cost-budget authority from money-budget visibility", async () => {
      harness = await factory();
      const accounting = await harness.request(
        "/reports/project-budget/3?from=2026-08-01&to=2026-08-31",
        "accounting",
      );
      const accountingGrain = (
        (await accounting.json()) as {
          data: { grains: Array<Record<string, unknown>> };
        }
      ).data.grains[0]!;
      expect(accountingGrain).toHaveProperty("budget_cents", 50000);
      expect(accountingGrain).not.toHaveProperty("spent_cents");
      expect(accountingGrain).not.toHaveProperty("remaining_cents");

      const administrator = await harness.request(
        "/reports/project-budget/3?from=2026-08-01&to=2026-08-31",
      );
      const administratorGrain = (
        (await administrator.json()) as {
          data: { grains: Array<Record<string, unknown>> };
        }
      ).data.grains[0]!;
      expect(administratorGrain).toMatchObject({
        budget_cents: 50000,
        spent_cents: 2000,
        remaining_cents: 48000,
      });
    });

    it("[security] enforces project report visibility and assignment row access", async () => {
      harness = await factory();
      const range = "?from=2026-08-01&to=2026-08-31";

      const memberOnManagersOnly = await harness.request(
        `/reports/project-budget/1${range}`,
        "member",
      );
      expect(memberOnManagersOnly.status).toBe(404);

      const managerOnManagedProject = await harness.request(
        `/reports/project-budget/1${range}`,
        "project_manager",
      );
      expect(managerOnManagedProject.status).toBe(200);

      const managerWithoutProjectGrant = await harness.request(
        `/reports/project-budget/3${range}`,
        "project_manager",
      );
      expect(managerWithoutProjectGrant.status).toBe(404);

      const memberOnEveryoneProject = await harness.request(
        `/reports/project-budget/2${range}`,
        "member",
      );
      expect(memberOnEveryoneProject.status).toBe(200);

      const inactiveAssignment = await harness.request(
        `/reports/project-budget/2${range}`,
        "member",
        [],
        2,
      );
      expect(inactiveAssignment.status).toBe(404);

      const accountWideViewer = await harness.request(
        `/reports/project-budget/3${range}`,
        "accounting",
        [],
        2,
      );
      expect(accountWideViewer.status).toBe(200);
    });

    /**
     * A second entry on the same day, project, task and person as fixture 101,
     * plus a non-billable one and an invoiced one, so a reader that ignored the
     * fold, the billable flag, or `invoice_id` cannot produce these figures.
     */
    const seedDetailedDay = async (harness: Harness): Promise<void> => {
      await harness.run(
        `INSERT INTO invoices
          (id, client_id, number, issue_date, due_date, currency, subject, notes,
           purchase_order, state, created_at, updated_at)
         VALUES (301, 1, 'INV-301', '2026-08-20', '2026-09-20', 'USD', NULL, NULL,
           NULL, 'draft', ?, ?)`,
        [now, now],
      );
      await harness.run(
        `INSERT INTO time_entries
          (id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
           spent_date, seconds, seconds_without_timer, rounded_seconds, billable, budgeted,
           billable_rate_cents, cost_rate_cents, invoice_id, created_at, updated_at) VALUES
          (111, 1, 1, 1, 21, 11, '2026-08-10', 1800, 1800, 1800, 1, 1, 10000, 4000, NULL, ?, ?),
          (112, 1, 1, 1, 21, 11, '2026-08-10', 900, 900, 900, 0, 0, NULL, 4000, NULL, ?, ?),
          (113, 1, 1, 1, 21, 11, '2026-08-17', 3600, 3600, 3600, 1, 1, 10000, 4000, 301, ?, ?)`,
        [now, now, now, now, now, now],
      );
    };

    it("[db] folds a day's entries into one line per task and person", async () => {
      harness = await factory();
      await seedDetailedDay(harness);
      const result = await harness.reports.detailedTime({
        from: "2026-08-10",
        to: "2026-08-10",
        projectId: 1,
      });
      if (result.kind !== "report") throw new Error("expected a report");

      // Counted before anything is read out of it: three entries on one day
      // against one task and one person are one line, and a test that indexed
      // into an empty array would pass against a reader that returned nothing.
      expect(result.report.rows).toHaveLength(1);
      const row = result.report.rows[0]!;
      expect(row).toMatchObject({
        spentDate: "2026-08-10",
        projectId: 1,
        taskId: 1,
        userId: 1,
        timeEntryCount: 3,
        // 3600 billable + 1800 billable + 900 non-billable
        seconds: 6300,
        billableSeconds: 5400,
        uninvoicedBillableSeconds: 5400,
      });
      // Priced per entry at 100.00/h: one hour and a half hour.
      expect(row.billableAmountCents).toBe(15_000);
      expect(result.report.timeEntryCount).toBe(3);
      expect(result.report.seconds).toBe(6300);

      // The same project, task and person on a second date stays a second
      // line: the date is part of the grain, not a column beside it, and a
      // fold that dropped it would report a month as a single row.
      const month = await harness.reports.detailedTime({
        from: "2026-08-01",
        to: "2026-08-31",
        projectId: 1,
      });
      if (month.kind !== "report") throw new Error("expected a report");
      expect(month.report.rows).toHaveLength(2);
      expect(month.report.rows.map((line) => line.spentDate)).toEqual([
        "2026-08-10",
        "2026-08-17",
      ]);
    });

    it("[db] separates invoiced billable hours from uninvoiced ones", async () => {
      harness = await factory();
      await seedDetailedDay(harness);
      const result = await harness.reports.detailedTime({
        from: "2026-08-01",
        to: "2026-08-31",
        projectId: 1,
      });
      if (result.kind !== "report") throw new Error("expected a report");

      expect(result.report.rows.length).toBeGreaterThan(0);
      // Entry 113 is billable and carries an invoice, so it counts towards
      // billable hours and not towards the uninvoiced figure the summary leads
      // with. A reader that treated "billable" as "uninvoiced" would report
      // 9000 for both.
      expect(result.report.billableSeconds).toBe(9000);
      expect(result.report.uninvoicedBillableSeconds).toBe(5400);
    });

    it("[db] narrows the rows to the Show control's four answers", async () => {
      harness = await factory();
      await seedDetailedDay(harness);
      const range = { from: "2026-08-01", to: "2026-08-31", projectId: 1 } as const;
      const totals: Record<string, number> = {};
      for (const hours of ["all", "billable", "non_billable", "uninvoiced"] as const) {
        const result = await harness.reports.detailedTime({ ...range, hours });
        if (result.kind !== "report") throw new Error("expected a report");
        totals[hours] = result.report.seconds;
      }
      expect(totals).toEqual({
        all: 9900,
        billable: 9000,
        non_billable: 900,
        uninvoiced: 5400,
      });
    });

    it("[db] keeps archived projects unless active projects only is asked for", async () => {
      harness = await factory();
      const range = { from: "2026-08-01", to: "2026-08-31" } as const;

      const everything = await harness.reports.detailedTime(range);
      if (everything.kind !== "report") throw new Error("expected a report");
      // Project 4 is archived and holds entry 104. Time booked to a project
      // that has since closed is still time somebody worked.
      expect(everything.report.rows.map((row) => row.projectId)).toContain(4);

      const activeOnly = await harness.reports.detailedTime({
        ...range,
        activeProjectsOnly: true,
      });
      if (activeOnly.kind !== "report") throw new Error("expected a report");
      expect(activeOnly.report.rows.length).toBeGreaterThan(0);
      expect(activeOnly.report.rows.map((row) => row.projectId)).not.toContain(4);
    });

    it("[db] carries every role the person holds, name-ordered", async () => {
      harness = await factory();
      await harness.run(
        `INSERT INTO roles (id, name, created_at, updated_at) VALUES
          (1, 'Delivery', ?, ?), (2, 'Accounts', ?, ?)`,
        [now, now, now, now],
      );
      await harness.run(
        `INSERT INTO user_roles (user_id, role_id, created_at, updated_at) VALUES
          (1, 1, ?, ?), (1, 2, ?, ?)`,
        [now, now, now, now],
      );
      const result = await harness.reports.detailedTime({
        from: "2026-08-10",
        to: "2026-08-10",
      });
      if (result.kind !== "report") throw new Error("expected a report");

      expect(result.report.rows).toHaveLength(1);
      // Ordered by name, not by membership order: group_concat leaves the order
      // to the query planner, and the column would otherwise reshuffle itself
      // between runs of the same report.
      expect(result.report.rows[0]!.roles).toEqual(["Accounts", "Delivery"]);
    });

    it("[db] refuses to total billable amounts across an unrated entry", async () => {
      harness = await factory();
      await harness.run(
        `INSERT INTO time_entries
          (id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
           spent_date, seconds, seconds_without_timer, rounded_seconds, billable, budgeted,
           billable_rate_cents, cost_rate_cents, created_at, updated_at)
         VALUES (121, 1, 1, 1, 21, 11, '2026-08-10', 3600, 3600, 3600, 1, 1, NULL, 4000, ?, ?)`,
        [now, now],
      );
      const result = await harness.reports.detailedTime({
        from: "2026-08-10",
        to: "2026-08-10",
      });
      if (result.kind !== "report") throw new Error("expected a report");

      expect(result.report.rows).toHaveLength(1);
      expect(result.report.rows[0]!.billableAmountCents).toBeNull();
      expect(result.report.rows[0]!.entriesWithoutBillableRate).toBe(1);
      // The hours are still known, and still totalled.
      expect(result.report.rows[0]!.seconds).toBe(7200);
      expect(result.report.currencies).toEqual([
        { currency: "USD", billableAmountCents: null, entriesWithoutBillableRate: 1 },
      ]);
    });

    it("[api] serves the detailed report and echoes the filters it was run with", async () => {
      harness = await factory();
      await seedDetailedDay(harness);
      const response = await harness.request(
        "/reports/detailed-time?from=2026-08-01&to=2026-08-31&project_id=1&hours=uninvoiced&active_projects_only=true",
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: {
          hours: string;
          active_projects_only: boolean;
          seconds: number;
          rows: Array<Record<string, unknown>>;
        };
      };
      expect(body.data.hours).toBe("uninvoiced");
      expect(body.data.active_projects_only).toBe(true);
      expect(body.data.rows.length).toBeGreaterThan(0);
      expect(body.data.seconds).toBe(5400);
      expect(body.data.rows[0]).toHaveProperty("billable_amount_cents");
      expect(body.data.rows[0]).toHaveProperty("roles");
    });

    it("[security] refuses the detailed report to profiles without reports:read", async () => {
      harness = await factory();
      const path = "/reports/detailed-time?from=2026-08-01&to=2026-08-31";
      for (const profile of ["member", "project_manager", "people_admin"] as const) {
        const response = await harness.request(path, profile);
        expect(response.status, profile).toBe(403);
      }
      for (const profile of [
        "accounting",
        "executive_manager",
        "administrator",
      ] as const) {
        const response = await harness.request(path, profile);
        expect(response.status, profile).toBe(200);
      }
    });

    it("[api] rejects an unreadable Show value and an unknown detailed filter", async () => {
      harness = await factory();
      for (const path of [
        "/reports/detailed-time?from=2026-08-01&to=2026-08-31&hours=everything",
        "/reports/detailed-time?from=2026-08-01&to=2026-08-31&active_projects_only=yes",
        "/reports/detailed-time?from=2026-08-01&to=2026-08-31&user_id=2",
      ]) {
        const response = await harness.request(path);
        expect(response.status, path).toBe(422);
      }
    });

    /**
     * SQLite only, deliberately. The point is the reader's own cap, and driving
     * twenty thousand rows back over the D1 RPC to re-prove a comparison that
     * lives in TypeScript costs a minute of every run for nothing.
     */
    if (runtime === "SQLite") {
      it("[db] refuses a range holding more entries than it will read", async () => {
        harness = await factory();
        await harness.run(
          `INSERT INTO time_entries
            (id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
             spent_date, seconds, seconds_without_timer, rounded_seconds, billable, budgeted,
             billable_rate_cents, cost_rate_cents, created_at, updated_at)
           SELECT 1000 + value, 1, 1, 1, 21, 11, '2026-08-15', 60, 60, 60, 1, 1,
             10000, 4000, ?, ?
           FROM (
             WITH RECURSIVE seq(value) AS (
               SELECT 1 UNION ALL SELECT value + 1 FROM seq WHERE value < ?
             ) SELECT value FROM seq
           )`,
          [now, now, DETAILED_TIME_ENTRY_LIMIT],
        );

        const under = await harness.reports.detailedTime({
          from: "2026-08-15",
          to: "2026-08-15",
        });
        // One short of the cap still reads: the refusal is a ceiling, not an
        // off-by-one that starts refusing early.
        expect(under.kind).toBe("report");

        await harness.run(
          `INSERT INTO time_entries
            (id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
             spent_date, seconds, seconds_without_timer, rounded_seconds, billable, budgeted,
             billable_rate_cents, cost_rate_cents, created_at, updated_at)
           VALUES (999999, 1, 1, 1, 21, 11, '2026-08-15', 60, 60, 60, 1, 1, 10000, 4000, ?, ?)`,
          [now, now],
        );
        const over = await harness.reports.detailedTime({
          from: "2026-08-15",
          to: "2026-08-15",
        });
        // Refused whole rather than served as a page. A truncated table under
        // totals covering the period would not add up, and nothing on screen
        // could say why.
        expect(over).toEqual({
          kind: "too_many_entries",
          limit: DETAILED_TIME_ENTRY_LIMIT,
        });

        const response = await harness.request(
          "/reports/detailed-time?from=2026-08-15&to=2026-08-15",
        );
        expect(response.status).toBe(422);
        const body = (await response.json()) as {
          error: { fields: Array<{ field: string; code: string }> };
        };
        expect(body.error.fields).toEqual([
          expect.objectContaining({ field: "to", code: "range_too_wide" }),
        ]);
      });
    }

    it("[api] rejects missing, duplicate, invalid, and inverted report filters", async () => {
      harness = await factory();
      for (const path of [
        "/reports/uninvoiced?to=2026-08-31",
        "/reports/uninvoiced?from=2026-08-01&from=2026-08-02&to=2026-08-31",
        "/reports/uninvoiced?from=2026-02-30&to=2026-08-31",
        "/reports/uninvoiced?from=2026-09-01&to=2026-08-31",
        "/reports/uninvoiced?from=2026-08-01&to=2026-08-31&unknown=true",
      ]) {
        const response = await harness.request(path);
        expect(response.status, path).toBe(422);
      }
    });
  });
}

/**
 * The route's own gate and the billable-rate gate currently admit the same
 * three profiles, so no request can reach the serializer without money rights.
 * That is a coincidence of two policies, not a guarantee -- widening
 * `reports:read` by one profile would silently publish every rate on the
 * account -- so the redaction is exercised where it lives.
 */
describe("detailed time serialization", () => {
  const record: DetailedTimeReportRecord = {
    from: "2026-08-01",
    to: "2026-08-31",
    clientId: null,
    projectId: null,
    hours: "all",
    activeProjectsOnly: false,
    seconds: 3600,
    roundedSeconds: 3600,
    billableSeconds: 3600,
    uninvoicedBillableSeconds: 3600,
    timeEntryCount: 1,
    currencies: [
      { currency: "USD", billableAmountCents: 10_000, entriesWithoutBillableRate: 1 },
    ],
    rows: [
      {
        spentDate: "2026-08-10",
        clientId: 1,
        clientName: "Root",
        projectId: 1,
        projectName: "Root project",
        projectCode: "ROOT",
        taskId: 1,
        taskName: "Delivery",
        userId: 1,
        userName: "Report Owner",
        roles: ["Delivery"],
        currency: "USD",
        seconds: 3600,
        roundedSeconds: 3600,
        billableSeconds: 3600,
        uninvoicedBillableSeconds: 3600,
        timeEntryCount: 1,
        billableAmountCents: 10_000,
        entriesWithoutBillableRate: 1,
      },
    ],
  };

  it("[security] withholds billable amounts from a viewer without billable-rate rights", () => {
    const redacted = serializeDetailedTime(record, {
      type: "user",
      userId: 9,
      profile: "project_manager",
      managerGrants: [],
      authentication: { kind: "session", sessionId: "serializer-test" },
    });

    expect(redacted.rows).toHaveLength(1);
    expect(redacted.rows[0]).not.toHaveProperty("billable_amount_cents");
    expect(redacted.currencies[0]).not.toHaveProperty("billable_amount_cents");
    // Hours survive: this report answers who worked on what and for how long,
    // and stripping that alongside the money would leave nothing.
    expect(redacted.rows[0]).toMatchObject({ seconds: 3600, roles: ["Delivery"] });
    // Not gated: it counts entries, not money, and it is the only thing that
    // stops a partial billable total reading as a complete one.
    expect(redacted.rows[0]!.entries_without_billable_rate).toBe(1);
  });

  it("[security] serves billable amounts to a project manager holding the rates grant", () => {
    const granted = serializeDetailedTime(record, {
      type: "user",
      userId: 9,
      profile: "project_manager",
      managerGrants: ["billable_rates_manager"],
      authentication: { kind: "session", sessionId: "serializer-test" },
    });

    expect(granted.rows).toHaveLength(1);
    expect(granted.rows[0]).toHaveProperty("billable_amount_cents", 10_000);
    expect(granted.currencies[0]).toHaveProperty("billable_amount_cents", 10_000);
  });
});
