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
  listClientAncestors,
  listClientDescendants,
} from "../../db/src/operations.js";
import {
  createApiApp,
  installClientTreeRoutes,
  installGeneralResourceRoutes,
  installReportRoutes,
  type ApiAuthentication,
  type UserProfile,
} from "../src/index.js";
import { createGeneralResourceRepository } from "../../db/src/general-resources.js";
import { createTeamRepository } from "../../db/src/team.js";

interface Harness {
  request(
    path: string,
    init?: RequestInit,
    profile?: UserProfile,
  ): Promise<Response>;
  close(): Promise<void>;
}

const signingKey = new Uint8Array(32).fill(0x71);
const now = "2026-09-01T12:00:00.000Z";
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
        userId: 1,
        profile,
        managerGrants: [],
        authentication: { kind: "session", sessionId: "tree-test" },
      };
    },
  },
};

// 3-level tree:
//   Root (USD, budget_cents=500000)
//     Child (EUR)
//       Leaf (USD)
const seedStatements = [
  {
    sql: `INSERT INTO organizations
      (name, currency, modules, created_at, updated_at) VALUES (?, 'USD', '{}', ?, ?)`,
    params: ["Tree org", now, now],
  },
  {
    sql: `INSERT INTO users
      (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (1, 'Tree', 'Tester', 'administrator', '[]', ?, ?)`,
    params: [now, now],
  },
  {
    sql: `INSERT INTO clients
      (id, name, currency, parent_client_id, budget_cents, created_at, updated_at) VALUES
      (1, 'Root', 'USD', NULL, 500000, ?, ?),
      (2, 'Child', 'EUR', 1, NULL, ?, ?),
      (3, 'Leaf', 'USD', 2, NULL, ?, ?)`,
    params: [now, now, now, now, now, now],
  },
  {
    sql: `INSERT INTO projects
      (id, client_id, name, code, billing_method, bill_by, hourly_rate_cents,
       budget_by, budget_seconds, cost_budget_cents, cost_budget_include_expenses,
       created_at, updated_at) VALUES
      (1, 1, 'Root proj', 'RP', 'time_materials', 'project', 10000,
       'project', 72000, NULL, 0, ?, ?),
      (2, 2, 'Child proj', 'CP', 'time_materials', 'project', 15000,
       'project', 36000, NULL, 0, ?, ?),
      (3, 3, 'Leaf proj', 'LP', 'time_materials', 'project', 8000,
       'project', 36000, NULL, 0, ?, ?)`,
    params: [now, now, now, now, now, now],
  },
  {
    sql: `INSERT INTO tasks
      (id, name, created_at, updated_at) VALUES (1, 'Dev', ?, ?)`,
    params: [now, now],
  },
  {
    sql: `INSERT INTO task_assignments
      (id, project_id, task_id, billable, created_at, updated_at) VALUES
      (11, 1, 1, 1, ?, ?),
      (12, 2, 1, 1, ?, ?),
      (13, 3, 1, 1, ?, ?)`,
    params: [now, now, now, now, now, now],
  },
  {
    sql: `INSERT INTO user_assignments
      (id, project_id, user_id, created_at, updated_at) VALUES
      (21, 1, 1, ?, ?), (22, 2, 1, ?, ?), (23, 3, 1, ?, ?)`,
    params: [now, now, now, now, now, now],
  },
  // Root proj: 3600s @ $100/h billable, $40/h cost (USD)
  // Child proj: 1800s @ EUR 150/h billable, EUR 60/h cost (EUR)
  // Leaf proj: 900s @ $80/h billable, $50/h cost (USD)
  {
    sql: `INSERT INTO time_entries
      (id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
       spent_date, seconds, seconds_without_timer, rounded_seconds, billable, budgeted,
       billable_rate_cents, cost_rate_cents, created_at, updated_at) VALUES
      (101, 1, 1, 1, 21, 11, '2026-09-01', 3600, 3600, 3600, 1, 1, 10000, 4000, ?, ?),
      (102, 1, 2, 1, 22, 12, '2026-09-01', 1800, 1800, 1800, 1, 1, 15000, 6000, ?, ?),
      (103, 1, 3, 1, 23, 13, '2026-09-01', 900, 900, 900, 1, 1, 8000, 5000, ?, ?)`,
    params: [now, now, now, now, now, now],
  },
  {
    sql: `INSERT INTO expense_categories
      (id, name, created_at, updated_at) VALUES (1, 'Travel', ?, ?)`,
    params: [now, now],
  },
  // Expense on Root proj (USD), Child proj (EUR), Leaf proj (USD)
  {
    sql: `INSERT INTO expenses
      (id, user_id, project_id, expense_category_id, spent_date, total_cost_cents,
       billable, created_at, updated_at) VALUES
      (201, 1, 1, 1, '2026-09-01', 2500, 1, ?, ?),
      (202, 1, 2, 1, '2026-09-01', 3000, 1, ?, ?),
      (203, 1, 3, 1, '2026-09-01', 1500, 1, ?, ?)`,
    params: [now, now, now, now, now, now],
  },
] as const;

