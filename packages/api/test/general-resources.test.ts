import BetterSqlite3 from "better-sqlite3";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createContainerDatabase,
  createD1Database,
} from "../../db/src/adapters.js";
import { createGeneralResourceRepository } from "../../db/src/general-resources.js";
import { migrateContainer, migrateD1 } from "../../db/src/migrate.js";
import { createApiApp, installGeneralResourceRoutes } from "../src/index.js";
import type { ApiAuthentication } from "../src/auth.js";
import type { UserProfile } from "../src/context.js";

interface Harness {
  request(path: string, init?: RequestInit): Promise<Response>;
  run(sql: string, ...params: unknown[]): Promise<void>;
  rows<T>(sql: string, ...params: unknown[]): Promise<T[]>;
  close(): Promise<void>;
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
  const app = createApiApp({
    authentication,
    installApi: (api) =>
      installGeneralResourceRoutes(api, {
        repository,
        cursorSigningKey: signingKey,
        clock: () => now,
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
  const app = createApiApp({
    authentication,
    installApi: (api) =>
      installGeneralResourceRoutes(api, {
        repository,
        cursorSigningKey: signingKey,
        clock: () => now,
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

      await data(
        await harness.request(
          "/users",
          json({
            first_name: "Owner",
            last_name: "Admin",
            email: "owner@example.test",
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
          json({ client_id: childId, name: "Launch" }),
        ),
      );
      const projectId = project.id as number;
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
          json({ amount_cents: 12_500, start_date: null }),
        ),
      );
      const second = await data(
        await harness.request(
          `/users/${userId}/billable-rates`,
          json({ amount_cents: 15_000, start_date: "2026-08-28" }),
        ),
      );
      const cost = await data(
        await harness.request(
          `/users/${userId}/cost-rates`,
          json({ amount_cents: 8_000, start_date: null }),
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
          json({ amount_cents: 16_000, start_date: null }),
        ),
      );
      await data(
        await harness.request(
          `/users/${user.id as number}/cost-rates`,
          json({ amount_cents: 9_000, start_date: null }),
        ),
      );

      const serializedCases = [
        {
          path: `/projects/${project.id as number}`,
          readableBy: profiles,
          fields: {
            hourly_rate_cents: "billable_rate",
            fee_cents: "billable_rate",
            cost_budget_cents: "money_budget",
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
            hourly_rate_cents: "billable_rate",
            budget_cents: "money_budget",
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
          Readonly<{ billable_rate: boolean; money_budget: boolean }>
        >
      > = {
        member: { billable_rate: false, money_budget: false },
        project_manager: { billable_rate: false, money_budget: false },
        people_admin: { billable_rate: false, money_budget: false },
        accounting: { billable_rate: true, money_budget: true },
        executive_manager: { billable_rate: true, money_budget: true },
        administrator: { billable_rate: true, money_budget: true },
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
          ).toBe(category === "billable_rate");
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
      expect(
        ((await accounting.json()) as { data: Record<string, unknown> }).data,
      ).toMatchObject({
        hourly_rate_cents: 20_000,
        fee_cents: 100_000,
        cost_budget_cents: 50_000,
      });
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
            json({ amount_cents: 12_500, start_date: null }),
          )
        ).status,
      ).toBe(201);
      expect(
        (
          await harness.request(
            costPath,
            json({ amount_cents: 8_000, start_date: null }),
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
              json({ amount_cents: 13_000, start_date: "2026-08-28" }),
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
              json({ amount_cents: 15_000, start_date: "2026-08-28" }),
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
