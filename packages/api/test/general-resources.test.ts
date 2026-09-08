import BetterSqlite3 from "better-sqlite3";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createContainerDatabase,
  createD1Database,
} from "../../db/src/adapters.js";
import { createGeneralResourceRepository } from "../../db/src/general-resources.js";
import { createTeamRepository } from "../../db/src/team.js";
import { migrateContainer, migrateD1 } from "../../db/src/migrate.js";
import { createApiApp, installGeneralResourceRoutes } from "../src/index.js";
import type { ApiAuthentication } from "../src/auth.js";
import type { UserProfile } from "../src/context.js";

interface Harness {
  request(path: string, init?: RequestInit): Promise<Response>;
  run(sql: string, ...params: unknown[]): Promise<void>;
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  close(): Promise<void>;
  setExpensesModuleEnabled(enabled: boolean): void;
}

const signingKey = new Uint8Array(32).fill(0x71);
const now = "2026-08-28T12:00:00.000Z";
const profiles: ReadonlySet<string> = new Set([
  "member",
  "project_manager",
  "people_admin",
  "accounting",
  "executive_manager",
  "administrator",
]);

const bearerPrincipals: Readonly<
  Record<
    string,
    {
      profile: UserProfile;
      managerGrants: string[];
      scopes: string[];
    }
  >
> = {
  "member-projects": {
    profile: "member",
    managerGrants: [],
    scopes: ["projects:read"],
  },
  "member-expenses": {
    profile: "member",
    managerGrants: [],
    scopes: ["expenses:read"],
  },
  "administrator-expenses": {
    profile: "administrator",
    managerGrants: [],
    scopes: ["expenses:read", "expenses:write"],
  },
  "people-team": {
    profile: "people_admin",
    managerGrants: [],
    scopes: ["team:read"],
  },
  "accounting-reports": {
    profile: "accounting",
    managerGrants: [],
    scopes: ["reports:read"],
  },
  "administrator-reports": {
    profile: "administrator",
    managerGrants: [],
    scopes: ["reports:read"],
  },
  "manager-billable": {
    profile: "project_manager",
    managerGrants: ["billable_rates_manager"],
    scopes: ["projects:read"],
  },
  "manager-team": {
    profile: "project_manager",
    managerGrants: ["billable_rates_manager"],
    scopes: ["team:read"],
  },
};

const authentication: ApiAuthentication = {
  tokens: {
    authenticate: async (token) => {
      const principal = bearerPrincipals[token];
      return principal === undefined
        ? null
        : {
            tokenId: 1,
            userId: 1,
            profile: principal.profile,
            managerGrants: [...principal.managerGrants],
            scopes: [...principal.scopes],
          };
    },
    issue: async () => {
      throw new Error("not used by this fixture");
    },
    list: async () => [],
    revoke: async () => null,
  },
  sessions: {
    resolve: async (request) => {
      const requested =
        request.headers.get("x-test-profile") ?? "administrator";
      if (!profiles.has(requested)) return null;
      return {
        type: "user",
        userId: 1,
        profile: requested as UserProfile,
        managerGrants: (request.headers.get("x-test-manager-grants") ?? "")
          .split(",")
          .filter(Boolean),
        authentication: {
          kind: "session",
          sessionId: "general-resource-test",
        },
      };
    },
  },
};

const containerHarness = async (): Promise<Harness> => {
  const sqlite = new BetterSqlite3(":memory:");
  migrateContainer(sqlite);
  sqlite
    .prepare(
      "INSERT INTO organizations (name, modules, created_at, updated_at) VALUES (?, ?, ?, ?)",
    )
    .run("Test org", "{}", now, now);
  const repository = createGeneralResourceRepository(
    createContainerDatabase(sqlite),
  );
  const teamRepository = createTeamRepository(createContainerDatabase(sqlite));
  let expensesModuleEnabled = true;
  const app = createApiApp({
    authentication,
    installApi: (api) =>
      installGeneralResourceRoutes(api, {
        repository,
        cursorSigningKey: signingKey,
        clock: () => now,
        isExpensesModuleEnabled: async () => expensesModuleEnabled,
        teamRepository,
      }),
  });
  return {
    request: (path, init) => {
      const headers = new Headers(init?.headers);
      headers.set("origin", "https://api.test");
      return Promise.resolve(
        app.request(`https://api.test/api/v1${path}`, { ...init, headers }),
      );
    },
    run: async (sql, ...params) => {
      sqlite.prepare(sql).run(...params);
    },
    rows: async <T>(sql: string, ...params: unknown[]) =>
      sqlite.prepare(sql).all(...params) as T[],
    close: async () => {
      sqlite.close();
    },
    setExpensesModuleEnabled: (enabled) => {
      expensesModuleEnabled = enabled;
    },
  };
};

const d1Harness = async (): Promise<Harness> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ["DB"],
  });
  const d1 = await miniflare.getD1Database("DB");
  await migrateD1(d1);
  await d1
    .prepare(
      "INSERT INTO organizations (name, modules, created_at, updated_at) VALUES (?, ?, ?, ?)",
    )
    .bind("Test org", "{}", now, now)
    .run();
  const repository = createGeneralResourceRepository(createD1Database(d1));
  const teamRepository = createTeamRepository(createD1Database(d1));
  let expensesModuleEnabled = true;
  const app = createApiApp({
    authentication,
    installApi: (api) =>
      installGeneralResourceRoutes(api, {
        repository,
        cursorSigningKey: signingKey,
        clock: () => now,
        isExpensesModuleEnabled: async () => expensesModuleEnabled,
        teamRepository,
      }),
  });
  return {
    request: (path, init) => {
      const headers = new Headers(init?.headers);
      headers.set("origin", "https://api.test");
      return Promise.resolve(
        app.request(`https://api.test/api/v1${path}`, { ...init, headers }),
      );
    },
    run: async (sql, ...params) => {
      await d1
        .prepare(sql)
        .bind(...params)
        .run();
    },
    rows: async <T>(sql: string, ...params: unknown[]) =>
      (
        await d1
          .prepare(sql)
          .bind(...params)
          .all<T>()
      ).results,
    close: async () => {
      await miniflare.dispose();
    },
    setExpensesModuleEnabled: (enabled) => {
      expensesModuleEnabled = enabled;
    },
  };
};

const factories = [
  ["SQLite", containerHarness],
  ["D1", d1Harness],
] as const;

const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const rateJson = (body: unknown, idempotencyKey: string): RequestInit => ({
  method: "POST",
  headers: {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
  },
  body: JSON.stringify(body),
});

const asProfile = (
  profile: UserProfile,
  init: RequestInit = {},
  managerGrants: readonly string[] = [],
): RequestInit => {
  const headers = new Headers(init.headers);
  headers.set("x-test-profile", profile);
  if (managerGrants.length > 0)
    headers.set("x-test-manager-grants", managerGrants.join(","));
  return { ...init, headers };
};

const asBearer = (token: string, init: RequestInit = {}): RequestInit => {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  return { ...init, headers };
};

const data = async (response: Response): Promise<Record<string, unknown>> => {
  expect(response.status, await response.clone().text()).toBeLessThan(300);
  return ((await response.json()) as { data: Record<string, unknown> }).data;
};

