import BetterSqlite3 from "better-sqlite3";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import {
  createContainerDatabase,
  createD1Database,
} from "../../db/src/adapters.js";
import { migrateContainer, migrateD1 } from "../../db/src/migrate.js";
import { createTeamRepository } from "../../db/src/team.js";
import {
  createApiApp,
  installTeamRoutes,
  type ApiAuthentication,
  type UserProfile,
} from "../src/index.js";

interface RequestOptions {
  method?: "GET" | "PATCH" | "POST";
  body?: unknown;
  profile?: UserProfile;
  userId?: number;
  managerGrants?: readonly string[];
  authentication?: "session" | "token";
  idempotencyKey?: string;
}

interface Harness {
  request(path: string, options?: Readonly<RequestOptions>): Promise<Response>;
  run(sql: string, ...params: unknown[]): Promise<void>;
  rows<Row>(sql: string, ...params: unknown[]): Promise<Row[]>;
  close(): Promise<void>;
}

const now = "2026-09-02T12:00:00.000Z";
const signingKey = new Uint8Array(32).fill(68);
const profiles: readonly UserProfile[] = [
  "member",
  "project_manager",
  "people_admin",
  "accounting",
  "executive_manager",
  "administrator",
];

const authentication: ApiAuthentication = {
  tokens: {
    authenticate: async (token) =>
      token === "team-test-token"
        ? {
            tokenId: 1,
            userId: 1,
            profile: "administrator",
            managerGrants: [],
            scopes: ["team:read"],
          }
        : null,
    issue: async () => {
      throw new Error("not used");
    },
    list: async () => [],
    revoke: async () => null,
  },
  sessions: {
    resolve: async (request) => {
      const profile = request.headers.get("x-test-profile") as UserProfile | null;
      if (profile === null || !profiles.includes(profile)) return null;
      return {
        type: "user",
        userId: Number(request.headers.get("x-test-user-id") ?? "1"),
        profile,
        managerGrants: (request.headers.get("x-test-manager-grants") ?? "")
          .split(",")
          .filter(Boolean),
        authentication: { kind: "session" as const, sessionId: "team-test" },
      };
    },
  },
};

const seedStatements = [
  {
    sql: `INSERT INTO organizations
      (name, currency, modules, created_at, updated_at)
      VALUES ('Team test', 'USD', '{"team":true}', ?, ?)`,
    params: [now, now],
  },
  {
    sql: `INSERT INTO users
      (id, first_name, last_name, profile, manager_grants, is_contractor,
       weekly_capacity, created_at, updated_at) VALUES
      (1, 'Ada', 'Owner', 'administrator', '[]', 0, 144000, ?, ?),
      (2, 'Ari', 'Admin', 'administrator', '[]', 0, 126000, ?, ?),
      (3, 'Mina', 'Manager', 'project_manager', '["billable_rates_manager"]', 0, 126000, ?, ?),
      (4, 'Terry', 'Teammate', 'member', '[]', 1, 72000, ?, ?),
      (5, 'Uma', 'Unrelated', 'member', '[]', 0, 126000, ?, ?)`,
    params: [now, now, now, now, now, now, now, now, now, now],
  },
  {
    sql: `INSERT INTO user_emails
      (id, user_id, address, verified_at, is_primary, created_at, updated_at)
      VALUES (1, 4, 'terry@example.test', ?, 1, ?, ?)`,
    params: [now, now, now],
  },
  {
    sql: `INSERT INTO roles (id, name, created_at, updated_at)
      VALUES (1, 'Designer', ?, ?), (2, 'Engineer', ?, ?)`,
    params: [now, now, now, now],
  },
  {
    sql: `INSERT INTO departments (id, name, created_at, updated_at)
      VALUES (1, 'Product', ?, ?), (2, 'Operations', ?, ?)`,
    params: [now, now, now, now],
  },
  {
    sql: `INSERT INTO user_roles (user_id, role_id, created_at, updated_at)
      VALUES (4, 1, ?, ?)`,
    params: [now, now],
  },
  {
    sql: `INSERT INTO user_departments (user_id, department_id, created_at, updated_at)
      VALUES (4, 1, ?, ?)`,
    params: [now, now],
  },
  {
    sql: `INSERT INTO teammate_assignments
      (manager_id, user_id, created_at, updated_at) VALUES (3, 5, ?, ?)`,
    params: [now, now],
  },
  {
    sql: `INSERT INTO clients (id, name, currency, created_at, updated_at)
      VALUES (1, 'Northstar', 'USD', ?, ?)`,
    params: [now, now],
  },
  {
    sql: `INSERT INTO projects (id, client_id, name, code, created_at, updated_at) VALUES
      (1, 1, 'Website', 'WEB', ?, ?),
      (2, 1, 'Campaign', 'CAM', ?, ?)`,
    params: [now, now, now, now],
  },
  {
    sql: `INSERT INTO tasks (id, name, created_at, updated_at)
      VALUES (1, 'Delivery', ?, ?)`,
    params: [now, now],
  },
  {
    sql: `INSERT INTO task_assignments
      (id, project_id, task_id, billable, created_at, updated_at)
      VALUES (1, 1, 1, 1, ?, ?)`,
    params: [now, now],
  },
  {
    sql: `INSERT INTO user_assignments
      (id, project_id, user_id, is_project_manager, created_at, updated_at) VALUES
      (1, 1, 4, 0, ?, ?),
      (2, 1, 3, 1, ?, ?)`,
    params: [now, now, now, now],
  },
  {
    sql: `INSERT INTO time_entries
      (id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
       spent_date, seconds, seconds_without_timer, rounded_seconds, billable,
       created_at, updated_at) VALUES
      (1, 4, 1, 1, 1, 1, '2026-08-31', 3600, 3600, 3600, 1, ?, ?),
      (2, 4, 1, 1, 1, 1, '2026-09-01', 1800, 1800, 1800, 0, ?, ?)`,
    params: [now, now, now, now],
  },
  {
    sql: `INSERT INTO user_billable_rates
      (id, user_id, amount_cents, start_date, created_at, updated_at)
      VALUES (1, 4, 10000, '2026-01-01', ?, ?)`,
    params: [now, now],
  },
  {
    sql: `INSERT INTO user_cost_rates
      (id, user_id, amount_cents, start_date, created_at, updated_at)
      VALUES (1, 4, 4000, '2026-01-01', ?, ?)`,
    params: [now, now],
  },
] as const;

