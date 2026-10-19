import BetterSqlite3 from "better-sqlite3";
import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";
import {
  createContainerDatabase,
  createD1Database,
} from "../../db/src/adapters.js";
import { createClientRateCardRepository } from "../../db/src/client-rate-cards.js";
import { migrateContainer, migrateD1 } from "../../db/src/migrate.js";
import {
  createApiApp,
  installClientRateCardRoutes,
  type ApiAuthentication,
  type UserProfile,
} from "../src/index.js";

interface Harness {
  request(
    path: string,
    init?: RequestInit & { profile?: UserProfile; grants?: string },
  ): Promise<Response>;
  rows<T>(sql: string): Promise<T[]>;
  close(): Promise<void>;
}

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
      const grants = request.headers.get("x-test-grants");
      return {
        type: "user",
        userId: 1,
        profile,
        managerGrants: grants === null || grants === "" ? [] : grants.split(","),
        authentication: { kind: "session", sessionId: "card-test" },
      };
    },
  },
};

// Root(1) <- Child(2) <- Leaf(3); Bill-to(4) is the leaf's bill-to, not an ancestor.
const seed = [
  {
    sql: `INSERT INTO organizations (name, currency, modules, created_at, updated_at)
      VALUES ('Card org', 'USD', '{}', ?, ?)`,
    params: [now, now],
  },
  {
    sql: `INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
      VALUES (1, 'Card', 'Tester', 'administrator', '[]', ?, ?)`,
    params: [now, now],
  },
  {
    sql: `INSERT INTO clients (id, name, currency, parent_client_id, created_at, updated_at) VALUES
      (1, 'Root', 'USD', NULL, ?, ?), (2, 'Child', 'USD', 1, ?, ?),
      (3, 'Leaf', 'USD', 2, ?, ?), (4, 'Bill-to', 'USD', NULL, ?, ?)`,
    params: Array<string>(8).fill(now),
  },
  { sql: `UPDATE clients SET bill_to_client_id = 4 WHERE id = 3`, params: [] },
  {
    sql: `INSERT INTO projects (id, client_id, name, billing_method, bill_by, budget_by, created_at, updated_at)
      VALUES (1, 3, 'People', 'time_materials', 'people', 'none', ?, ?)`,
    params: [now, now],
  },
  {
    sql: `INSERT INTO tasks (id, name, created_at, updated_at) VALUES (1, 'Dev', ?, ?), (2, 'Design', ?, ?)`,
    params: Array<string>(4).fill(now),
  },
  {
    sql: `INSERT INTO task_assignments (id, project_id, task_id, billable, created_at, updated_at)
      VALUES (1, 1, 1, 1, ?, ?)`,
    params: [now, now],
  },
  {
    sql: `INSERT INTO user_assignments (id, project_id, user_id, created_at, updated_at)
      VALUES (1, 1, 1, ?, ?)`,
    params: [now, now],
  },
  {
    sql: `INSERT INTO time_entries
      (id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
       spent_date, seconds, seconds_without_timer, rounded_seconds, billable, budgeted,
       billable_rate_cents, cost_rate_cents, created_at, updated_at)
      VALUES (101, 1, 1, 1, 1, 1, '2026-09-01', 3600, 3600, 3600, 1, 1, 10000, NULL, ?, ?)`,
    params: [now, now],
  },
] as const;

