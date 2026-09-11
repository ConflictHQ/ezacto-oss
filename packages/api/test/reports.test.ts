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
import { serializeTimeReport } from "../src/reports.js";
import type { UserPrincipal } from "../src/context.js";

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
     * The four tabs are folds of one query, so the test that matters is that
     * they still add up to the same month. Each grouping's row count is
     * asserted before anything is measured over it: a fold that returned
     * nothing would satisfy every sum below without measuring one row.
     */
    it("[db] folds one dataset four ways and the four tabs agree", async () => {
      harness = await factory();
      const report = await harness.reports.timeReport({
        from: "2026-08-01",
        to: "2026-08-31",
      });

      expect(report.clients).toHaveLength(4);
      expect(report.projects).toHaveLength(4);
      expect(report.tasks).toHaveLength(1);
      expect(report.teammates).toHaveLength(1);

      expect(report.totals).toMatchObject({
        seconds: 9900,
        roundedSeconds: 9900,
        billableSeconds: 9900,
        timeEntryCount: 4,
        unpricedBillableEntryCount: 0,
      });
      // 3600s @ 100.00 + 1800s @ 123.45 + 900s @ 80.00 + 3600s @ 90.00.
      expect(report.totals.amounts).toEqual([
        { currency: "USD", billableCents: 27_173, uninvoicedCents: 18_173 },
      ]);

      for (const [tab, rows] of [
        ["clients", report.clients],
        ["projects", report.projects],
        ["tasks", report.tasks],
        ["teammates", report.teammates],
      ] as const) {
        expect(
          rows.reduce((sum, row) => sum + row.roundedSeconds, 0),
          `${tab} hours`,
        ).toBe(report.totals.roundedSeconds);
        expect(
          rows.reduce((sum, row) => sum + row.timeEntryCount, 0),
          `${tab} entries`,
        ).toBe(report.totals.timeEntryCount);
        expect(
          rows.reduce(
            (sum, row) => sum + (row.amounts[0]?.billableCents ?? 0),
            0,
          ),
          `${tab} billable amount`,
        ).toBe(27_173);
      }

      // Hours descending, ties broken by name: the two 1.00h rows are ordered
      // "Archived" before "Root", not by insertion.
      expect(report.projects.map((project) => project.projectName)).toEqual([
        "Archived project",
        "Root project",
        "Child project",
        "Leaf project",
      ]);
      // projects.code is NOT NULL DEFAULT '', so the code is a string on every
      // row and a project without one renders as its bare name, never "[] Name".
      expect(report.projects[0]).toMatchObject({
        projectCode: "ARCH",
        clientId: 4,
        clientName: "Archived holder",
      });
      expect(report.tasks[0]).toMatchObject({ taskId: 1, taskName: "Delivery" });
    });

    /**
     * The distinction the whole KPI strip rests on. Work on an archived project
     * is still billable work that happened; it is not uninvoiced work, because
     * the uninvoiced report will not offer it for invoicing. Two numbers in one
     * product both called "uninvoiced" that disagree is exactly the confusion
     * #519 was raised over, so the assertion is against the other report's own
     * output rather than against a figure retyped here.
     */
    it("[db] counts archived-project work as billable but never as uninvoiced", async () => {
      harness = await factory();
      const report = await harness.reports.timeReport({
        from: "2026-08-01",
        to: "2026-08-31",
      });
      const archived = report.projects.find((project) => project.projectId === 4);
      const root = report.projects.find((project) => project.projectId === 1);
      expect(archived, "archived project row").toBeDefined();
      expect(root, "root project row").toBeDefined();
      expect(archived!.amounts).toEqual([
        { currency: "USD", billableCents: 9000, uninvoicedCents: 0 },
      ]);
      expect(root!.amounts).toEqual([
        { currency: "USD", billableCents: 10_000, uninvoicedCents: 10_000 },
      ]);

      const uninvoiced = await harness.reports.uninvoiced({
        from: "2026-08-01",
        to: "2026-08-31",
      });
      expect(uninvoiced.totals).toHaveLength(1);
      expect(report.totals.amounts[0]!.uninvoicedCents).toBe(
        uninvoiced.totals[0]!.timeCents,
      );
    });

    it("[db] agrees with the uninvoiced reader on every clause, not just the active one", async () => {
      // The equality above passed over a fixture where three of the four
      // conditions were inert: no entry had an `invoice_id`, a running timer, or
      // a start without an end. The whole predicate could be deleted down to
      // `billable AND project.is_active` and every test stayed green, while a
      // regressed Time report would overstate `Uninvoiced amount` against the
      // Uninvoiced report -- the drift this pair of readers exists to prevent.
      //
      // Both are billable, priced and inside the period, so each lands in the
      // billable amount. Neither is uninvoiced work.
      //
      // The predicate's fourth clause -- a start with no end -- cannot be seeded
      // here: this organisation runs in `duration` mode, and the shape
      // constraint refuses a `started_time` outright. It is covered by that
      // constraint rather than by this test, which is worth knowing before
      // someone reads the equality below as proving all four.
      harness = await factory();
      await harness.run(
        `INSERT INTO invoices
          (id, client_id, number, currency, issue_date, due_date, payment_terms,
           state, amount_cents, due_amount_cents, created_at, updated_at)
         VALUES (900, 1, 'T-900', 'USD', '2026-08-20', '2026-09-19', 'net_30',
           'open', 10000, 10000, ?, ?)`,
        [now, now],
      );
      await harness.run(
        `INSERT INTO time_entries
          (id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
           spent_date, seconds, seconds_without_timer, rounded_seconds, billable, budgeted,
           billable_rate_cents, cost_rate_cents, invoice_id, timer_started_at,
           started_time, ended_time, created_at, updated_at)
         VALUES
           (901, 1, 1, 1, 21, 11, '2026-08-15', 3600, 3600, 3600, 1, 1, 10000, 4000,
             900, NULL, NULL, NULL, ?, ?),
           (902, 1, 1, 1, 21, 11, '2026-08-16', 3600, 3600, 3600, 1, 1, 10000, 4000,
             NULL, ?, NULL, NULL, ?, ?)`,
        [now, now, now, now, now],
      );

      const report = await harness.reports.timeReport({
        from: "2026-08-01",
        to: "2026-08-31",
      });
      const uninvoiced = await harness.reports.uninvoiced({
        from: "2026-08-01",
        to: "2026-08-31",
      });

      // Counted first: an insert that silently failed would leave the two
      // readers agreeing over the original fixture and prove nothing.
      expect(report.totals.timeEntryCount).toBe(6);
      expect(report.totals.amounts).toHaveLength(1);
      expect(uninvoiced.totals).toHaveLength(1);

      // Two more billable hours at 100.00 each on top of the original 271.73.
      expect(report.totals.amounts[0]!.billableCents).toBe(27_173 + 20_000);
      // And none of them is uninvoiced: the figure is unchanged.
      expect(report.totals.amounts[0]!.uninvoicedCents).toBe(18_173);
      expect(report.totals.amounts[0]!.uninvoicedCents).toBe(
        uninvoiced.totals[0]!.timeCents,
      );
    });

    it("[db] leaves an unrated billable hour out of the amount and says so", async () => {
      harness = await factory();
      await harness.run(
        `INSERT INTO time_entries
          (id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
           spent_date, seconds, seconds_without_timer, rounded_seconds, billable, budgeted,
           billable_rate_cents, cost_rate_cents, created_at, updated_at)
         VALUES (198, 1, 1, 1, 21, 11, '2026-08-14', 3600, 3600, 3600, 1, 1, NULL, 4000, ?, ?)`,
        [now, now],
      );
      const report = await harness.reports.timeReport({
        from: "2026-08-01",
        to: "2026-08-31",
      });
      // The hour is real and counts as billable time; only its price is
      // unknown. Pricing it at zero would make an unpriced month read as a
      // cheap one, and the count is what says the amount is partial.
      expect(report.totals.roundedSeconds).toBe(13_500);
      expect(report.totals.billableSeconds).toBe(13_500);
      expect(report.totals.unpricedBillableEntryCount).toBe(1);
      expect(report.totals.amounts).toEqual([
        { currency: "USD", billableCents: 27_173, uninvoicedCents: 18_173 },
      ]);
      const root = report.projects.find((project) => project.projectId === 1);
      expect(root!.unpricedBillableEntryCount).toBe(1);
    });

    /**
     * Every other entry in the fixture has `seconds` equal to `rounded_seconds`,
     * which makes a column reading the wrong duration invisible. This one is
     * rounded up from 1.50h to 2.00h, so the two answers differ by half an hour
     * and half an hour's money -- the difference between this report and the
     * invoice it is supposed to agree with.
     */
    it("[db] counts and prices the rounded hours, not the tracked ones", async () => {
      harness = await factory();
      await harness.run(
        `INSERT INTO time_entries
          (id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
           spent_date, seconds, seconds_without_timer, rounded_seconds, billable, budgeted,
           billable_rate_cents, cost_rate_cents, created_at, updated_at)
         VALUES (196, 1, 1, 1, 21, 11, '2026-08-15', 5400, 5400, 7200, 1, 1, 10000, 4000, ?, ?)`,
        [now, now],
      );
      const report = await harness.reports.timeReport({
        from: "2026-08-01",
        to: "2026-08-31",
      });
      expect(report.totals).toMatchObject({
        seconds: 15_300,
        roundedSeconds: 17_100,
        // 17_100, not the 15_300 tracked: billable time is rounded time on
        // billable entries.
        billableSeconds: 17_100,
        timeEntryCount: 5,
      });
      // 27_173 before, plus 7200s @ 100.00 = 20_000. Priced off the tracked
      // 1.50h it would be 15_000, and the report would undercount the invoice.
      expect(report.totals.amounts).toEqual([
        { currency: "USD", billableCents: 47_173, uninvoicedCents: 38_173 },
      ]);
      const root = report.projects.find((project) => project.projectId === 1);
      expect(root, "root project row").toBeDefined();
      expect(root!.seconds).toBe(9000);
      expect(root!.roundedSeconds).toBe(10_800);
    });

    it("[db] prorates weekly capacity across the reported days", async () => {
      harness = await factory();
      // Seven days is the window the team roster reports on, so a week here
      // must divide by exactly the stored weekly capacity -- that is what makes
      // the two screens comparable rather than merely similar.
      const week = await harness.reports.timeReport({
        from: "2026-08-10",
        to: "2026-08-16",
      });
      expect(week.teammates).toHaveLength(1);
      expect(week.teammates[0]).toMatchObject({
        userId: 1,
        isContractor: false,
        capacitySeconds: 126_000,
        roundedSeconds: 9900,
        utilizationPpm: 78_571,
      });

      const month = await harness.reports.timeReport({
        from: "2026-08-01",
        to: "2026-08-31",
      });
      // 126000 * 31 / 7. A month divided by one week's capacity would report
      // this person at four times their real utilization.
      expect(month.teammates[0]).toMatchObject({
        capacitySeconds: 558_000,
        utilizationPpm: 17_742,
      });
    });

    it("[db] states no utilization for a person with no capacity", async () => {
      harness = await factory();
      await harness.run(
        `INSERT INTO users
          (id, first_name, last_name, profile, manager_grants, is_contractor,
           weekly_capacity, created_at, updated_at)
         VALUES (9, 'Zero', 'Capacity', 'member', '[]', 1, 0, ?, ?)`,
        [now, now],
      );
      await harness.run(
        `INSERT INTO user_assignments
          (id, project_id, user_id, is_active, is_project_manager, created_at, updated_at)
         VALUES (29, 1, 9, 1, 0, ?, ?)`,
        [now, now],
      );
      await harness.run(
        `INSERT INTO time_entries
          (id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
           spent_date, seconds, seconds_without_timer, rounded_seconds, billable, budgeted,
           billable_rate_cents, cost_rate_cents, created_at, updated_at)
         VALUES (197, 9, 1, 1, 29, 11, '2026-08-15', 3600, 3600, 3600, 0, 0, NULL, NULL, ?, ?)`,
        [now, now],
      );
      const report = await harness.reports.timeReport({
        from: "2026-08-01",
        to: "2026-08-31",
      });
      const zero = report.teammates.find((teammate) => teammate.userId === 9);
      expect(zero, "zero-capacity teammate row").toBeDefined();
      // Null, not Infinity and not 0: a person with no capacity has no
      // utilization to state, and a 0% would read as somebody who did nothing.
      expect(zero!.utilizationPpm).toBeNull();
      expect(zero!.capacitySeconds).toBe(0);
      expect(zero!.roundedSeconds).toBe(3600);
      expect(zero!.isContractor).toBe(true);
      // Non-billable time opens no currency bucket: there is no amount to show.
      expect(zero!.amounts).toEqual([]);
      expect(report.totals.billableSeconds).toBe(9900);
      expect(report.totals.roundedSeconds).toBe(13_500);
    });

    it("[api] serves the time report to the reporting profiles and refuses the rest", async () => {
      harness = await factory();
      const range = "from=2026-08-01&to=2026-08-31";
      for (const profile of ["accounting", "executive_manager", "administrator"] as const) {
        const response = await harness.request(`/reports/time?${range}`, profile);
        expect(response.status, `${profile}: ${await response.clone().text()}`).toBe(200);
        const body = (await response.json()) as {
          data: {
            from: string;
            to: string;
            totals: { rounded_seconds: number; amounts?: unknown[] };
            projects: Array<{ project_code: string; amounts?: unknown[] }>;
            teammates: Array<{ utilization_ppm: number | null }>;
          };
        };
        expect(body.data.from).toBe("2026-08-01");
        expect(body.data.to).toBe("2026-08-31");
        // The fixture has tracked time, so an empty report would pass every
        // assertion under it without measuring a row.
        expect(body.data.projects.length, profile).toBeGreaterThan(0);
        expect(body.data.teammates.length, profile).toBeGreaterThan(0);
        expect(body.data.totals.rounded_seconds).toBe(9900);
        expect(body.data.totals.amounts).toEqual([
          { currency: "USD", billable_cents: 27_173, uninvoiced_cents: 18_173 },
        ]);
        expect(body.data.teammates[0]!.utilization_ppm).toBe(17_742);
      }
      for (const profile of ["member", "project_manager", "people_admin"] as const) {
        const refused = await harness.request(`/reports/time?${range}`, profile);
        expect(refused.status, `${profile} reached the time report`).toBe(403);
      }
    });

    it("[api] rejects a time report range that is missing, invalid or inverted", async () => {
      harness = await factory();
      for (const path of [
        "/reports/time?to=2026-08-31",
        "/reports/time?from=2026-08-01",
        "/reports/time?from=2026-02-30&to=2026-08-31",
        "/reports/time?from=2026-09-01&to=2026-08-31",
        "/reports/time?from=2026-08-01&to=2026-08-31&client_id=1",
      ]) {
        const response = await harness.request(path);
        expect(response.status, path).toBe(422);
      }
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

    it("[security] serves profitability to an administrator and to nobody else", async () => {
      // A margin is the cost figure with one subtraction applied, so it is
      // refused on the same authority as the contractor report rather than on
      // the broader financial one.
      harness = await factory();

      const allowed = await harness.request(
        "/reports/profitability?from=2026-08-01&to=2026-08-31",
      );
      expect(allowed.status, await allowed.clone().text()).toBe(200);
      const body = (await allowed.json()) as {
        data: { rows: unknown[] };
      };
      // The fixture tracks time on four projects, so an empty set would satisfy
      // every assertion below without measuring one.
      expect(body.data.rows.length).toBeGreaterThan(0);

      for (const profile of [
        "member",
        "project_manager",
        "people_admin",
        "accounting",
        "executive_manager",
      ] as const) {
        const refused = await harness.request(
          "/reports/profitability?from=2026-08-01&to=2026-08-31",
          profile,
        );
        expect(refused.status, `${profile} reached profitability`).toBe(403);
      }
    });

    it("[unit] states revenue, cost and margin per project against the window before", async () => {
      harness = await factory();
      const response = await harness.request(
        "/reports/profitability?from=2026-08-01&to=2026-08-31",
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as {
        data: {
          organization_currency: string;
          previous_from: string;
          previous_to: string;
          rows: {
            project_id: number;
            currency: string;
            revenue_cents: number | null;
            cost_cents: number | null;
            profit_cents: number | null;
          }[];
          totals: { profit_cents: number | null; projects_not_converted: number };
        };
      };
      expect(body.data.organization_currency).toBe("USD");
      // August has 31 days, so the window before it is the 31 days ending the
      // day before it starts -- not "the previous calendar month", which would
      // compare 31 days against 30 in April.
      expect(body.data.previous_from).toBe("2026-07-01");
      expect(body.data.previous_to).toBe("2026-07-31");

      const root = body.data.rows.find((row) => row.project_id === 1)!;
      // Entry 101 is exactly one hour at a $100.00 billable rate and a $40.00
      // cost rate. Hand-computed rather than derived from the code under test.
      expect(root.revenue_cents).toBe(10_000);
      expect(root.cost_cents).toBe(4_000);
      expect(root.profit_cents).toBe(6_000);

      // Every priced row in the organization's own currency is the subtraction
      // and nothing else.
      for (const row of body.data.rows) {
        if (
          row.currency === "USD" &&
          row.revenue_cents !== null &&
          row.cost_cents !== null
        ) {
          expect(row.profit_cents, `project ${row.project_id}`).toBe(
            row.revenue_cents - row.cost_cents,
          );
        }
      }
      expect(body.data.totals.projects_not_converted).toBe(0);
    });

    it("[unit] refuses to subtract across currencies and says how many it left out", async () => {
      harness = await factory();
      // A project billing in EUR. Its revenue is EUR; its cost rate carries no
      // currency at all and is therefore USD, so the two cannot be subtracted.
      await harness.run(
        `INSERT INTO clients (id, name, currency, parent_client_id, created_at, updated_at)
         VALUES (9, 'Continental', 'EUR', NULL, ?, ?)`,
        [now, now],
      );
      await harness.run(
        `INSERT INTO projects
           (id, client_id, name, code, billing_method, bill_by, hourly_rate_cents,
            budget_by, budget_seconds, cost_budget_cents, cost_budget_include_expenses,
            report_visibility, billing_currency, created_at, updated_at)
         VALUES (9, 9, 'Continental build', 'CONT', 'time_materials', 'project', 10000,
            'project', NULL, NULL, 0, 'managers', 'EUR', ?, ?)`,
        [now, now],
      );
      await harness.run(
        `INSERT INTO task_assignments
           (id, project_id, task_id, billable, budget_cents, created_at, updated_at)
         VALUES (19, 9, 1, 1, NULL, ?, ?)`,
        [now, now],
      );
      await harness.run(
        `INSERT INTO user_assignments
           (id, project_id, user_id, is_active, is_project_manager, created_at, updated_at)
         VALUES (29, 9, 1, 1, 0, ?, ?)`,
        [now, now],
      );
      await harness.run(
        `INSERT INTO time_entries
           (id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
            spent_date, seconds, seconds_without_timer, rounded_seconds, billable,
            budgeted, billable_rate_cents, cost_rate_cents, created_at, updated_at)
         VALUES (199, 1, 9, 1, 29, 19, '2026-08-14', 3600, 3600, 3600, 1, 0,
            10000, 4000, ?, ?)`,
        [now, now],
      );

      const response = await harness.request(
        "/reports/profitability?from=2026-08-01&to=2026-08-31",
      );
      const body = (await response.json()) as {
        data: {
          rows: {
            project_id: number;
            currency: string;
            revenue_cents: number | null;
            cost_cents: number | null;
            profit_cents: number | null;
          }[];
          totals: {
            revenue_cents: number | null;
            profit_cents: number | null;
            projects_not_converted: number;
          };
        };
      };
      const continental = body.data.rows.find((row) => row.project_id === 9)!;
      expect(continental.currency).toBe("EUR");
      // Both sides are reported: the figures are real, they just are not in the
      // same unit.
      expect(continental.revenue_cents).toBe(10_000);
      expect(continental.cost_cents).toBe(4_000);
      // And the margin is blank rather than a confident wrong number.
      expect(continental.profit_cents).toBeNull();

      // The headline leaves it out entirely and says so, so a total that covers
      // part of the account cannot be read as the whole firm.
      expect(body.data.totals.projects_not_converted).toBe(1);
      const usdRevenue = body.data.rows
        .filter((row) => row.currency === "USD")
        .reduce((sum, row) => sum + (row.revenue_cents ?? 0), 0);
      expect(body.data.totals.revenue_cents).toBe(usdRevenue);
    });

    it("[unit] blanks the side a missing rate makes incomplete, and counts it", async () => {
      harness = await factory();
      // One unpriced billable hour on project 1, which otherwise prices cleanly.
      await harness.run(
        `INSERT INTO time_entries
           (id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
            spent_date, seconds, seconds_without_timer, rounded_seconds, billable,
            budgeted, billable_rate_cents, cost_rate_cents, created_at, updated_at)
         VALUES (198, 1, 1, 1, 21, 11, '2026-08-15', 3600, 3600, 3600, 1, 0,
            NULL, 4000, ?, ?)`,
        [now, now],
      );

      const response = await harness.request(
        "/reports/profitability?from=2026-08-01&to=2026-08-31",
      );
      const body = (await response.json()) as {
        data: {
          rows: {
            project_id: number;
            revenue_cents: number | null;
            cost_cents: number | null;
            profit_cents: number | null;
            entries_without_billable_rate: number;
          }[];
          totals: {
            revenue_cents: number | null;
            profit_cents: number | null;
            entries_without_billable_rate: number;
          };
        };
      };
      const root = body.data.rows.find((row) => row.project_id === 1)!;
      // Not 10_000 with the unpriced hour quietly dropped, which would read as
      // a healthier margin than the account has.
      expect(root.revenue_cents).toBeNull();
      expect(root.profit_cents).toBeNull();
      // The cost side still priced, so it still reports.
      expect(root.cost_cents).toBe(8_000);
      expect(root.entries_without_billable_rate).toBe(1);
      expect(body.data.totals.revenue_cents).toBeNull();
      expect(body.data.totals.profit_cents).toBeNull();
      expect(body.data.totals.entries_without_billable_rate).toBe(1);
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

/**
 * The money gate, exercised where it can be: `reports:read` is accounting,
 * executive manager and administrator today, and all three may see billable
 * rates, so no request through the route can reach the withheld branch. Testing
 * the serializer directly is the difference between a gate that is known to
 * work and one that merely compiles -- the day `reports:read` widens to a
 * project manager without the billable_rates_manager grant, this is the test
 * that says whether their amounts leak.
 */
describe("time report money redaction", () => {
  const totals = {
    seconds: 3600,
    roundedSeconds: 3600,
    billableSeconds: 3600,
    timeEntryCount: 1,
    unpricedBillableEntryCount: 0,
    amounts: [{ currency: "USD", billableCents: 10_000, uninvoicedCents: 10_000 }],
  } as const;
  const report = {
    from: "2026-08-01",
    to: "2026-08-31",
    totals,
    clients: [{ ...totals, clientId: 1, clientName: "Root" }],
    projects: [
      {
        ...totals,
        projectId: 1,
        projectName: "Root project",
        projectCode: "ROOT",
        clientId: 1,
        clientName: "Root",
      },
    ],
    tasks: [{ ...totals, taskId: 1, taskName: "Delivery" }],
    teammates: [
      {
        ...totals,
        userId: 1,
        userName: "Report Owner",
        isContractor: false,
        capacitySeconds: 558_000,
        utilizationPpm: 6452,
      },
    ],
  } as const;

  const principal = (
    profile: UserProfile,
    managerGrants: readonly string[] = [],
  ): UserPrincipal => ({
    type: "user",
    userId: 1,
    profile,
    managerGrants: [...managerGrants],
    authentication: { kind: "session", sessionId: "redaction-test" },
  });

  const sections = (serialized: ReturnType<typeof serializeTimeReport>) => [
    serialized.totals,
    ...serialized.clients,
    ...serialized.projects,
    ...serialized.tasks,
    ...serialized.teammates,
  ];

  it("[security] withholds amounts from a viewer who may not see billable rates", () => {
    for (const viewer of [
      principal("member"),
      principal("people_admin"),
      principal("project_manager"),
    ]) {
      const serialized = serializeTimeReport(report, viewer);
      // Five sections, asserted before they are searched: an empty list would
      // satisfy the loop below without inspecting a single row.
      expect(sections(serialized)).toHaveLength(5);
      for (const section of sections(serialized)) {
        expect(
          Object.hasOwn(section, "amounts"),
          `${viewer.profile} kept amounts`,
        ).toBe(false);
        // The hours survive: a report of who worked on what is the whole
        // report minus two columns, not a refusal.
        expect(section.rounded_seconds).toBe(3600);
      }
    }
  });

  it("[security] serves amounts to a project manager holding the rates grant", () => {
    for (const viewer of [
      principal("project_manager", ["billable_rates_manager"]),
      principal("accounting"),
      principal("executive_manager"),
      principal("administrator"),
    ]) {
      const serialized = serializeTimeReport(report, viewer);
      expect(sections(serialized)).toHaveLength(5);
      for (const section of sections(serialized)) {
        expect(
          Reflect.get(section, "amounts"),
          `${viewer.profile} lost amounts`,
        ).toEqual([
          { currency: "USD", billable_cents: 10_000, uninvoiced_cents: 10_000 },
        ]);
      }
    }
  });
});