const createHarness = async (kind: "SQLite" | "D1"): Promise<Harness> => {
  let close: () => Promise<void>;
  let run: (sql: string, params: readonly unknown[]) => Promise<void>;
  let rows: <Row>(sql: string, params: readonly unknown[]) => Promise<Row[]>;
  let repository: ReturnType<typeof createTeamRepository>;
  if (kind === "SQLite") {
    const sqlite = new BetterSqlite3(":memory:");
    migrateContainer(sqlite);
    repository = createTeamRepository(createContainerDatabase(sqlite));
    run = async (sql, params) => {
      sqlite.prepare(sql).run(...params);
    };
    rows = async <Row>(sql: string, params: readonly unknown[]) =>
      sqlite.prepare(sql).all(...params) as Row[];
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
    repository = createTeamRepository(createD1Database(d1));
    run = async (sql, params) => {
      await d1.prepare(sql).bind(...params).run();
    };
    rows = async <Row>(sql: string, params: readonly unknown[]) =>
      (await d1.prepare(sql).bind(...params).all<Row>()).results;
    close = async () => miniflare.dispose();
  }
  for (const statement of seedStatements) await run(statement.sql, statement.params);
  const app = createApiApp({
    authentication,
    installApi: (api) =>
      installTeamRoutes(api, {
        repository,
        cursorSigningKey: signingKey,
        isTeamModuleEnabled: async () => {
          const result = await rows<{ enabled: number | boolean }>(
            `SELECT COALESCE(json_extract(modules, '$.team'), 0) AS enabled
             FROM organizations WHERE id = 1`,
            [],
          );
          return result[0]?.enabled === 1 || result[0]?.enabled === true;
        },
        clock: () => now,
      }),
  });
  return {
    request: async (path, options = {}) => {
      const headers = new Headers({
        origin: "https://api.test",
        "x-test-profile": options.profile ?? "administrator",
        "x-test-user-id": String(options.userId ?? 1),
        "x-test-manager-grants": (options.managerGrants ?? []).join(","),
      });
      if (options.authentication === "token")
        headers.set("authorization", "Bearer team-test-token");
      if (options.idempotencyKey !== undefined)
        headers.set("idempotency-key", options.idempotencyKey);
      if (options.body !== undefined) headers.set("content-type", "application/json");
      return app.request(`https://api.test/api/v1${path}`, {
        method: options.method ?? "GET",
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    },
    run: (sql, ...params) => run(sql, params),
    rows: <Row>(sql: string, ...params: unknown[]) => rows<Row>(sql, params),
    close,
  };
};

const factories = [
  ["SQLite", () => createHarness("SQLite")],
  ["D1", () => createHarness("D1")],
] as const;

for (const [runtime, factory] of factories) {
  describe(`Team API (${runtime})`, () => {
    let harness: Harness | undefined;
    afterEach(async () => harness?.close());

    it("uses authoritative rounded time and restricts project-manager visibility", async () => {
      harness = await factory();
      const response = await harness.request(
        "/team/people?from=2026-08-31&to=2026-09-06&is_active=true&per_page=50",
        { profile: "project_manager", userId: 3 },
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const body = (await response.json()) as {
        data: Array<{
          id: number;
          total_seconds: number;
          billable_seconds: number;
          nonbillable_seconds: number;
          utilization_ppm: number | null;
        }>;
      };
      expect(body.data.map(({ id }) => id)).toEqual([3, 4, 5]);
      expect(body.data[1]).toMatchObject({
        total_seconds: 5400,
        billable_seconds: 3600,
        nonbillable_seconds: 1800,
        utilization_ppm: 75000,
      });

      const hidden = await harness.request("/team/people/2", {
        profile: "project_manager",
        userId: 3,
      });
      expect(hidden.status).toBe(404);
      const member = await harness.request(
        "/team/people?from=2026-08-31&to=2026-09-06",
        { profile: "member", userId: 4 },
      );
      expect(member.status).toBe(403);
    });

    it("redacts rates by profile and exposes persisted person relations", async () => {
      harness = await factory();
      const peopleAdmin = await harness.request("/team/people/4", {
        profile: "people_admin",
        userId: 2,
      });
      expect(peopleAdmin.status, await peopleAdmin.clone().text()).toBe(200);
      const peopleBody = (await peopleAdmin.json()) as {
        data: Record<string, unknown> & {
          roles: unknown[];
          departments: unknown[];
          project_assignments: unknown[];
          notifications: unknown;
        };
      };
      expect(peopleBody.data).not.toHaveProperty("billable_rates");
      expect(peopleBody.data).not.toHaveProperty("cost_rates");
      expect(peopleBody.data.roles).toEqual([{ id: 1, name: "Designer" }]);
      expect(peopleBody.data.departments).toEqual([{ id: 1, name: "Product" }]);
      expect(peopleBody.data.project_assignments).toHaveLength(1);
      expect(peopleBody.data.notifications).toMatchObject({
        delivery_active: false,
        daily_reminder_enabled: false,
        channels: { email: false, desktop: false, slack: false },
        include_in_team_reminders: false,
        weekly_digest: false,
        notify_project_deleted: false,
      });

      const manager = await harness.request("/team/people/4", {
        profile: "project_manager",
        userId: 3,
        managerGrants: ["billable_rates_manager"],
      });
      const managerData = ((await manager.json()) as { data: Record<string, unknown> }).data;
      expect(managerData).toHaveProperty("billable_rates");
      expect(managerData).not.toHaveProperty("cost_rates");

      const administrator = await harness.request("/team/people/4");
      const administratorData = (
        (await administrator.json()) as { data: Record<string, unknown> }
      ).data;
      expect(administratorData).toHaveProperty("billable_rates");
      expect(administratorData).toHaveProperty("cost_rates");
    });

    it("applies idempotent optimistic person, assignment, and notification changes", async () => {
      harness = await factory();
      const personInput = {
        expected_version: 0,
        first_name: "Terra",
        weekly_capacity: 90000,
        role_ids: [2],
        department_ids: [2],
      };
      const changed = await harness.request("/team/people/4", {
        method: "PATCH",
        body: personInput,
        idempotencyKey: "team.person.change",
      });
      expect(changed.status, await changed.clone().text()).toBe(200);
      expect(await changed.json()).toMatchObject({ data: { target_user_id: 4, version: 1 } });

      const replay = await harness.request("/team/people/4", {
        method: "PATCH",
        body: personInput,
        idempotencyKey: "team.person.change",
      });
      expect(replay.status, await replay.clone().text()).toBe(200);
      expect(await replay.json()).toMatchObject({ data: { version: 1 } });
      await expect(
        harness.run(
          `UPDATE team_command_ledger SET result_json = '{}'
           WHERE command_kind = 'person.update' AND command_id = 'team.person.change'`,
        ),
      ).rejects.toThrow(/immutable/);
      await expect(
        harness.run(
          `DELETE FROM team_command_ledger
           WHERE command_kind = 'person.update' AND command_id = 'team.person.change'`,
        ),
      ).rejects.toThrow(/append-only/);

      const reused = await harness.request("/team/people/4", {
        method: "PATCH",
        body: { ...personInput, first_name: "Different" },
        idempotencyKey: "team.person.change",
      });
      expect(reused.status).toBe(409);
      const stale = await harness.request("/team/people/4", {
        method: "PATCH",
        body: { expected_version: 0, last_name: "Late" },
        idempotencyKey: "team.person.stale",
      });
      expect(stale.status).toBe(409);

      const assignments = await harness.request(
        "/team/people/4/project-assignments/replace",
        {
          method: "POST",
          body: {
            expected_version: 1,
            assignments: [{ project_id: 2, is_project_manager: true }],
          },
          idempotencyKey: "team.assignments.replace",
        },
      );
      expect(assignments.status, await assignments.clone().text()).toBe(200);
      expect(await assignments.json()).toMatchObject({ data: { version: 2 } });

      const notifications = await harness.request("/team/people/4/notifications", {
        method: "POST",
        body: {
          expected_version: 2,
          daily_reminder_enabled: false,
          reminder_time: null,
          reminder_days: [],
          channels: { email: false, desktop: false, slack: false },
          include_in_team_reminders: false,
          weekly_digest: false,
          notify_project_deleted: false,
        },
        idempotencyKey: "team.notifications.change",
      });
      expect(notifications.status, await notifications.clone().text()).toBe(200);
      expect(await notifications.json()).toMatchObject({ data: { version: 3 } });

      const refreshed = await harness.request("/team/people/4");
      const data = (await refreshed.json()) as {
        data: {
          first_name: string;
          version: number;
          roles: unknown[];
          departments: unknown[];
          project_assignments: Array<{ project_id: number; is_active: boolean }>;
          notifications: { reminder_time: string | null };
        };
      };
      expect(data.data).toMatchObject({
        first_name: "Terra",
        version: 3,
        roles: [{ id: 2, name: "Engineer" }],
        departments: [{ id: 2, name: "Operations" }],
        notifications: { delivery_active: false, reminder_time: null },
      });
      expect(data.data.project_assignments).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ project_id: 1, is_active: false }),
          expect.objectContaining({ project_id: 2, is_active: true }),
        ]),
      );
    });

    it("[e2e:rate-change] closes the prior rate and never exposes a partial D1 change", async () => {
      harness = await factory();
      const response = await harness.request("/team/people/4/rates", {
        method: "POST",
        body: {
          expected_version: 0,
          kind: "billable",
          amount_cents: 12550,
          start_date: "2026-09-01",
        },
        idempotencyKey: "team.rate.billable.2026-09-01",
      });
      expect(response.status, await response.clone().text()).toBe(201);
      expect(await response.json()).toMatchObject({
        data: { target_user_id: 4, version: 1, resource_id: 2 },
      });
      expect(
        await harness.rows<{
          amount_cents: number;
          start_date: string;
          end_date: string | null;
        }>(
          `SELECT amount_cents, start_date, end_date FROM user_billable_rates
           WHERE user_id = 4 ORDER BY start_date`,
        ),
      ).toEqual([
        { amount_cents: 10000, start_date: "2026-01-01", end_date: "2026-08-31" },
        { amount_cents: 12550, start_date: "2026-09-01", end_date: null },
      ]);

      const invalid = await harness.request("/team/people/4/rates", {
        method: "POST",
        body: {
          expected_version: 1,
          kind: "billable",
          amount_cents: 13000,
          start_date: "2026-08-01",
        },
        idempotencyKey: "team.rate.out-of-order",
      });
      expect(invalid.status).toBe(422);
      expect(await harness.rows<{ version: number }>("SELECT version FROM users WHERE id = 4")).toEqual(
        [{ version: 1 }],
      );
    });

    it("allows exactly one same-version command even when timestamps are identical", async () => {
      harness = await factory();
      const [left, right] = await Promise.all([
        harness.request("/team/people/4", {
          method: "PATCH",
          body: { expected_version: 0, first_name: "Left" },
          idempotencyKey: "team.concurrent.left",
        }),
        harness.request("/team/people/4", {
          method: "PATCH",
          body: { expected_version: 0, first_name: "Right" },
          idempotencyKey: "team.concurrent.right",
        }),
      ]);
      expect([left.status, right.status].sort()).toEqual([200, 409]);
      expect(
        await harness.rows<{ first_name: string; version: number }>(
          "SELECT first_name, version FROM users WHERE id = 4",
        ),
      ).toEqual([expect.objectContaining({ version: 1 })]);
      expect(
        await harness.rows<{ count: number }>(
          "SELECT count(*) AS count FROM team_command_ledger WHERE target_user_id = 4",
        ),
      ).toEqual([{ count: 1 }]);
    });

    it("protects the owner, profile boundary, Slack truthfulness, and session-only writes", async () => {
      harness = await factory();
      const owner = await harness.request("/team/people/1", {
        method: "PATCH",
        body: { expected_version: 0, profile: "member" },
        idempotencyKey: "team.owner.profile",
      });
      expect(owner.status).toBe(409);

      const profile = await harness.request("/team/people/4", {
        method: "PATCH",
        body: { expected_version: 0, profile: "people_admin" },
        profile: "people_admin",
        userId: 2,
        idempotencyKey: "team.profile.denied",
      });
      expect(profile.status).toBe(403);

      const slack = await harness.request("/team/people/4/notifications", {
        method: "POST",
        body: {
          expected_version: 0,
          daily_reminder_enabled: true,
          reminder_time: "09:00",
          reminder_days: ["monday"],
          channels: { email: false, desktop: false, slack: true },
          include_in_team_reminders: true,
          weekly_digest: true,
          notify_project_deleted: true,
        },
        idempotencyKey: "team.notifications.slack",
      });
      expect(slack.status).toBe(422);

      const unavailableDelivery = await harness.request("/team/people/4/notifications", {
        method: "POST",
        body: {
          expected_version: 0,
          daily_reminder_enabled: false,
          reminder_time: null,
          reminder_days: [],
          channels: { email: true, desktop: false, slack: false },
          include_in_team_reminders: false,
          weekly_digest: false,
          notify_project_deleted: false,
        },
        idempotencyKey: "team.notifications.delivery-unavailable",
      });
      expect(unavailableDelivery.status).toBe(422);
      expect(await unavailableDelivery.json()).toMatchObject({
        error: {
          fields: expect.arrayContaining([
            expect.objectContaining({ code: "delivery_unavailable" }),
          ]),
        },
      });
      const unchanged = await harness.request("/team/people/4");
      expect(await unchanged.json()).toMatchObject({
        data: {
          version: 0,
          notifications: {
            delivery_active: false,
            daily_reminder_enabled: false,
            channels: { email: false, desktop: false, slack: false },
            include_in_team_reminders: false,
            weekly_digest: false,
            notify_project_deleted: false,
          },
        },
      });

      const token = await harness.request("/team/people/4", {
        method: "PATCH",
        body: { expected_version: 0, first_name: "Token" },
        authentication: "token",
        idempotencyKey: "team.token.denied",
      });
      expect(token.status).toBe(403);
    });

    it("supports safe deactivation and Active/All filtering", async () => {
      harness = await factory();
      const deactivated = await harness.request("/team/people/4", {
        method: "PATCH",
        body: { expected_version: 0, is_active: false },
        idempotencyKey: "team.person.deactivate",
      });
      expect(deactivated.status, await deactivated.clone().text()).toBe(200);

      const active = await harness.request(
        "/team/people?from=2026-08-31&to=2026-09-06&is_active=true&per_page=50",
      );
      const activeIds = ((await active.json()) as { data: Array<{ id: number }> }).data.map(
        ({ id }) => id,
      );
      expect(activeIds).not.toContain(4);

      const all = await harness.request(
        "/team/people?from=2026-08-31&to=2026-09-06&per_page=50",
      );
      const allPeople = (await all.json()) as {
        data: Array<{ id: number; is_active: boolean }>;
      };
      expect(allPeople.data).toContainEqual(expect.objectContaining({ id: 4, is_active: false }));
    });

    it("hides Team reads and writes when the organization module is disabled", async () => {
      harness = await factory();
      await harness.run(
        `UPDATE organizations SET modules = json_set(modules, '$.team', json('false'))
         WHERE id = 1`,
      );
      const status = await harness.request("/team/status");
      expect(status.status).toBe(200);
      expect(await status.json()).toMatchObject({ data: { enabled: false } });
      const list = await harness.request(
        "/team/people?from=2026-08-31&to=2026-09-06&per_page=50",
      );
      expect(list.status).toBe(403);
      expect(await list.json()).toMatchObject({ error: { code: "module_disabled" } });
      const update = await harness.request("/team/people/4", {
        method: "PATCH",
        body: { expected_version: 0, first_name: "Hidden" },
        idempotencyKey: "team.disabled.update",
      });
      expect(update.status).toBe(403);
    });
  });
}
