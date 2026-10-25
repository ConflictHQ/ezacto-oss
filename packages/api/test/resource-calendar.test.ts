import BetterSqlite3 from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createContainerDatabase } from "../../db/src/adapters.js";
import { migrateContainer } from "../../db/src/migrate.js";
import { createResourceCalendarRepository } from "../../db/src/resource-calendar.js";
import { createApiApp } from "../src/app.js";
import type { ApiAuthentication } from "../src/auth.js";
import { installResourceCalendarRoutes } from "../src/resources/resource-calendar.js";

const stamp = "2026-10-05T00:30:00.000Z";
const authentication: ApiAuthentication = {
  ownMoneyVisible: async () => false,
  sessions: {
    resolve: async (request) => ({
      type: "user",
      userId: request.headers.get("x-member") ? 2 : 1,
      profile: request.headers.get("x-member") ? "member" : "administrator",
      managerGrants: [],
      authentication: { kind: "session", sessionId: "owned-calendar-http" },
    }),
  },
  tokens: {
    authenticate: async (token) => ({
      tokenId: 1,
      userId: 1,
      profile: "administrator",
      scopes: token === "reader" ? ["schedule:read"] : ["time_entries:read"],
    }),
    issue: async () => {
      throw new Error("Unused");
    },
    list: async () => [],
    revoke: async () => null,
  },
};
let sqlite: BetterSqlite3.Database;
let app: ReturnType<typeof createApiApp>;
beforeAll(() => {
  sqlite = new BetterSqlite3(":memory:");
  migrateContainer(sqlite);
  sqlite
    .prepare(
      `INSERT INTO organizations(name,timezone,modules,created_at,updated_at)
    VALUES('Owned API calendar','America/Los_Angeles','{}',?,?)`,
    )
    .run(stamp, stamp);
  for (const [id, profile] of [
    [1, "administrator"],
    [2, "member"],
    [3, "member"],
  ] as const)
    sqlite
      .prepare(
        `INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at)
      VALUES(?,'Owned',?,?,'[]',?,?)`,
      )
      .run(id, `Person ${id}`, profile, stamp, stamp);
  sqlite
    .prepare(
      "INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'Owned client','USD',?,?)",
    )
    .run(stamp, stamp);
  for (const [id, name] of [
    [1, "Visible project"],
    [2, "Other project"],
  ] as const)
    sqlite
      .prepare(
        "INSERT INTO projects(id,client_id,name,bill_by,created_at,updated_at) VALUES(?,1,?,'people',?,?)",
      )
      .run(id, name, stamp, stamp);
  sqlite
    .prepare(
      "INSERT INTO user_assignments(user_id,project_id,created_at,updated_at) VALUES(2,1,?,?)",
    )
    .run(stamp, stamp);
  sqlite
    .prepare(
      `INSERT INTO allocations(user_id,project_id,start_date,end_date,planned_seconds_per_week,created_at,updated_at)
    VALUES(2,1,'2026-10-08','2026-10-09',4442,?,?)`,
    )
    .run(stamp, stamp);
  app = createApiApp({
    authentication,
    installApi: (api) =>
      installResourceCalendarRoutes(api, {
        repository: createResourceCalendarRepository(
          createContainerDatabase(sqlite),
        ),
        now: () => new Date(stamp),
        cursorSigningKey: new TextEncoder().encode(
          "owned-calendar-test-signing-key-32-bytes",
        ),
      }),
  });
});
afterAll(() => sqlite?.close());
const path =
  "/api/v1/resource-calendar?view=team&from=2026-10-05&to=2026-10-11";
interface CalendarEnvelope {
  data: {
    context: Record<string, string>;
    people: { person_id: number }[];
    nextCursor?: unknown;
  };
  page: { next_cursor: string };
  links: { next: string };
}