const createHarness = async (kind: "SQLite" | "D1"): Promise<Harness> => {
  let close: () => Promise<void>;
  let run: (sql: string, params: readonly unknown[]) => Promise<void>;
  let rows: <T>(sql: string) => Promise<T[]>;
  let db:
    | ReturnType<typeof createContainerDatabase>
    | ReturnType<typeof createD1Database>;
  if (kind === "SQLite") {
    const sqlite = new BetterSqlite3(":memory:");
    migrateContainer(sqlite);
    db = createContainerDatabase(sqlite);
    run = async (statement, params) => {
      sqlite.prepare(statement).run(...params);
    };
    rows = async <T>(statement: string) =>
      sqlite.prepare(statement).all() as T[];
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
    run = async (statement, params) => {
      await d1
        .prepare(statement)
        .bind(...params)
        .run();
    };
    rows = async <T>(statement: string) =>
      (await d1.prepare(statement).all<T>()).results;
    close = async () => miniflare.dispose();
  }
  for (const statement of seed) await run(statement.sql, statement.params);

  const app = createApiApp({
    authentication,
    installApi: (api) => {
      installClientRateCardRoutes(api, {
        repository: createClientRateCardRepository(db),
        clock: {
          now: () => ({
            instant: "2026-10-19T12:00:00.000Z",
            date: "2026-10-19",
            time: "12:00",
          }),
        },
      });
    },
  });
  return {
    request: (path, init = {}) => {
      const { profile = "administrator", grants, ...rest } = init;
      return Promise.resolve(
        app.request(`https://api.test/api/v1${path}`, {
          ...rest,
          headers: {
            origin: "https://api.test",
            "x-test-profile": profile,
            ...(grants === undefined ? {} : { "x-test-grants": grants }),
            ...(rest.body === undefined
              ? {}
              : { "content-type": "application/json" }),
            ...(rest.headers ?? {}),
          },
        }),
      );
    },
    rows,
    close,
  };
};

const factories = [
  ["SQLite", () => createHarness("SQLite")],
  ["D1", () => createHarness("D1")],
] as const;

const post = (profile: UserProfile, body: unknown, grants?: string) => ({
  method: "POST",
  body: JSON.stringify(body),
  profile,
  ...(grants === undefined ? {} : { grants }),
});