/**
 * A hundred and twenty tasks with three matches in them, at 10, 60 and 110, so
 * the matches are further apart than any page this test asks for. That spread is
 * the point: a filter applied to the returned page would look at ids 1..3 and
 * answer nothing at all.
 */
const seedSearchableTasks = async (harness: Harness): Promise<void> => {
  await harness.run(
    `WITH RECURSIVE numbers(n) AS (
       SELECT 1 UNION ALL SELECT n + 1 FROM numbers WHERE n < 120
     )
     INSERT INTO tasks (id, name, created_at, updated_at)
     SELECT n,
       CASE WHEN n IN (10, 60, 110) THEN 'Deployment ' || n ELSE 'Filler ' || n END,
       ?, ?
     FROM numbers`,
    now,
    now,
  );
};

type CursorPage = {
  data: { id: number; name: string }[];
  page: { next_cursor: string | null };
};

const page = async (response: Response): Promise<CursorPage> => {
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as CursorPage;
};

for (const [runtime, createHarness] of factories) {
  describe(`${runtime} general-resource API`, () => {
    let harness: Harness;
    beforeEach(async () => {
      harness = await createHarness();
    }, 20_000);
    afterEach(async () => harness.close());

    it("[api] provides CRUD and every combinable general-resource list filter", async () => {
      const parent = await data(
        await harness.request("/clients", json({ name: "Parent" })),
      );
      expect(parent.currency).toBe("USD");
      const parentId = parent.id as number;
      const child = await data(
        await harness.request(
          "/clients",
          json({
            name: "Child",
            currency: "USD",
            parent_client_id: parentId,
            bill_to_client_id: parentId,
          }),
        ),
      );
      const childId = child.id as number;
      await data(
        await harness.request(
          "/clients",
          json({
            name: "Inactive sibling",
            currency: "USD",
            is_active: false,
            parent_client_id: parentId,
          }),
        ),
      );

      const owner = await data(
        await harness.request(
          "/users",
          json({
            first_name: "Owner",
            last_name: "Admin",
            email: "owner@example.test",
            has_access_to_all_future_projects: true,
          }),
        ),
      );
      const user = await data(
        await harness.request(
          "/users",
          json({
            first_name: "Ada",
            last_name: "Lovelace",
            email: "ada@example.test",
            profile: "accounting",
            is_contractor: true,
          }),
        ),
      );
      const userId = user.id as number;
      expect(user).toMatchObject({
        email: "ada@example.test",
        profile: "accounting",
        is_contractor: true,
        is_active: true,
      });
      expect(
        (
          await harness.request(
            "/users",
            json({
              first_name: "Duplicate",
              last_name: "Email",
              email: "ADA@example.test",
            }),
          )
        ).status,
      ).toBe(409);
      await data(
        await harness.request(
          "/users",
          json({
            first_name: "Grace",
            last_name: "Hopper",
            email: "grace@example.test",
            is_active: false,
            profile: "member",
          }),
        ),
      );

      const commonTask = await data(
        await harness.request(
          "/tasks",
          json({
            name: "Common",
            is_default: true,
            billable_by_default: false,
          }),
        ),
      );
      const project = await data(
        await harness.request(
          "/projects",
          json({ client_id: childId, name: "Launch", code: "" }),
        ),
      );
      expect(project.code).toBe("");
      const projectId = project.id as number;
      expect(
        await harness.rows<{ project_id: number; user_id: number }>(
          `SELECT project_id, user_id FROM user_assignments
           WHERE project_id = ? AND user_id = ?`,
          projectId,
          owner.id,
        ),
      ).toEqual([{ project_id: projectId, user_id: owner.id }]);
      const commonAssignmentsResponse = await harness.request(
        `/task-assignments?project_id=${projectId}&task_id=${commonTask.id as number}`,
      );
      expect(commonAssignmentsResponse.status).toBe(200);
      expect(
        (
          (await commonAssignmentsResponse.json()) as {
            data: Array<{ billable: boolean }>;
          }
        ).data,
      ).toEqual([expect.objectContaining({ billable: false })]);
      await data(
        await harness.request(
          `/tasks/${commonTask.id as number}`,
          json({ is_active: false }, "PATCH"),
        ),
      );
      await data(
        await harness.request(
          "/projects",
          json({ client_id: childId, name: "Old", is_active: false }),
        ),
      );

      const task = await data(
        await harness.request("/tasks", json({ name: "Engineering" })),
      );
      const taskId = task.id as number;
      await data(
        await harness.request(
          "/tasks",
          json({ name: "Retired", is_active: false }),
        ),
      );

      const contact = await data(
        await harness.request(
          "/contacts",
          json({ client_id: childId, first_name: "Bill" }),
        ),
      );
      const contactId = contact.id as number;
      const taskAssignment = await data(
        await harness.request(
          "/task-assignments",
          json({ project_id: projectId, task_id: taskId }),
        ),
      );
      const taskAssignmentId = taskAssignment.id as number;
      expect(taskAssignment.billable).toBe(true);
      const userAssignment = await data(
        await harness.request(
          "/user-assignments",
          json({ project_id: projectId, user_id: userId }),
        ),
      );
      const userAssignmentId = userAssignment.id as number;
      const role = await data(
        await harness.request(
          "/roles",
          json({ name: "Finance", user_ids: [userId] }),
        ),
      );
      const roleId = role.id as number;
      expect(role.user_ids).toEqual([userId]);

      const since = encodeURIComponent("2026-08-28T00:00:00.000Z");
      for (const suffix of [
        "is_active=true",
        "is_contractor=true",
        "profile=accounting",
        `updated_since=${since}`,
      ]) {
        const response = await harness.request(`/users?${suffix}`);
        expect(
          ((await response.json()) as { data: Array<{ id: number }> }).data.map(
            ({ id }) => id,
          ),
          suffix,
        ).toContain(userId);
      }
      const queries: readonly [string, number][] = [
        [
          `/clients?is_active=true&parent_client_id=${parentId}&bill_to_client_id=${parentId}&updated_since=${since}`,
          childId,
        ],
        [`/contacts?client_id=${childId}&updated_since=${since}`, contactId],
        [
          `/projects?client_id=${childId}&is_active=true&updated_since=${since}`,
          projectId,
        ],
        [`/tasks?is_active=true&updated_since=${since}`, taskId],
        [
          `/task-assignments?project_id=${projectId}&task_id=${taskId}&is_active=true&updated_since=${since}`,
          taskAssignmentId,
        ],
        [
          `/user-assignments?project_id=${projectId}&user_id=${userId}&is_active=true&updated_since=${since}`,
          userAssignmentId,
        ],
        [
          `/users?is_active=true&is_contractor=true&profile=accounting&updated_since=${since}`,
          userId,
        ],
      ];
      for (const [path, expectedId] of queries) {
        const response = await harness.request(path);
        expect(response.status, path).toBe(200);
        const body = (await response.json()) as { data: Array<{ id: number }> };
        expect(
          body.data.map(({ id }) => id),
          path,
        ).toEqual([expectedId]);
      }

      const updates: readonly [string, unknown, string, unknown][] = [
        [`/clients/${childId}`, { address: "San Jose" }, "address", "San Jose"],
        [
          `/contacts/${contactId}`,
          { title: "Controller" },
          "title",
          "Controller",
        ],
        [`/projects/${projectId}`, { notes: "Ready" }, "notes", "Ready"],
        [`/tasks/${taskId}`, { name: "Build" }, "name", "Build"],
        [
          `/task-assignments/${taskAssignmentId}`,
          { budget_seconds: 3600 },
          "budget_seconds",
          3600,
        ],
        [
          `/user-assignments/${userAssignmentId}`,
          { is_project_manager: true },
          "is_project_manager",
          true,
        ],
        [
          `/users/${userId}`,
          { telephone: "+506", email: "ada.new@example.test" },
          "telephone",
          "+506",
        ],
        [
          `/roles/${roleId}`,
          { name: "Accounting", user_ids: [] },
          "name",
          "Accounting",
        ],
      ];
      for (const [path, body, field, expected] of updates) {
        const updated = await data(
          await harness.request(path, json(body, "PATCH")),
        );
        expect(updated[field], path).toEqual(expected);
      }

      expect(
        (await data(await harness.request(`/users/${userId}`))).email,
      ).toBe("ada.new@example.test");
      expect(
        (await data(await harness.request(`/roles/${roleId}`))).user_ids,
      ).toEqual([]);
      expect(
        (await harness.request(`/contacts/${contactId}`, { method: "DELETE" }))
          .status,
      ).toBe(204);
      expect((await harness.request(`/contacts/${contactId}`)).status).toBe(
        404,
      );
      expect(
        (await harness.request(`/roles/${roleId}`, { method: "DELETE" }))
          .status,
      ).toBe(204);
      expect((await harness.request(`/roles/${roleId}`)).status).toBe(404);
      for (const path of [
        `/task-assignments/${taskAssignmentId}`,
        `/user-assignments/${userAssignmentId}`,
        `/projects/${projectId}`,
        `/tasks/${taskId}`,
        `/users/${userId}`,
        `/clients/${childId}`,
      ]) {
        expect(
          (await harness.request(path, { method: "DELETE" })).status,
          path,
        ).toBe(204);
        expect((await data(await harness.request(path))).is_active, path).toBe(
          false,
        );
      }
    }, 20_000);

    it("[api] administers expense categories from a fresh organization without breaking expense references", async () => {
      const initial = await harness.request(
        "/expense-categories?is_active=true",
        asBearer("member-expenses"),
      );
      expect(initial.status).toBe(200);
      expect(await initial.json()).toMatchObject({ data: [] });

      const direct = await data(
        await harness.request(
          "/expense-categories",
          json({
            name: "Travel",
            unit_name: null,
            unit_price_cents: null,
          }),
        ),
      );
      expect(direct).toMatchObject({
        name: "Travel",
        unit_name: null,
        unit_price_cents: null,
        is_active: true,
      });
      expect(direct).not.toHaveProperty("harvest_id");

      const unitPriced = await data(
        await harness.request(
          "/expense-categories",
          json({
            name: "Mileage",
            unit_name: "mile",
            unit_price_cents: 67,
          }),
        ),
      );
      expect(unitPriced).toMatchObject({
        name: "Mileage",
        unit_name: "mile",
        unit_price_cents: 67,
        is_active: true,
      });

      await harness.run(
        "UPDATE expense_categories SET updated_at = ? WHERE id = ?",
        "2026-08-27T12:00:00.000Z",
        direct.id,
      );
      const updatedSince = await harness.request(
        "/expense-categories?updated_since=2026-08-28T00%3A00%3A00.000Z",
        asBearer("member-expenses"),
      );
      expect(updatedSince.status).toBe(200);
      expect(
        ((await updatedSince.json()) as { data: Array<{ id: number }> }).data,
      ).toEqual([expect.objectContaining({ id: unitPriced.id })]);

      const user = await data(
        await harness.request(
          "/users",
          json({
            first_name: "Fresh",
            last_name: "Owner",
            email: "fresh-owner@example.test",
          }),
        ),
      );
      const client = await data(
        await harness.request("/clients", json({ name: "Fresh client" })),
      );
      const project = await data(
        await harness.request(
          "/projects",
          json({ client_id: client.id, name: "Fresh project" }),
        ),
      );
      await harness.run(
        `INSERT INTO expenses (
          user_id, project_id, expense_category_id, spent_date,
          total_cost_cents, created_at, updated_at
        ) VALUES (?, ?, ?, '2026-08-28', 1250, ?, ?)`,
        user.id,
        project.id,
        direct.id,
        now,
        now,
      );

      const archived = await harness.request(
        `/expense-categories/${direct.id as number}`,
        { method: "DELETE" },
      );
      expect(archived.status).toBe(204);
      expect(
        await data(
          await harness.request(
            `/expense-categories/${direct.id as number}`,
            asBearer("member-expenses"),
          ),
        ),
      ).toMatchObject({ id: direct.id, is_active: false });
      expect(
        await harness.rows<{ expense_category_id: number }>(
          "SELECT expense_category_id FROM expenses",
        ),
      ).toEqual([{ expense_category_id: direct.id }]);
      expect(
        (
          (await (
            await harness.request(
              "/expense-categories?is_active=true",
              asBearer("member-expenses"),
            )
          ).json()) as { data: Array<{ id: number }> }
        ).data,
      ).toEqual([expect.objectContaining({ id: unitPriced.id })]);

      const patched = await data(
        await harness.request(
          `/expense-categories/${unitPriced.id as number}`,
          json({ unit_name: "km", unit_price_cents: 42 }, "PATCH"),
        ),
      );
      expect(patched).toMatchObject({ unit_name: "km", unit_price_cents: 42 });

      const outOfRange = await harness.request(
        "/expense-categories",
        json({ name: "Too expensive", unit_price_cents: 9_000_000_000_001 }),
      );
      expect(outOfRange.status).toBe(422);
      expect(await outOfRange.json()).toMatchObject({
        error: {
          code: "validation_failed",
          fields: [
            {
              field: "unit_price_cents",
              code: "invalid_integer",
            },
          ],
        },
      });
    }, 20_000);

    it("[security] closes every expense-category route when the expenses module is disabled", async () => {
      harness.setExpensesModuleEnabled(false);
      const attempts = [
        harness.request("/expense-categories"),
        harness.request("/expense-categories/1"),
        harness.request("/expense-categories", json({ name: "Denied" })),
        harness.request(
          "/expense-categories/1",
          json({ name: "Denied patch" }, "PATCH"),
        ),
        harness.request("/expense-categories/1", { method: "DELETE" }),
      ];
      for (const response of await Promise.all(attempts)) {
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({
          error: { code: "module_disabled", fields: [] },
        });
      }
      expect((await harness.request("/projects")).status).toBe(200);
    });

    it("[security] limits expense-category mutation to administrator browser sessions", async () => {
      const protectedCategory = await data(
        await harness.request(
          "/expense-categories",
          json({ name: "Administrator owned" }),
        ),
      );
      for (const profile of [
        "member",
        "project_manager",
        "people_admin",
        "accounting",
        "executive_manager",
      ] as const) {
        for (const [path, init] of [
          ["/expense-categories", json({ name: `Denied ${profile}` })],
          [
            `/expense-categories/${protectedCategory.id as number}`,
            json({ name: `Denied ${profile}` }, "PATCH"),
          ],
          [
            `/expense-categories/${protectedCategory.id as number}`,
            { method: "DELETE" },
          ],
        ] as const) {
          const response = await harness.request(
            path,
            asProfile(profile, init),
          );
          expect(response.status, `${profile}:${init.method}`).toBe(403);
          expect(await response.json()).toMatchObject({
            error: { code: "profile_forbidden" },
          });
        }
      }

      const tokenMutation = await harness.request(
        "/expense-categories",
        asBearer("administrator-expenses", json({ name: "Token denied" })),
      );
      expect(tokenMutation.status).toBe(403);
      expect(await tokenMutation.json()).toMatchObject({
        error: { code: "session_required" },
      });
      expect(
        (
          await harness.request(
            "/expense-categories",
            asBearer("member-projects"),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await harness.request(
            "/expense-categories",
            asBearer("member-expenses"),
          )
        ).status,
      ).toBe(200);
    }, 20_000);

    it("[api] persists bounded project, person, and pair note minimums through generic resources", async () => {
      const client = await data(
        await harness.request("/clients", json({ name: "Policy client" })),
      );
      const user = await data(
        await harness.request(
          "/users",
          json({
            first_name: "Policy",
            last_name: "Person",
            email: "policy-person@example.test",
            time_entry_notes_minimum_length: 10_000,
          }),
        ),
      );
      expect(user.time_entry_notes_minimum_length).toBe(10_000);
      const project = await data(
        await harness.request(
          "/projects",
          json({
            client_id: client.id,
            name: "Policy project",
            time_entry_notes_minimum_length: 1,
          }),
        ),
      );
      expect(project.time_entry_notes_minimum_length).toBe(1);
      const pair = await data(
        await harness.request(
          "/user-assignments",
          json({
            project_id: project.id,
            user_id: user.id,
            time_entry_notes_minimum_length: 57,
          }),
        ),
      );
      expect(pair.time_entry_notes_minimum_length).toBe(57);

      const updates = [
        [`/projects/${project.id as number}`, null],
        [`/users/${user.id as number}`, 1],
        [`/user-assignments/${pair.id as number}`, 10_000],
      ] as const;
      for (const [path, minimum] of updates) {
        const updated = await data(
          await harness.request(
            path,
            json({ time_entry_notes_minimum_length: minimum }, "PATCH"),
          ),
        );
        expect(updated.time_entry_notes_minimum_length, path).toBe(minimum);
      }

      for (const path of updates.map(([candidate]) => candidate)) {
        for (const minimum of [0, 10_001, 1.5]) {
          const response = await harness.request(
            path,
            json({ time_entry_notes_minimum_length: minimum }, "PATCH"),
          );
          expect(response.status, `${path}:${minimum}`).toBe(422);
          expect(await response.json()).toMatchObject({
            error: {
              code: "validation_failed",
              fields: [
                {
                  field: "time_entry_notes_minimum_length",
                  code: "invalid_integer",
                },
              ],
            },
          });
        }
      }

      expect(
        await harness.rows<{
          project_minimum: number | null;
          person_minimum: number | null;
          pair_minimum: number | null;
        }>(
          `SELECT project.time_entry_notes_minimum_length AS project_minimum,
            person.time_entry_notes_minimum_length AS person_minimum,
            pair.time_entry_notes_minimum_length AS pair_minimum
          FROM projects AS project
          JOIN user_assignments AS pair ON pair.project_id = project.id
          JOIN users AS person ON person.id = pair.user_id
          WHERE project.id = ? AND person.id = ?`,
          project.id,
          user.id,
        ),
      ).toEqual([
        { project_minimum: null, person_minimum: 1, pair_minimum: 10_000 },
      ]);
    }, 20_000);

    it("[api] exposes rates as append-only POST/read collections", async () => {
      const user = await data(
        await harness.request(
          "/users",
          json({
            first_name: "Rate",
            last_name: "Owner",
            email: "rate@example.test",
          }),
        ),
      );
      const userId = user.id as number;
      const first = await data(
        await harness.request(
          `/users/${userId}/billable-rates`,
          rateJson(
            { expected_version: 0, amount_cents: 12_500, start_date: null },
            "rate-collection-first",
          ),
        ),
      );
      const second = await data(
        await harness.request(
          `/users/${userId}/billable-rates`,
          rateJson(
            { expected_version: 1, amount_cents: 15_000, start_date: "2026-08-28" },
            "rate-collection-second",
          ),
        ),
      );
      const cost = await data(
        await harness.request(
          `/users/${userId}/cost-rates`,
          rateJson(
            { expected_version: 2, amount_cents: 8_000, start_date: null },
            "rate-collection-cost",
          ),
        ),
      );
      expect(second.end_date).toBeNull();
      expect(cost.amount_cents).toBe(8_000);

      const list = await harness.request(`/users/${userId}/billable-rates`);
      expect(list.status).toBe(200);
      expect(
        ((await list.json()) as { data: Array<{ id: number }> }).data.map(
          ({ id }) => id,
        ),
      ).toEqual([first.id, second.id]);
      const reloadedFirst = await data(
        await harness.request(
          `/users/${userId}/billable-rates/${first.id as number}`,
        ),
      );
      expect(reloadedFirst.end_date).toBe("2026-08-27");

      for (const method of ["PATCH", "DELETE"]) {
        const response = await harness.request(
          `/users/${userId}/billable-rates/${second.id as number}`,
          method === "PATCH" ? json({ amount_cents: 1 }, method) : { method },
        );
        expect(response.status).toBe(405);
        expect(response.headers.get("allow")).toBe("GET, POST");
        const collectionResponse = await harness.request(
          `/users/${userId}/billable-rates`,
          method === "PATCH" ? json({ amount_cents: 1 }, method) : { method },
        );
        expect(collectionResponse.status).toBe(405);
      }
      expect(
        (
          await data(
            await harness.request(
              `/users/${userId}/billable-rates/${second.id as number}`,
            ),
          )
        ).amount_cents,
      ).toBe(15_000);
      expect((await harness.request("/users/999/billable-rates")).status).toBe(
        404,
      );
    }, 20_000);

    it("[security] enforces every serialized money field across all six profiles", async () => {
      const client = await data(
        await harness.request("/clients", json({ name: "Matrix client" })),
      );
      const task = await data(
        await harness.request(
          "/tasks",
          json({ name: "Matrix task", default_hourly_rate_cents: 15_000 }),
        ),
      );
      const project = await data(
        await harness.request(
          "/projects",
          json({
            client_id: client.id,
            name: "Matrix project",
            hourly_rate_cents: 20_000,
            fee_cents: 100_000,
            cost_budget_cents: 50_000,
          }),
        ),
      );
      const user = await data(
        await harness.request(
          "/users",
          json({
            first_name: "Matrix",
            last_name: "Owner",
            email: "matrix-owner@example.test",
          }),
        ),
      );
      const taskAssignment = await data(
        await harness.request(
          "/task-assignments",
          json({
            project_id: project.id,
            task_id: task.id,
            hourly_rate_cents: 17_500,
            budget_cents: 75_000,
          }),
        ),
      );
      const userAssignment = await data(
        await harness.request(
          "/user-assignments",
          json({
            project_id: project.id,
            user_id: user.id,
            hourly_rate_cents: 18_000,
          }),
        ),
      );
      await data(
        await harness.request(
          `/users/${user.id as number}/billable-rates`,
          rateJson(
            { expected_version: 1, amount_cents: 16_000, start_date: null },
            "money-matrix-billable",
          ),
        ),
      );
      await data(
        await harness.request(
          `/users/${user.id as number}/cost-rates`,
          rateJson(
            { expected_version: 2, amount_cents: 9_000, start_date: null },
            "money-matrix-cost",
          ),
        ),
      );

      const serializedCases = [
        {
          path: `/projects/${project.id as number}`,
          readableBy: profiles,
          fields: {
            hourly_rate_cents: "project_billable_rate",
            fee_cents: "project_billable_rate",
            cost_budget_cents: "project_cost_budget",
          },
        },
        {
          path: `/tasks/${task.id as number}`,
          readableBy: profiles,
          fields: { default_hourly_rate_cents: "billable_rate" },
        },
        {
          path: `/task-assignments/${taskAssignment.id as number}`,
          readableBy: profiles,
          fields: {
            hourly_rate_cents: "project_billable_rate",
            budget_cents: "project_cost_budget",
          },
        },
        {
          path: `/user-assignments/${userAssignment.id as number}`,
          readableBy: new Set([
            "project_manager",
            "people_admin",
            "executive_manager",
            "administrator",
          ]),
          fields: { hourly_rate_cents: "billable_rate" },
        },
      ] as const;
      const matrix: Readonly<
        Record<
          UserProfile,
          Readonly<{
            billable_rate: boolean;
            money_budget: boolean;
            project_billable_rate: boolean;
            project_cost_budget: boolean;
          }>
        >
      > = {
        member: {
          billable_rate: false,
          money_budget: false,
          project_billable_rate: false,
          project_cost_budget: false,
        },
        project_manager: {
          billable_rate: false,
          money_budget: false,
          project_billable_rate: false,
          project_cost_budget: false,
        },
        people_admin: {
          billable_rate: false,
          money_budget: false,
          project_billable_rate: false,
          project_cost_budget: false,
        },
        accounting: {
          billable_rate: true,
          money_budget: true,
          project_billable_rate: false,
          project_cost_budget: false,
        },
        executive_manager: {
          billable_rate: true,
          money_budget: true,
          project_billable_rate: true,
          project_cost_budget: true,
        },
        administrator: {
          billable_rate: true,
          money_budget: true,
          project_billable_rate: true,
          project_cost_budget: true,
        },
      };
      const allProfiles: readonly UserProfile[] = [
        "member",
        "project_manager",
        "people_admin",
        "accounting",
        "executive_manager",
        "administrator",
      ];

      for (const profile of allProfiles) {
        for (const { path, readableBy, fields } of serializedCases) {
          const response = await harness.request(path, asProfile(profile));
          if (profile === "project_manager" && path.startsWith("/user-assignments/")) {
            expect(response.status, `${profile}:${path}`).toBe(404);
            continue;
          }
          if (!readableBy.has(profile)) {
            expect(response.status, `${profile}:${path}`).toBe(403);
            continue;
          }
          const serialized = await data(response);
          for (const [field, category] of Object.entries(fields)) {
            expect(
              Object.hasOwn(serialized, field),
              `${profile}:${path}:${field}`,
            ).toBe(
              matrix[profile][category as keyof (typeof matrix)[UserProfile]],
            );
          }
        }
        expect(
          (
            await harness.request(
              `/users/${user.id as number}/billable-rates`,
              asProfile(profile),
            )
          ).status,
          `${profile}:billable_rate`,
        ).toBe(matrix[profile].billable_rate ? 200 : 403);
        expect(
          (
            await harness.request(
              `/users/${user.id as number}/cost-rates`,
              asProfile(profile),
            )
          ).status,
          `${profile}:cost_rate`,
        ).toBe(profile === "administrator" ? 200 : 403);
      }

      for (const { path, fields } of serializedCases) {
        if (path.startsWith("/user-assignments/")) {
          expect(
            (
              await harness.request(
                path,
                asProfile("project_manager", {}, ["billable_rates_manager"]),
              )
            ).status,
          ).toBe(404);
          continue;
        }
        const serialized = await data(
          await harness.request(
            path,
            asProfile("project_manager", {}, ["billable_rates_manager"]),
          ),
        );
        for (const [field, category] of Object.entries(fields)) {
          expect(
            Object.hasOwn(serialized, field),
            `granted_project_manager:${path}:${field}`,
          ).toBe(
            category === "billable_rate" ||
              category === "project_billable_rate",
          );
        }
      }
      expect(
        (
          await harness.request(
            `/projects/${project.id as number}`,
            asProfile(
              "project_manager",
              json({ hourly_rate_cents: 1 }, "PATCH"),
            ),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await harness.request(
            `/projects/${project.id as number}`,
            asProfile(
              "project_manager",
              json({ cost_budget_cents: 1 }, "PATCH"),
              ["billable_rates_manager"],
            ),
          )
        ).status,
      ).toBe(403);

      const attemptedOverride = asBearer("member-projects");
      const overrideHeaders = new Headers(attemptedOverride.headers);
      overrideHeaders.set("x-test-profile", "administrator");
      const machineCaller = await data(
        await harness.request(`/projects/${project.id as number}`, {
          ...attemptedOverride,
          headers: overrideHeaders,
        }),
      );
      expect(machineCaller).not.toHaveProperty("hourly_rate_cents");
      expect(machineCaller).not.toHaveProperty("fee_cents");
      expect(machineCaller).not.toHaveProperty("cost_budget_cents");

      const immutableOwner = await harness.request(
        `/users/${user.id as number}`,
        json({ profile: "member" }, "PATCH"),
      );
      expect(immutableOwner.status).toBe(422);
      expect(await immutableOwner.json()).toMatchObject({
        error: { code: "validation_failed" },
      });
      expect(
        await data(await harness.request(`/users/${user.id as number}`)),
      ).toMatchObject({
        profile: "administrator",
        is_owner: true,
      });
    }, 20_000);

    it("[security] enforces scopes, team mutation boundaries, and serializer redaction", async () => {
      const client = await data(
        await harness.request("/clients", json({ name: "Secure client" })),
      );
      const project = await data(
        await harness.request(
          "/projects",
          json({
            client_id: client.id,
            name: "Sensitive project",
            hourly_rate_cents: 20_000,
            fee_cents: 100_000,
            cost_budget_cents: 50_000,
            notes: "administrator-only note",
          }),
        ),
      );
      const projectPath = `/projects/${project.id as number}`;

      const member = await harness.request(projectPath, asProfile("member"));
      expect(member.status).toBe(200);
      expect(
        ((await member.json()) as { data: Record<string, unknown> }).data,
      ).toEqual(
        expect.not.objectContaining({
          hourly_rate_cents: expect.anything(),
          fee_cents: expect.anything(),
          cost_budget_cents: expect.anything(),
          notes: expect.anything(),
        }),
      );
      const memberWrite = await harness.request(
        projectPath,
        asProfile("member", json({ name: "Escalated" }, "PATCH")),
      );
      expect(memberWrite.status).toBe(403);
      expect(await memberWrite.json()).toMatchObject({
        error: { code: "profile_forbidden" },
      });

      const accounting = await harness.request(
        projectPath,
        asProfile("accounting"),
      );
      expect(accounting.status).toBe(200);
      const accountingData = (
        (await accounting.json()) as { data: Record<string, unknown> }
      ).data;
      expect(accountingData).not.toHaveProperty("hourly_rate_cents");
      expect(accountingData).not.toHaveProperty("fee_cents");
      expect(accountingData).not.toHaveProperty("cost_budget_cents");
      expect(
        (
          (await (
            await harness.request(projectPath, asProfile("accounting"))
          ).json()) as { data: Record<string, unknown> }
        ).data,
      ).not.toHaveProperty("notes");

      const manager = await harness.request(
        projectPath,
        asProfile("project_manager", {}, ["billable_rates_manager"]),
      );
      expect(
        ((await manager.json()) as { data: Record<string, unknown> }).data,
      ).toMatchObject({ hourly_rate_cents: 20_000, fee_cents: 100_000 });
      expect(
        (
          (await (
            await harness.request(
              projectPath,
              asProfile("project_manager", {}, ["billable_rates_manager"]),
            )
          ).json()) as { data: Record<string, unknown> }
        ).data,
      ).not.toHaveProperty("cost_budget_cents");

      expect(
        (
          (await (await harness.request(projectPath)).json()) as {
            data: Record<string, unknown>;
          }
        ).data,
      ).toMatchObject({ notes: "administrator-only note" });

      const user = await data(
        await harness.request(
          "/users",
          json({
            first_name: "Rate",
            last_name: "Viewer",
            email: "secure-rate@example.test",
            manager_grants: ["billable_rates_manager"],
            saml_exempt: true,
          }),
        ),
      );
      const userPath = `/users/${user.id as number}`;
      const peopleRead = await harness.request(
        userPath,
        asProfile("people_admin"),
      );
      expect(peopleRead.status).toBe(200);
      const peopleData = (
        (await peopleRead.json()) as {
          data: Record<string, unknown>;
        }
      ).data;
      expect(peopleData).not.toHaveProperty("manager_grants");
      expect(peopleData).not.toHaveProperty("saml_exempt");

      const ordinaryCreate = await harness.request(
        "/users",
        asProfile(
          "people_admin",
          json({
            first_name: "Ordinary",
            last_name: "Member",
            email: "ordinary@example.test",
          }),
        ),
      );
      expect(ordinaryCreate.status, await ordinaryCreate.clone().text()).toBe(
        201,
      );
      const privilegeEscalation = await harness.request(
        "/users",
        asProfile(
          "people_admin",
          json({
            first_name: "Escalated",
            last_name: "Admin",
            email: "escalated@example.test",
            profile: "administrator",
          }),
        ),
      );
      expect(privilegeEscalation.status).toBe(403);
      expect(await privilegeEscalation.json()).toMatchObject({
        error: { code: "profile_forbidden" },
      });
      const tokenTeamWrite = await harness.request(
        "/users",
        asBearer(
          "people-team",
          json({
            first_name: "Token",
            last_name: "Writer",
            email: "token-writer@example.test",
          }),
        ),
      );
      expect(tokenTeamWrite.status).toBe(403);
      expect(await tokenTeamWrite.json()).toMatchObject({
        error: { code: "session_required" },
      });

      const billablePath = `/users/${user.id as number}/billable-rates`;
      const costPath = `/users/${user.id as number}/cost-rates`;
      expect(
        (
          await harness.request(
            billablePath,
            rateJson(
              { expected_version: 0, amount_cents: 12_500, start_date: null },
              "admin-billable-initial",
            ),
          )
        ).status,
      ).toBe(201);
      expect(
        (
          await harness.request(
            costPath,
            rateJson(
              { expected_version: 1, amount_cents: 8_000, start_date: null },
              "admin-cost-initial",
            ),
          )
        ).status,
      ).toBe(201);
      expect(
        (await harness.request(billablePath, asProfile("accounting"))).status,
      ).toBe(200);
      expect(
        (await harness.request(costPath, asProfile("accounting"))).status,
      ).toBe(403);
      expect(
        (
          await harness.request(
            billablePath,
            asProfile(
              "accounting",
              rateJson(
                { expected_version: 2, amount_cents: 13_000, start_date: "2026-08-28" },
                "accounting-rate-denied",
              ),
            ),
          )
        ).status,
      ).toBe(403);
      expect(
        (await harness.request(billablePath, asProfile("project_manager")))
          .status,
      ).toBe(403);
      expect(
        (
          await harness.request(
            billablePath,
            asProfile("project_manager", {}, ["billable_rates_manager"]),
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await harness.request(
            billablePath,
            asProfile(
              "project_manager",
              rateJson(
                { expected_version: 2, amount_cents: 15_000, start_date: "2026-08-28" },
                "manager-billable-change",
              ),
              ["billable_rates_manager"],
            ),
          )
        ).status,
      ).toBe(201);
      expect(
        (await harness.request(billablePath, asBearer("accounting-reports")))
          .status,
      ).toBe(200);
      expect(
        (await harness.request(billablePath, asBearer("manager-billable")))
          .status,
      ).toBe(200);
      expect(
        (await harness.request(costPath, asBearer("administrator-reports")))
          .status,
      ).toBe(200);
      expect(
        (await harness.request("/users", asBearer("member-projects"))).status,
      ).toBe(403);
    }, 20_000);

    it("[security] keeps sign-in address changes with the administrator", async () => {
      const person = await data(
        await harness.request(
          "/users",
          json({
            first_name: "Sign",
            last_name: "In",
            email: "sign-in@example.test",
          }),
        ),
      );
      const path = `/users/${person.id as number}`;
      const takeover = await harness.request(
        path,
        asProfile(
          "people_admin",
          json({ email: "attacker@example.test" }, "PATCH"),
        ),
      );
      expect(takeover.status).toBe(403);
      expect(await takeover.json()).toMatchObject({
        error: { code: "profile_forbidden" },
      });
      expect((await data(await harness.request(path))).email).toBe(
        "sign-in@example.test",
      );
      expect(
        (
          await data(
            await harness.request(
              path,
              asProfile("people_admin", json({ telephone: "+506" }, "PATCH")),
            )
          )
        ).telephone,
      ).toBe("+506");
      expect(
        (
          await data(
            await harness.request(
              path,
              json({ email: "renamed@example.test" }, "PATCH"),
            )
          )
        ).email,
      ).toBe("renamed@example.test");
    }, 20_000);

    it("[api] rolls back every multi-statement relationship mutation on failure", async () => {
      const originalUser = await data(
        await harness.request(
          "/users",
          json({
            first_name: "Atomic",
            last_name: "Original",
            email: "atomic-original@example.test",
          }),
        ),
      );
      const otherUser = await data(
        await harness.request(
          "/users",
          json({
            first_name: "Atomic",
            last_name: "Other",
            email: "atomic-other@example.test",
          }),
        ),
      );
      const role = await data(
        await harness.request(
          "/roles",
          json({ name: "Atomic role", user_ids: [originalUser.id] }),
        ),
      );

      const invalidRoleUpdate = await harness.request(
        `/roles/${role.id as number}`,
        json({ name: "Partially changed", user_ids: [999_999] }, "PATCH"),
      );
      expect(invalidRoleUpdate.status).toBe(422);
      expect(
        await data(await harness.request(`/roles/${role.id as number}`)),
      ).toMatchObject({
        name: "Atomic role",
        user_ids: [originalUser.id],
      });
      expect(otherUser.id).not.toBe(originalUser.id);
    }, 20_000);

    it("[security] scopes PM people, assignments, and legacy rate commands to managed targets", async () => {
      const manager = await data(
        await harness.request(
          "/users",
          json({
            first_name: "Scoped",
            last_name: "Manager",
            email: "scoped-manager@example.test",
            profile: "project_manager",
            manager_grants: ["billable_rates_manager"],
          }),
        ),
      );
      const related = await data(
        await harness.request(
          "/users",
          json({
            first_name: "Managed",
            last_name: "Person",
            email: "managed-person@example.test",
          }),
        ),
      );
      const unrelated = await data(
        await harness.request(
          "/users",
          json({
            first_name: "Unrelated",
            last_name: "Person",
            email: "unrelated-person@example.test",
          }),
        ),
      );
      expect(manager.id).toBe(1);
      const client = await data(
        await harness.request("/clients", json({ name: "Scoped client" })),
      );
      const managedProject = await data(
        await harness.request(
          "/projects",
          json({ client_id: client.id, name: "Managed project" }),
        ),
      );
      const unrelatedProject = await data(
        await harness.request(
          "/projects",
          json({ client_id: client.id, name: "Unrelated project" }),
        ),
      );
      const managerAssignment = await data(
        await harness.request(
          "/user-assignments",
          json({
            project_id: managedProject.id,
            user_id: manager.id,
            is_project_manager: true,
          }),
        ),
      );
      const relatedAssignment = await data(
        await harness.request(
          "/user-assignments",
          json({ project_id: managedProject.id, user_id: related.id }),
        ),
      );
      const unrelatedAssignment = await data(
        await harness.request(
          "/user-assignments",
          json({ project_id: unrelatedProject.id, user_id: unrelated.id }),
        ),
      );
      const role = await data(
        await harness.request(
          "/roles",
          json({ name: "Scoped role", user_ids: [manager.id, related.id, unrelated.id] }),
        ),
      );
      const versionBeforeGenericEdit = (
        await harness.rows<{ version: number }>(
          "SELECT version FROM users WHERE id = ?",
          related.id,
        )
      )[0]!.version;
      await harness.run(
        "UPDATE users SET team_write_token = ? WHERE id = ?",
        "stale-generic-write",
        related.id,
      );
      expect(
        (
          await harness.request(
            `/users/${related.id as number}`,
            json({ telephone: "+1-555-0123" }, "PATCH"),
          )
        ).status,
      ).toBe(200);
      expect(
        await harness.rows<{ team_write_token: string | null; version: number }>(
          "SELECT team_write_token, version FROM users WHERE id = ?",
          related.id,
        ),
      ).toEqual([
        { team_write_token: null, version: versionBeforeGenericEdit + 1 },
      ]);
      const managerSession = (init: RequestInit = {}): RequestInit =>
        asProfile("project_manager", init, ["billable_rates_manager"]);

      const peopleResponse = await harness.request("/users", managerSession());
      expect(peopleResponse.status).toBe(200);
      expect(
        ((await peopleResponse.json()) as { data: Array<{ id: number }> }).data.map(
          ({ id }) => id,
        ),
      ).toEqual([manager.id, related.id]);
      expect(
        (await harness.request(`/users/${unrelated.id as number}`, managerSession())).status,
      ).toBe(404);
      const roleForManager = await data(
        await harness.request(`/roles/${role.id as number}`, managerSession()),
      );
      expect(roleForManager.user_ids).toEqual([manager.id, related.id]);

      const tokenPeopleResponse = await harness.request(
        "/users",
        asBearer("manager-team"),
      );
      expect(tokenPeopleResponse.status).toBe(200);
      expect(
        ((await tokenPeopleResponse.json()) as { data: Array<{ id: number }> }).data.map(
          ({ id }) => id,
        ),
      ).toEqual([manager.id, related.id]);
      expect(
        (
          await harness.request(
            `/users/${unrelated.id as number}`,
            asBearer("manager-team"),
          )
        ).status,
      ).toBe(404);

      const assignmentsResponse = await harness.request(
        "/user-assignments",
        managerSession(),
      );
      expect(assignmentsResponse.status).toBe(200);
      expect(
        ((await assignmentsResponse.json()) as { data: Array<{ id: number }> }).data.map(
          ({ id }) => id,
        ),
      ).toEqual([managerAssignment.id, relatedAssignment.id]);
      const tokenAssignmentsResponse = await harness.request(
        "/user-assignments",
        asBearer("manager-team"),
      );
      expect(tokenAssignmentsResponse.status).toBe(200);
      expect(
        ((await tokenAssignmentsResponse.json()) as { data: Array<{ id: number }> }).data.map(
          ({ id }) => id,
        ),
      ).toEqual([managerAssignment.id, relatedAssignment.id]);
      expect(
        (
          await harness.request(
            `/user-assignments/${unrelatedAssignment.id as number}`,
            managerSession(),
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await harness.request(
            `/user-assignments/${unrelatedAssignment.id as number}`,
            managerSession(json({ is_project_manager: true }, "PATCH")),
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await harness.request(
            `/user-assignments/${relatedAssignment.id as number}`,
            managerSession(json({ is_project_manager: true }, "PATCH")),
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await harness.request(
            `/user-assignments/${relatedAssignment.id as number}`,
            managerSession(
              json(
                {
                  project_id: unrelatedProject.id,
                  is_project_manager: true,
                },
                "PATCH",
              ),
            ),
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await harness.request(
            "/user-assignments",
            managerSession(
              json({ project_id: managedProject.id, user_id: unrelated.id }),
            ),
          )
        ).status,
      ).toBe(404);

      await harness.run(
        `INSERT INTO teammate_assignments (manager_id, user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
        manager.id,
        unrelated.id,
        now,
        now,
      );
      expect(
        (
          await harness.request(
            "/user-assignments",
            managerSession(
              json({ project_id: unrelatedProject.id, user_id: unrelated.id }),
            ),
          )
        ).status,
      ).toBe(404);

      const relatedVersion = (
        await harness.rows<{ version: number }>(
          "SELECT version FROM users WHERE id = ?",
          related.id,
        )
      )[0]!.version;
      const ratePath = `/users/${related.id as number}/billable-rates`;
      const commandBody = {
        expected_version: relatedVersion,
        amount_cents: 12_345,
        start_date: null,
      };
      const first = await harness.request(
        ratePath,
        managerSession(rateJson(commandBody, "legacy-rate-stable")),
      );
      expect(first.status, await first.clone().text()).toBe(201);
      const firstPayload = await first.json();
      expect(firstPayload).toMatchObject({ data: { amount_cents: 12_345 } });
      const replay = await harness.request(
        ratePath,
        managerSession(rateJson(commandBody, "legacy-rate-stable")),
      );
      expect(replay.status).toBe(201);
      expect(await replay.json()).toEqual(firstPayload);
      expect(
        await harness.rows<{ total: number }>(
          "SELECT count(*) AS total FROM user_billable_rates WHERE user_id = ?",
          related.id,
        ),
      ).toEqual([{ total: 1 }]);
      expect(
        (
          await harness.request(
            ratePath,
            managerSession(rateJson(commandBody, "legacy-rate-stale")),
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await harness.request(
            ratePath,
            managerSession(
              rateJson({ ...commandBody, amount_cents: 12_346 }, "legacy-rate-stable"),
            ),
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await harness.request(
            ratePath,
            managerSession(json({ ...commandBody, expected_version: relatedVersion + 1 })),
          )
        ).status,
      ).toBe(422);
      expect(
        (
          await harness.request(
            `/users/${unrelated.id as number}/billable-rates`,
            managerSession(),
          )
        ).status,
      ).toBe(200);
      await harness.run(
        "DELETE FROM teammate_assignments WHERE manager_id = ? AND user_id = ?",
        manager.id,
        unrelated.id,
      );
      expect(
        (
          await harness.request(
            `/users/${unrelated.id as number}/billable-rates`,
            managerSession(),
          )
        ).status,
      ).toBe(404);
    }, 30_000);

    it("[api] rolls back multi-statement user and project mutation on failure", async () => {
      const originalUser = await data(
        await harness.request(
          "/users",
          json({
            first_name: "Atomic",
            last_name: "Original",
            email: "atomic-original@example.test",
          }),
        ),
      );
      const otherUser = await data(
        await harness.request(
          "/users",
          json({
            first_name: "Atomic",
            last_name: "Other",
            email: "atomic-other@example.test",
          }),
        ),
      );
      const conflictingEmailUpdate = await harness.request(
        `/users/${originalUser.id as number}`,
        json(
          { telephone: "+506-partial", email: "atomic-other@example.test" },
          "PATCH",
        ),
      );
      expect(conflictingEmailUpdate.status).toBe(409);
      expect(
        await data(
          await harness.request(`/users/${originalUser.id as number}`),
        ),
      ).toMatchObject({
        email: "atomic-original@example.test",
        telephone: null,
      });

      await harness.run(`CREATE TRIGGER force_user_email_failure
        BEFORE INSERT ON user_emails
        WHEN NEW.address = 'atomic-failure@example.test'
        BEGIN SELECT RAISE(ABORT, 'forced general atomicity failure'); END`);
      const failedUserCreate = await harness.request(
        "/users",
        json({
          first_name: "Must",
          last_name: "Rollback",
          email: "atomic-failure@example.test",
        }),
      );
      expect(failedUserCreate.status).toBeGreaterThanOrEqual(400);
      expect(
        await harness.rows<{ total: number }>(
          "SELECT count(*) AS total FROM users WHERE first_name = ? AND last_name = ?",
          "Must",
          "Rollback",
        ),
      ).toEqual([{ total: 0 }]);

      const client = await data(
        await harness.request("/clients", json({ name: "Atomic client" })),
      );
      await data(
        await harness.request(
          "/tasks",
          json({ name: "Atomic default", is_default: true }),
        ),
      );
      await harness.run(`CREATE TRIGGER force_default_assignment_failure
        BEFORE INSERT ON task_assignments
        BEGIN SELECT RAISE(ABORT, 'forced general atomicity failure'); END`);
      const failedProjectCreate = await harness.request(
        "/projects",
        json({ client_id: client.id, name: "Must rollback project" }),
      );
      expect(failedProjectCreate.status).toBeGreaterThanOrEqual(400);
      expect(
        await harness.rows<{ total: number }>(
          "SELECT count(*) AS total FROM projects WHERE name = ?",
          "Must rollback project",
        ),
      ).toEqual([{ total: 0 }]);
      expect(otherUser.id).not.toBe(originalUser.id);
    }, 20_000);

    // The cursor chassis asks for per_page + 1 rows and reads "more than I
    // asked for" as "there is a next page". A search applied after that read
    // returns short pages that claim to be the end of the collection, so the
    // predicate has to be in the SQL -- which is what walking the cursor here
    // proves and a page-local filter cannot fake.
    it("[api] pages the searched set, not the searched page", async () => {
      await seedSearchableTasks(harness);

      const first = await page(await harness.request("/tasks?q=deploy&per_page=2"));
      // A full page of matches out of a collection where they are 2.5% of the
      // rows, and a cursor, because a third match is still out there.
      expect(first.data.map((task) => task.id)).toEqual([10, 60]);
      expect(first.page.next_cursor).not.toBeNull();

      const second = await page(
        await harness.request(
          `/tasks?q=deploy&per_page=2&cursor=${encodeURIComponent(first.page.next_cursor!)}`,
        ),
      );
      expect(second.data.map((task) => task.id)).toEqual([110]);
      expect(second.page.next_cursor).toBeNull();
    }, 20_000);

    it("[api] searches clients and projects by name, and refuses a search that is not one", async () => {
      const client = await data(
        await harness.request("/clients", json({ name: "Northwind Traders" })),
      );
      await data(await harness.request("/clients", json({ name: "Contoso" })));
      const clientId = client.id as number;
      await data(
        await harness.request(
          "/projects",
          json({ client_id: clientId, name: "Website rebuild" }),
        ),
      );
      await data(
        await harness.request(
          "/projects",
          json({ client_id: clientId, name: "Payroll migration" }),
        ),
      );

      // Lower case against a capitalised name, because the box on screen is not
      // going to be typed in the same case the record was created in.
      const clients = await page(await harness.request("/clients?q=northwind"));
      expect(clients.data.map((row) => row.name)).toEqual(["Northwind Traders"]);
      const projects = await page(await harness.request("/projects?q=rebuild"));
      expect(projects.data.map((row) => row.name)).toEqual(["Website rebuild"]);
      // Combines with the filters that were already there rather than replacing
      // them, because the toolbar keeps its Active/All control either way.
      const inactive = await page(
        await harness.request("/projects?q=rebuild&is_active=false"),
      );
      expect(inactive.data).toEqual([]);

      // A literal % is a search for a percent sign, not a search for everything.
      const wildcard = await page(await harness.request("/clients?q=%25"));
      expect(wildcard.data).toEqual([]);
      const blank = await harness.request("/clients?q=%20");
      expect(blank.status).toBe(422);
    }, 20_000);

    it("[api] rejects unknown/non-combinable query inputs and translates DB constraints", async () => {
      const invalidFilter = await harness.request(
        "/clients?is_active=true&unsupported=x",
      );
      expect(invalidFilter.status).toBe(422);
      const invalidReference = await harness.request(
        "/contacts",
        json({ client_id: 999, first_name: "Nobody" }),
      );
      expect(
        invalidReference.status,
        await invalidReference.clone().text(),
      ).toBe(422);
      expect(
        (
          (await invalidReference.json()) as {
            error: { fields: Array<{ code: string }> };
          }
        ).error.fields[0]?.code,
      ).toBe("invalid_reference");

      const first = await data(
        await harness.request(
          "/clients",
          json({ name: "Tree A", currency: "USD" }),
        ),
      );
      const second = await data(
        await harness.request(
          "/clients",
          json({ name: "Tree B", currency: "USD", parent_client_id: first.id }),
        ),
      );
      const cycle = await harness.request(
        `/clients/${first.id as number}`,
        json({ parent_client_id: second.id }, "PATCH"),
      );
      expect(cycle.status).toBe(422);
    }, 20_000);
  });
}