describe("resource calendar native HTTP", () => {
  it("publishes organization context and live scope-bound signed pagination with no-store", async () => {
    const initial = await app.request("/api/v1/resource-calendar/context");
    expect(initial.status).toBe(200);
    expect(initial.headers.get("cache-control")).toBe("no-store");
    expect(
      ((await initial.json()) as { data: Record<string, string> }).data,
    ).toMatchObject({ time_zone: "America/Los_Angeles", today: "2026-10-04" });
    const response = await app.request(`${path}&per_page=1`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const first = (await response.json()) as CalendarEnvelope;
    expect(first.data.context).toMatchObject({
      time_zone: "America/Los_Angeles",
      today: "2026-10-04",
      current_week_start: "2026-09-28",
    });
    expect(
      first.data.people.map((row: { person_id: number }) => row.person_id),
    ).toEqual([1]);
    expect(first.page.next_cursor).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(first.data.nextCursor).toBeUndefined();
    const next = await app.request(first.links.next);
    expect(next.status).toBe(200);
    expect(
      ((await next.json()) as CalendarEnvelope).data.people.map(
        (row) => row.person_id,
      ),
    ).toEqual([2]);
    expect(
      (await app.request(first.links.next.replace("2026-10-11", "2026-10-18")))
        .status,
    ).toBe(422);
    const forged = new URL(first.links.next, "https://example.invalid");
    forged.searchParams.set("cursor", first.page.next_cursor + "x");
    expect((await app.request(forged.pathname + forged.search)).status).toBe(
      422,
    );
  });
  it("enforces token ceilings, actual native reader scope, required fields and bounded dates", async () => {
    expect(
      (
        await app.request(path, {
          headers: { authorization: "Bearer no-schedule" },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await app.request("/api/v1/resource-calendar/context", {
          headers: { authorization: "Bearer no-schedule" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await app.request(path, { headers: { authorization: "Bearer reader" } }))
        .status,
    ).toBe(200);
    const own = await app.request(path, { headers: { "x-member": "yes" } });
    expect(
      ((await own.json()) as CalendarEnvelope).data.people.map(
        (row) => row.person_id,
      ),
    ).toEqual([2]);
    expect(
      (
        await app.request(`${path}&person_id=3`, {
          headers: { "x-member": "yes" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await app.request("/api/v1/resource-calendar?view=team")).status,
    ).toBe(422);
    expect((await app.request(`${path}&per_page=101`)).status).toBe(422);
    expect(
      (await app.request(path.replace("to=2026-10-11", "to=2028-10-11")))
        .status,
    ).toBe(422);
    expect(
      (await app.request(path.replace("to=2026-10-11", "to=2026-10-01")))
        .status,
    ).toBe(422);
    const edge = path
      .replace("from=2026-10-05", "from=9999-12-31")
      .replace("to=2026-10-11", "to=9999-12-31");
    expect((await app.request(edge)).status).toBe(422);
    expect(
      (
        await app.request(
          edge.replace(
            "/resource-calendar?",
            "/resource-calendar/allocations?",
          ),
        )
      ).status,
    ).toBe(422);
  });
  it("publishes exact dated range DTOs and only scoped project labels with independently signed cursors", async () => {
    type Collection = {
      data: unknown[];
      links: { next: string | null };
      page: { next_cursor: string | null };
    };
    const response = await app.request(
      path.replace("/resource-calendar?", "/resource-calendar/allocations?"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(((await response.json()) as Collection).data).toEqual([
      {
        id: 1,
        version: 0,
        user_id: 2,
        project_id: 1,
        project_name: "Visible project",
        start_date: "2026-10-08",
        end_date: "2026-10-09",
        planned_seconds_per_week: 4442,
      },
    ]);
    const directory = "/api/v1/resource-calendar/projects";
    const first = (await (
      await app.request(directory + "?per_page=1")
    ).json()) as Collection;
    expect(first.data).toEqual([
      { id: 1, name: "Visible project", is_active: true },
    ]);
    expect(first.page.next_cursor).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(
      ((await (await app.request(first.links.next!)).json()) as Collection)
        .data,
    ).toEqual([{ id: 2, name: "Other project", is_active: true }]);
    const own = await app.request(directory, {
      headers: { "x-member": "yes" },
    });
    expect(((await own.json()) as Collection).data).toEqual([
      { id: 1, name: "Visible project", is_active: true },
    ]);
    const wrongPath =
      path.replace("/resource-calendar?", "/resource-calendar/allocations?") +
      "&per_page=1&cursor=" +
      encodeURIComponent(first.page.next_cursor!);
    expect((await app.request(wrongPath)).status).toBe(422);
    for (const uri of [
      directory,
      path.replace("/resource-calendar?", "/resource-calendar/allocations?"),
    ])
      expect(
        (
          await app.request(uri, {
            headers: { authorization: "Bearer no-schedule" },
          })
        ).status,
      ).toBe(403);
  });
});
