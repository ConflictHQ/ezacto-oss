import { uninvoicedGenerationPreview } from "@ezacto/core";
import BetterSqlite3 from "better-sqlite3";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import {
  createContainerDatabase,
  createD1Database,
} from "../../db/src/adapters.js";
import { migrateContainer, migrateD1 } from "../../db/src/migrate.js";
import { createReportRepository } from "../../db/src/reports.js";
import {
  createApiApp,
  installReportRoutes,
  type ApiAuthentication,
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
