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
      (3, 'Leaf', 'USD', 2, ?, ?)`,
    params: [now, now, now, now, now, now],
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
    sql: `INSERT INTO tasks
      (id, name, created_at, updated_at) VALUES (1, 'Delivery', ?, ?)`,
    params: [now, now],
  },
  {
    sql: `INSERT INTO task_assignments
      (id, project_id, task_id, billable, budget_cents, created_at, updated_at) VALUES
      (11, 1, 1, 1, NULL, ?, ?),
      (12, 2, 1, 1, 30000, ?, ?),
      (13, 3, 1, 1, NULL, ?, ?)`,
    params: [now, now, now, now, now, now],
  },
  {
    sql: `INSERT INTO user_assignments
      (id, project_id, user_id, is_active, is_project_manager, created_at, updated_at) VALUES
      (21, 1, 1, 1, 1, ?, ?), (22, 2, 1, 1, 0, ?, ?),
      (23, 3, 1, 1, 0, ?, ?), (24, 2, 2, 0, 1, ?, ?)`,
    params: [now, now, now, now, now, now, now, now],
  },
  {
    sql: `INSERT INTO time_entries
      (id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
       spent_date, seconds, seconds_without_timer, rounded_seconds, billable, budgeted,
       billable_rate_cents, cost_rate_cents, created_at, updated_at) VALUES
      (101, 1, 1, 1, 21, 11, '2026-08-10', 3600, 3600, 3600, 1, 1, 10000, 4000, ?, ?),
      (102, 1, 2, 1, 22, 12, '2026-08-11', 1800, 1800, 1800, 1, 1, 12345, 5000, ?, ?),
      (103, 1, 3, 1, 23, 13, '2026-08-12', 900, 900, 900, 1, 1, 8000, 6000, ?, ?)`,
    params: [now, now, now, now, now, now],
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
      (203, 1, 3, 1, '2026-08-12', 500, 1, ?, ?)`,
    params: [now, now, now, now, now, now],
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
