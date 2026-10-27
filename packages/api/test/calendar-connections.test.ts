import BetterSqlite3 from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { migrateContainer } from "../../db/src/migrate.js";
import { createContainerDatabase } from "../../db/src/adapters.js";
import { createContainerSessionStore } from "../../db/src/sessions.js";
import { createCalendarConnectionStore } from "../../db/src/calendar-connections.js";
import { createCalendarSyncService } from "../../integrations/src/calendar-sync.js";
import { createApiSessionService } from "../src/sessions.js";
import { createApiApp } from "../src/app.js";
import { installCalendarConnectionRoutes } from "../src/calendar-connections.js";
let db: BetterSqlite3.Database | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});
const fixture = async () => {
  db = new BetterSqlite3(":memory:");
  migrateContainer(db);
  const at = new Date().toISOString();
  db.prepare(
    "INSERT INTO organizations(id,name,modules,created_at,updated_at) VALUES(1,'Owned','{}',?,?)",
  ).run(at, at);
  db.prepare(
    "INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(1,'A','Admin','administrator','[]',?,?),(2,'M','Member','member','[]',?,?)",
  ).run(at, at, at, at);
  const sessions = createContainerSessionStore(db),
    first = await sessions.issue(1),
    second = await sessions.issue(2);
  const service = await createCalendarSyncService({
    store: createCalendarConnectionStore(createContainerDatabase(db)),
    deploymentKey: new Uint8Array(32).fill(7),
  });
  await service.completeOAuth(
    { userId: 2, sessionId: second.session.id },
    "google",
    0,
    { refreshToken: "PRIVATE_REFRESH_SENTINEL", scopes: ["calendar.readonly"] },
  );
  const app = createApiApp({
    authentication: {
      sessions: createApiSessionService(sessions),
      tokens: {
        authenticate: async (token) =>
          token === "valid-pat"
            ? {
                tokenId: 1,
                userId: 1,
                profile: "administrator",
                scopes: ["time_entries:read"],
              }
            : null,
        issue: async () => {
          throw new Error("unused");
        },
        list: async () => [],
        revoke: async () => null,
      },
    },
    installApi: (api) => installCalendarConnectionRoutes(api, service),
  });
  const request = (
    token: string | null,
    path: string,
    body?: unknown,
    method?: string,
  ) =>
    app.request("https://owned.example/api/v1/calendar-connections" + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        origin: "https://owned.example",
        ...(token ? { cookie: `__Host-ezacto_session=${token}` } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  return { request, first, second, service, app };
};
it("native sessions see only their own safe status, and no token-paste or anonymous access exists", async () => {
  const f = await fixture();
  expect((await f.request(null, "")).status).toBe(401);
  expect(
    (await f.request(f.second.token, "/google/refresh", { past_days: 91 }))
      .status,
  ).toBe(422);
  expect(await (await f.request(f.first.token, "")).json()).toEqual({
    data: [],
  });
  const response = await f.request(f.second.token, "");
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain("PRIVATE");
  expect(text).not.toContain("sealed");
  expect(JSON.parse(text).data[0]).toMatchObject({
    provider: "google",
    status: "connected",
    available: false,
    cleanup_pending: false,
  });
  expect(
    (
      await f.request(f.second.token, "/google/refresh", {
        refresh_token: "UNWANTED",
      })
    ).status,
  ).toBe(422);
  expect((await f.request(f.second.token, "/google/refresh", {})).status).toBe(
    409,
  );
});
it("disconnect moves encrypted custody to unresolved cleanup while immediately disabling the local connection", async () => {
  const f = await fixture();
  expect(
    (await f.request(f.first.token, "/google", { generation: 1 }, "DELETE"))
      .status,
  ).toBe(409);
  expect(
    (await f.request(f.second.token, "/google", { generation: 1 }, "DELETE"))
      .status,
  ).toBe(204);
  const state = (await (await f.request(f.second.token, "")).json()) as {
    data: Array<{ status: string; cleanup_pending: boolean }>;
  };
  expect(state.data[0]).toMatchObject({
    status: "disconnected",
    cleanup_pending: true,
  });
  expect(
    db!.prepare("SELECT status FROM calendar_cleanup_obligations").all(),
  ).toEqual([{ status: "pending" }]);
  expect(
    JSON.stringify(
      db!.prepare("SELECT * FROM calendar_cleanup_obligations").all(),
    ),
  ).not.toContain("PRIVATE_REFRESH_SENTINEL");
  await expect(
    f.service.completeOAuth(
      { userId: 2, sessionId: f.second.session.id },
      "google",
      2,
      { refreshToken: "NEW_TOKEN", scopes: ["calendar.readonly"] },
    ),
  ).rejects.toThrow("busy");
});

it("only administrators see unresolved cleanup across old incarnations", async () => {
  const f = await fixture();
  await f.request(f.second.token, "/google", { generation: 1 }, "DELETE");
  db!
    .prepare(
      "UPDATE calendar_sync_instance SET nonce=lower(hex(randomblob(32)))",
    )
    .run();
  db!
    .prepare("UPDATE calendar_cleanup_obligations SET status='manual_required'")
    .run();
  db!.prepare("DELETE FROM calendar_connections").run();
  const call = (token: string | null) =>
    f.app.request("https://owned.example/api/v1/calendar-cleanup-status", {
      headers: {
        ...(token ? { cookie: `__Host-ezacto_session=${token}` } : {}),
      },
    });
  expect((await call(null)).status).toBe(401);
  expect((await call(f.second.token)).status).toBe(403);
  expect(
    (
      await f.app.request(
        "https://owned.example/api/v1/calendar-cleanup-status",
        { headers: { authorization: "Bearer valid-pat" } },
      )
    ).status,
  ).toBe(403);
  const response = await call(f.first.token);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    data: { pending: 0, manual_required: 1, revoked: 0 },
  });
  expect(await (await f.request(f.second.token, "")).json()).toEqual({
    data: [],
  });
});

it("cross-origin browser requests cannot disconnect a calendar", async () => {
  const f = await fixture();
  const response = await f.app.request(
    "https://owned.example/api/v1/calendar-connections/google",
    {
      method: "DELETE",
      headers: {
        origin: "https://foreign.example",
        cookie: `__Host-ezacto_session=${f.second.token}`,
        "content-type": "application/json",
      },
      body: '{"generation":1}',
    },
  );
  expect(response.status).toBe(403);
  expect(db!.prepare("SELECT status FROM calendar_connections").get()).toEqual({
    status: "connected",
  });
});