for (const [runtime, factory] of factories) {
  describe(`client rate cards API (${runtime})`, () => {
    let harness: Harness | undefined;
    afterEach(async () => harness?.close());

    it("[api] only profiles that see billable rates can read or write a card", async () => {
      harness = await factory();
      const created = await harness.request(
        "/clients/1/rate-card",
        post("administrator", { name: "Standard" }),
      );
      expect(created.status, await created.clone().text()).toBe(201);

      const denied: Array<[UserProfile, string | undefined]> = [
        ["member", undefined],
        ["people_admin", undefined],
        ["project_manager", undefined],
        ["project_manager", "other_grant"],
      ];
      for (const [profile, grants] of denied) {
        const reads = [
          "/clients/1/rate-card",
          "/clients/3/effective-rate-card?task_id=1",
        ];
        for (const path of reads) {
          const response = await harness.request(path, {
            profile,
            ...(grants === undefined ? {} : { grants }),
          });
          expect([profile, grants, path, response.status]).toEqual([
            profile,
            grants,
            path,
            403,
          ]);
        }
        const write = await harness.request(
          "/clients/2/rate-card",
          post(profile, { name: "Nope" }, grants),
        );
        expect([profile, grants, write.status]).toEqual([profile, grants, 403]);
        const version = await harness.request(
          "/clients/1/rate-card/versions",
          post(profile, { start_date: null, lines: [] }, grants),
        );
        expect([profile, grants, version.status]).toEqual([
          profile,
          grants,
          403,
        ]);
      }
      expect(
        await harness.rows(`SELECT 1 FROM client_rate_cards`),
      ).toHaveLength(1);

      for (const profile of ["accounting", "executive_manager"] as const) {
        expect(
          (await harness.request("/clients/1/rate-card", { profile })).status,
        ).toBe(200);
      }
      // A project manager granted billable rates may read and write.
      const granted = await harness.request("/clients/2/rate-card", {
        ...post("project_manager", { name: "PM card" }, "billable_rates_manager"),
      });
      expect(granted.status, await granted.clone().text()).toBe(201);
    });

    it("[api] creates a card, appends versions, and refuses rewrites", async () => {
      harness = await factory();
      expect((await harness.request("/clients/1/rate-card")).status).toBe(404);
      expect((await harness.request("/clients/99/rate-card")).status).toBe(404);

      const created = await harness.request(
        "/clients/1/rate-card",
        post("administrator", { name: "Standard" }),
      );
      expect(created.headers.get("location")).toBe("/api/v1/clients/1/rate-card");
      expect(((await created.json()) as { data: unknown }).data).toMatchObject({
        client_id: 1,
        name: "Standard",
        versions: [],
      });
      const again = await harness.request(
        "/clients/1/rate-card",
        post("administrator", { name: "Second" }),
      );
      expect(again.status).toBe(409);
      expect(((await again.json()) as { error: { code: string } }).error.code).toBe(
        "rate_card_exists",
      );

      const lines = [
        { task_id: null, amount_cents: 12000 },
        { task_id: 1, amount_cents: 15000 },
      ];
      const appended = await harness.request(
        "/clients/1/rate-card/versions",
        post("administrator", { start_date: "2026-01-01", lines }),
      );
      expect(appended.status, await appended.clone().text()).toBe(201);
      const card = (
        (await appended.json()) as {
          data: { versions: Array<{ start_date: string | null; lines: unknown }> };
        }
      ).data;
      expect(card.versions).toHaveLength(1);
      expect(card.versions[0]).toMatchObject({ start_date: "2026-01-01", lines });

      for (const start of ["2026-01-01", "2025-06-01", null]) {
        const stale = await harness.request(
          "/clients/1/rate-card/versions",
          post("administrator", { start_date: start, lines }),
        );
        expect([start, stale.status]).toEqual([start, 409]);
        expect(
          ((await stale.json()) as { error: { code: string } }).error.code,
        ).toBe("rate_card_version_order");
      }

      const read = await harness.request("/clients/1/rate-card");
      expect(
        ((await read.json()) as { data: { versions: unknown[] } }).data.versions,
      ).toHaveLength(1);

      // Cards are append-only: there is no route to change or remove one.
      for (const method of ["PATCH", "PUT", "DELETE"]) {
        const response = await harness.request("/clients/1/rate-card", {
          method,
          ...(method === "DELETE" ? {} : { body: "{}" }),
        });
        expect([method, response.status === 404 || response.status === 405]).toEqual([
          method,
          true,
        ]);
      }
    });

    it("[api] rejects malformed cards with field errors", async () => {
      harness = await factory();
      await harness.request("/clients/1/rate-card", post("administrator", { name: "S" }));
      const bad: Array<[string, unknown, unknown]> = [
        ["/clients/1/rate-card", { name: "" }, "name"],
        ["/clients/2/rate-card", { name: "x", extra: 1 }, "extra"],
        ["/clients/1/rate-card/versions", { lines: [] }, "start_date"],
        ["/clients/1/rate-card/versions", { start_date: "2026-02-30", lines: [] }, "start_date"],
        ["/clients/1/rate-card/versions", { start_date: null }, "lines"],
        [
          "/clients/1/rate-card/versions",
          { start_date: null, lines: [{ task_id: null, amount_cents: -1 }] },
          "lines[0].amount_cents",
        ],
        [
          "/clients/1/rate-card/versions",
          { start_date: null, lines: [{ task_id: null, amount_cents: 1.5 }] },
          "lines[0].amount_cents",
        ],
        [
          "/clients/1/rate-card/versions",
          { start_date: null, lines: [{ task_id: 0, amount_cents: 1 }] },
          "lines[0].task_id",
        ],
        [
          "/clients/1/rate-card/versions",
          {
            start_date: null,
            lines: [
              { task_id: 1, amount_cents: 1 },
              { task_id: 1, amount_cents: 2 },
            ],
          },
          "lines[1].task_id",
        ],
        [
          "/clients/1/rate-card/versions",
          { start_date: null, lines: [{ task_id: 77, amount_cents: 1 }] },
          "lines",
        ],
      ];
      for (const [path, body, field] of bad) {
        const response = await harness.request(path, post("administrator", body));
        const text = await response.clone().text();
        expect([path, field, response.status, text.includes(`"${field}"`)]).toEqual([
          path,
          field,
          422,
          true,
        ]);
      }
      expect(
        (await harness.request("/clients/99/rate-card", post("administrator", { name: "x" })))
          .status,
      ).toBe(404);
      expect(
        (
          await harness.request(
            "/clients/2/rate-card/versions",
            post("administrator", { start_date: null, lines: [] }),
          )
        ).status,
      ).toBe(404);
    });

    it("[api] effective lookup names the supplying ancestor and ignores bill-to", async () => {
      harness = await factory();
      const lookup = async (path: string) => {
        const response = await harness!.request(path);
        return {
          status: response.status,
          body: (await response.json()) as {
            data?: Record<string, unknown>;
            error?: { code: string };
          },
        };
      };
      expect((await lookup("/clients/3/effective-rate-card?task_id=1")).status).toBe(404);

      await harness.request("/clients/1/rate-card", post("administrator", { name: "Root card" }));
      await harness.request(
        "/clients/1/rate-card/versions",
        post("administrator", {
          start_date: "2026-01-01",
          lines: [
            { task_id: null, amount_cents: 12000 },
            { task_id: 1, amount_cents: 15000 },
          ],
        }),
      );
      expect((await lookup("/clients/3/effective-rate-card?task_id=1")).body.data).toEqual({
        client_id: 3,
        supplied_by_client_id: 1,
        depth: 2,
        card_id: 1,
        card_name: "Root card",
        version_start_date: "2026-01-01",
        task_id: 1,
        amount_cents: 15000,
      });
      expect(
        (await lookup("/clients/3/effective-rate-card?task_id=2&spent_date=2026-06-01")).body.data,
      ).toMatchObject({ task_id: null, amount_cents: 12000 });
      expect(
        (await lookup("/clients/3/effective-rate-card?task_id=2&spent_date=2025-12-31")).status,
      ).toBe(404);

      // The bill-to client's card is never inherited.
      await harness.request("/clients/4/rate-card", post("administrator", { name: "Bill-to" }));
      await harness.request(
        "/clients/4/rate-card/versions",
        post("administrator", { start_date: null, lines: [{ task_id: null, amount_cents: 99000 }] }),
      );
      expect(
        (await lookup("/clients/3/effective-rate-card?task_id=1")).body.data,
      ).toMatchObject({ supplied_by_client_id: 1 });

      // A node's own card overrides the inherited one.
      await harness.request("/clients/3/rate-card", post("administrator", { name: "Leaf" }));
      await harness.request(
        "/clients/3/rate-card/versions",
        post("administrator", { start_date: null, lines: [{ task_id: null, amount_cents: 5000 }] }),
      );
      expect(
        (await lookup("/clients/3/effective-rate-card?task_id=1")).body.data,
      ).toMatchObject({ supplied_by_client_id: 3, depth: 0, amount_cents: 5000 });

      for (const path of [
        "/clients/3/effective-rate-card",
        "/clients/3/effective-rate-card?task_id=0",
        "/clients/3/effective-rate-card?task_id=1&spent_date=nope",
        "/clients/3/effective-rate-card?task_id=1&extra=1",
      ]) {
        expect([path, (await lookup(path)).status]).toEqual([path, 422]);
      }
      expect((await lookup("/clients/99/effective-rate-card?task_id=1")).status).toBe(404);
    });

    it("[api] a card change leaves existing entry snapshots untouched", async () => {
      harness = await factory();
      await harness.request("/clients/1/rate-card", post("administrator", { name: "Root card" }));
      await harness.request(
        "/clients/1/rate-card/versions",
        post("administrator", { start_date: null, lines: [{ task_id: null, amount_cents: 99000 }] }),
      );
      await harness.request(
        "/clients/1/rate-card/versions",
        post("administrator", { start_date: "2026-09-01", lines: [{ task_id: null, amount_cents: 1 }] }),
      );
      expect(
        await harness.rows(`SELECT billable_rate_cents FROM time_entries WHERE id = 101`),
      ).toEqual([{ billable_rate_cents: 10000 }]);
    });
  });
}