type DbAdapter =
  | ReturnType<typeof createContainerDatabase>
  | ReturnType<typeof createD1Database>;

const createHarness = async (kind: "SQLite" | "D1"): Promise<Harness> => {
  let close: () => Promise<void>;
  let run: (sql: string, params: readonly unknown[]) => Promise<void>;
  let reports: ReturnType<typeof createReportRepository>;
  let db: DbAdapter;
  let resources: ReturnType<typeof createGeneralResourceRepository>;
  let team: ReturnType<typeof createTeamRepository>;
  if (kind === "SQLite") {
    const sqlite = new BetterSqlite3(":memory:");
    migrateContainer(sqlite);
    db = createContainerDatabase(sqlite);
    reports = createReportRepository(db);
    resources = createGeneralResourceRepository(db);
    team = createTeamRepository(db);
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
    db = createD1Database(d1);
    reports = createReportRepository(db);
    resources = createGeneralResourceRepository(db);
    team = createTeamRepository(db);
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
    installApi: (api) => {
      installReportRoutes(api, reports);
      installClientTreeRoutes(api, {
        ancestors: (clientId) => listClientAncestors(db, clientId),
        descendants: (clientId) => listClientDescendants(db, clientId),
      });
      installGeneralResourceRoutes(api, {
        repository: resources,
        cursorSigningKey: signingKey,
        isExpensesModuleEnabled: async () => true,
        teamRepository: team,
      });
    },
  });
  return {
    request: (path, init?, profile = "administrator") =>
      Promise.resolve(
        app.request(`https://api.test/api/v1${path}`, {
          ...init,
          headers: {
            origin: "https://api.test",
            "x-test-profile": profile,
            ...(init?.headers ?? {}),
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
  describe(`client tree API (${runtime})`, () => {
    let harness: Harness | undefined;
    afterEach(async () => harness?.close());

    it("[api] rollups correct on 3-level fixture with mixed currencies", async () => {
      harness = await factory();
      const response = await harness.request(
        "/reports/client-rollups/1?from=2026-09-01&to=2026-09-30",
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as {
        data: {
          nodes: Array<{
            client_id: number;
            name: string;
            depth: number;
            node_budget_cents: number | null;
            budget_burn_cents: number;
            direct: {
              rounded_seconds: number;
              currencies: Array<{
                currency: string;
                expense_cents: number;
                cost_cents: number;
                uninvoiced_total_cents: number;
              }>;
            };
            rollup: {
              rounded_seconds: number;
              currencies: Array<{
                currency: string;
                expense_cents: number;
                cost_cents: number;
                uninvoiced_total_cents: number;
              }>;
            };
          }>;
        };
      };

      const nodes = body.data.nodes;
      expect(nodes).toHaveLength(3);

      // Verify tree shape
      expect(nodes.map((n) => ({ id: n.client_id, depth: n.depth }))).toEqual([
        { id: 1, depth: 0 },
        { id: 2, depth: 1 },
        { id: 3, depth: 2 },
      ]);

      // Root direct: 3600s from time entry 101
      expect(nodes[0]!.direct.rounded_seconds).toBe(3600);
      // Root rollup: 3600 + 1800 + 900 = 6300 (BUT only USD seconds - actually all seconds regardless of currency)
      expect(nodes[0]!.rollup.rounded_seconds).toBe(6300);

      // Mixed currencies: Root rollup should contain both USD and EUR
      const rootRollupCurrencies = nodes[0]!.rollup.currencies;
      const rootUsd = rootRollupCurrencies.find((c) => c.currency === "USD");
      const rootEur = rootRollupCurrencies.find((c) => c.currency === "EUR");
      expect(rootUsd).toBeDefined();
      expect(rootEur).toBeDefined();

      // USD rollup: cost_rate uses org currency (USD) for all projects regardless of billing currency
      // Root proj cost = 4000*3600/3600=4000, Child proj cost = 6000*1800/3600=3000 (org currency),
      // Leaf proj cost = 5000*900/3600=1250 => USD cost_cents = 4000+3000+1250 = 8250
      // Expenses use billing currency: Root 2500 (USD) + Leaf 1500 (USD) = 4000
      expect(rootUsd!.expense_cents).toBe(4000); // 2500 + 1500
      expect(rootUsd!.cost_cents).toBe(8250); // 4000 + 3000 + 1250

      // EUR rollup: only expenses (cost goes to org currency USD)
      // Child expense 3000 (EUR), cost_cents = 0 (cost tracked in org currency)
      expect(rootEur!.expense_cents).toBe(3000);
      expect(rootEur!.cost_cents).toBe(0);

      // Child rollup should include Child direct + Leaf rolled up
      const childRollupCurrencies = nodes[1]!.rollup.currencies;
      const childUsd = childRollupCurrencies.find((c) => c.currency === "USD");
      const childEur = childRollupCurrencies.find((c) => c.currency === "EUR");
      expect(childEur).toBeDefined();
      expect(childUsd).toBeDefined();

      // Child direct has EUR (expenses, uninvoiced) and USD (cost tracked in org currency)
      expect(nodes[1]!.direct.currencies).toHaveLength(2);
      expect(nodes[1]!.direct.currencies[0]!.currency).toBe("EUR");
      expect(nodes[1]!.direct.currencies[1]!.currency).toBe("USD");

      // Child rollup has EUR from Child + USD from Leaf
      expect(childUsd!.expense_cents).toBe(1500);
      expect(childEur!.expense_cents).toBe(3000);
    }, 30_000);

    it("[api] cycle rejected 422; re-parent recomputes derived sets", async () => {
      harness = await factory();

      // The tree: Root(1) -> Child(2) -> Leaf(3)
      // Try to set Root.parent_client_id = Leaf(3) -- creates cycle
      const cycleResponse = await harness.request("/clients/1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parent_client_id: 3 }),
      });
      expect(cycleResponse.status).toBe(422);

      // Also reject self-referencing parent
      const selfCycleResponse = await harness.request("/clients/1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parent_client_id: 1 }),
      });
      expect(selfCycleResponse.status).toBe(422);

      // Verify ancestors before re-parent
      const ancestorsBefore = await harness.request(
        "/clients/3/ancestors",
      );
      expect(ancestorsBefore.status).toBe(200);
      const ancestorsBody = (await ancestorsBefore.json()) as {
        data: Array<{
          ancestor_id: number;
          descendant_id: number;
          depth: number;
        }>;
      };
      // Leaf(3) ancestors: self at depth 0, Child(2) at depth 1, Root(1) at depth 2
      expect(ancestorsBody.data).toEqual([
        { ancestor_id: 3, descendant_id: 3, depth: 0 },
        { ancestor_id: 2, descendant_id: 3, depth: 1 },
        { ancestor_id: 1, descendant_id: 3, depth: 2 },
      ]);

      // Re-parent: move Leaf(3) from Child(2) to Root(1)
      const reparent = await harness.request("/clients/3", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parent_client_id: 1 }),
      });
      expect(reparent.status).toBe(200);

      // After re-parent, Leaf(3) ancestors should be: self, Root(1)
      const ancestorsAfter = await harness.request(
        "/clients/3/ancestors",
      );
      expect(ancestorsAfter.status).toBe(200);
      const ancestorsAfterBody = (await ancestorsAfter.json()) as {
        data: Array<{
          ancestor_id: number;
          descendant_id: number;
          depth: number;
        }>;
      };
      expect(ancestorsAfterBody.data).toEqual([
        { ancestor_id: 3, descendant_id: 3, depth: 0 },
        { ancestor_id: 1, descendant_id: 3, depth: 1 },
      ]);

      // Root(1) descendants should now be: self, Child(2), Leaf(3) -- both at depth 1
      const descendantsAfter = await harness.request(
        "/clients/1/descendants",
      );
      expect(descendantsAfter.status).toBe(200);
      const descendantsAfterBody = (await descendantsAfter.json()) as {
        data: Array<{
          ancestor_id: number;
          descendant_id: number;
          depth: number;
        }>;
      };
      expect(descendantsAfterBody.data).toEqual(
        expect.arrayContaining([
          { ancestor_id: 1, descendant_id: 1, depth: 0 },
          { ancestor_id: 1, descendant_id: 2, depth: 1 },
          { ancestor_id: 1, descendant_id: 3, depth: 1 },
        ]),
      );
    }, 30_000);

    it("[unit] node budget burn = sum of descendant project consumption (F11)", async () => {
      harness = await factory();
      const response = await harness.request(
        "/reports/client-rollups/1?from=2026-09-01&to=2026-09-30",
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as {
        data: {
          nodes: Array<{
            client_id: number;
            node_budget_cents: number | null;
            budget_burn_cents: number;
            rollup: {
              currencies: Array<{
                currency: string;
                cost_cents: number;
                expense_cents: number;
              }>;
            };
          }>;
        };
      };

      const root = body.data.nodes.find((n) => n.client_id === 1)!;
      const child = body.data.nodes.find((n) => n.client_id === 2)!;
      const leaf = body.data.nodes.find((n) => n.client_id === 3)!;

      // Root has budget_cents = 500000
      expect(root.node_budget_cents).toBe(500000);
      // Child and Leaf have no budget
      expect(child.node_budget_cents).toBeNull();
      expect(leaf.node_budget_cents).toBeNull();

      // budget_burn = sum of (cost_cents + expense_cents) across ALL currencies in rollup
      // Root rollup currencies (cost uses org currency USD for all projects):
      //   USD: cost_cents = 4000+3000+1250 = 8250, expense_cents = 2500+1500 = 4000
      //   EUR: cost_cents = 0, expense_cents = 3000
      // Root burn = (8250 + 4000) + (0 + 3000) = 15250
      const expectedRootBurn = root.rollup.currencies.reduce(
        (sum, c) => sum + c.cost_cents + c.expense_cents,
        0,
      );
      expect(root.budget_burn_cents).toBe(expectedRootBurn);
      expect(root.budget_burn_cents).toBeGreaterThan(0);

      // Child rollup (cost uses org currency USD):
      //   EUR: cost=0, expense=3000
      //   USD: cost=3000+1250=4250, expense=1500
      // Child burn = (0+3000) + (4250+1500) = 8750
      const expectedChildBurn = child.rollup.currencies.reduce(
        (sum, c) => sum + c.cost_cents + c.expense_cents,
        0,
      );
      expect(child.budget_burn_cents).toBe(expectedChildBurn);

      // Leaf rollup:
      //   USD: cost=1250, expense=1500
      // Leaf burn = 1250 + 1500 = 2750
      const expectedLeafBurn = leaf.rollup.currencies.reduce(
        (sum, c) => sum + c.cost_cents + c.expense_cents,
        0,
      );
      expect(leaf.budget_burn_cents).toBe(expectedLeafBurn);

      // Verify the budget burn hierarchy is consistent:
      // Root burn should be >= Child burn (root includes everything child does plus root's own)
      expect(root.budget_burn_cents).toBeGreaterThanOrEqual(
        child.budget_burn_cents,
      );
      expect(child.budget_burn_cents).toBeGreaterThanOrEqual(
        leaf.budget_burn_cents,
      );
    }, 30_000);

    it("[api] returns 404 for nonexistent client ancestors/descendants", async () => {
      harness = await factory();
      const ancestors = await harness.request("/clients/999/ancestors");
      expect(ancestors.status).toBe(404);
      const descendants = await harness.request("/clients/999/descendants");
      expect(descendants.status).toBe(404);
    }, 15_000);

    it("[api] returns correct ancestors and descendants for each node", async () => {
      harness = await factory();

      // Root(1) descendants: self, Child(2), Leaf(3)
      const rootDesc = await harness.request("/clients/1/descendants");
      expect(rootDesc.status).toBe(200);
      const rootDescBody = (await rootDesc.json()) as {
        data: Array<{
          ancestor_id: number;
          descendant_id: number;
          depth: number;
        }>;
      };
      expect(rootDescBody.data).toEqual([
        { ancestor_id: 1, descendant_id: 1, depth: 0 },
        { ancestor_id: 1, descendant_id: 2, depth: 1 },
        { ancestor_id: 1, descendant_id: 3, depth: 2 },
      ]);

      // Leaf(3) ancestors: self, Child(2), Root(1)
      const leafAnc = await harness.request("/clients/3/ancestors");
      expect(leafAnc.status).toBe(200);
      const leafAncBody = (await leafAnc.json()) as {
        data: Array<{
          ancestor_id: number;
          descendant_id: number;
          depth: number;
        }>;
      };
      expect(leafAncBody.data).toEqual([
        { ancestor_id: 3, descendant_id: 3, depth: 0 },
        { ancestor_id: 2, descendant_id: 3, depth: 1 },
        { ancestor_id: 1, descendant_id: 3, depth: 2 },
      ]);

      // Root(1) has no ancestors beyond itself
      const rootAnc = await harness.request("/clients/1/ancestors");
      expect(rootAnc.status).toBe(200);
      const rootAncBody = (await rootAnc.json()) as {
        data: Array<{
          ancestor_id: number;
          descendant_id: number;
          depth: number;
        }>;
      };
      expect(rootAncBody.data).toEqual([
        { ancestor_id: 1, descendant_id: 1, depth: 0 },
      ]);
    }, 15_000);
  });
}
