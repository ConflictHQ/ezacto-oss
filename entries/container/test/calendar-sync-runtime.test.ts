import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { afterEach, expect, it } from "vitest";
import {
  createContainerRuntime,
  type ContainerRuntime,
} from "../src/runtime.js";
import { createRuntimeServices } from "../../worker/src/runtime.js";
import { createApp, type RuntimeServices } from "../../worker/src/app.js";
import {
  createContainerDatabase,
  createD1Database,
} from "../../../packages/db/src/adapters.js";
import {
  createContainerSessionStore,
  createD1SessionStore,
} from "../../../packages/db/src/sessions.js";
import { createCalendarConnectionStore } from "../../../packages/db/src/calendar-connections.js";
import { createCalendarSyncService } from "../../../packages/integrations/src/calendar-sync.js";
import type { CalendarSourceFactory } from "@ezacto/core";
let runtime: ContainerRuntime | undefined,
  mf: Miniflare | undefined,
  root: string | undefined;
afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  await mf?.dispose();
  mf = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});
for (const kind of ["container", "worker"] as const)
  it(`${kind}: actual runtime mounts current-session calendar sync through the durable store`, async () => {
    const key = new Uint8Array(32).fill(7),
      at = new Date(),
      event = {
        calendarId: "owned-primary",
        eventId: "owned-event",
        occurrence: "",
        summary: "Owned fixture meeting",
        startsAt: new Date(at.getTime() - 7200000).toISOString(),
        endsAt: new Date(at.getTime() - 3600000).toISOString(),
        allDay: false,
        cancelled: false,
        response: "accepted" as const,
        showAs: "busy" as const,
        version: "v1",
      };
    let reads = 0;
    const source: CalendarSourceFactory = async () => ({
      provider: "google",
      listEvents: async () => {
        reads++;
        return { events: [event], nextPage: null, nextCursor: "OWNED_CURSOR" };
      },
    });
    let services: RuntimeServices,
      run: (sql: string, ...params: unknown[]) => Promise<void>,
      count: () => Promise<number>,
      issued: { token: string; session: { id: number } },
      store: ReturnType<typeof createCalendarConnectionStore>;
    if (kind === "container") {
      root = await realpath(
        await mkdtemp(join(tmpdir(), "ezacto-calendar-runtime-")),
      );
      runtime = await createContainerRuntime(
        {
          host: "127.0.0.1",
          port: 3000,
          trustedProxyHops: 0,
          dataDirectory: root,
          databasePath: join(root, "db.sqlite"),
          attachmentDirectory: join(root, "attachments"),
          brandDirectory: join(root, "brand"),
          appBaseUrl: "https://owned.example",
          cursorSigningKey: key,
          smtp: { url: "smtp://127.0.0.1:2525", from: "owned@example.test" },
          appEnv: {
            ENVIRONMENT: "test-container",
            RELEASE: "owned-calendar",
            APP_BASE_URL: "https://owned.example",
          },
        },
        {
          calendarSources: { google: source },
          emailProvider: {
            name: "owned",
            send: async () => ({ messageId: "owned" }),
          },
          verifyEmailProvider: async () => {},
        },
      );
      services = runtime.services;
      const raw = runtime.database;
      run = async (sql, ...params) => {
        raw.prepare(sql).run(...params);
      };
      count = async () =>
        (
          raw.prepare("SELECT count(*) AS n FROM calendar_proposals").get() as {
            n: number;
          }
        ).n;
      await run(
        "INSERT INTO organizations(id,name,modules,created_at,updated_at) VALUES(1,'Owned','{}',?,?)",
        at.toISOString(),
        at.toISOString(),
      );
      await run(
        "INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(2,'Owned','Member','member','[]',?,?)",
        at.toISOString(),
        at.toISOString(),
      );
      issued = await createContainerSessionStore(raw).issue(2);
      store = createCalendarConnectionStore(createContainerDatabase(raw));
    } else {
      mf = new Miniflare({
        modules: true,
        script: 'export default {fetch(){return new Response("ok")}}',
        d1Databases: ["DB"],
      });
      const raw = await mf.getD1Database("DB");
      services = await createRuntimeServices(
        {
          DB: raw,
          API_CURSOR_SIGNING_KEY: btoa(String.fromCharCode(...key))
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replaceAll("=", ""),
          ENVIRONMENT: "test",
          RELEASE: "owned-calendar",
          APP_BASE_URL: "https://owned.example",
        },
        { calendarSources: { google: source } },
      );
      run = async (sql, ...params) => {
        await raw
          .prepare(sql)
          .bind(...params)
          .run();
      };
      count = async () =>
        Number(
          (
            await raw
              .prepare("SELECT count(*) AS n FROM calendar_proposals")
              .first<{ n: number }>()
          )?.n,
        );
      await run(
        "INSERT INTO organizations(id,name,modules,created_at,updated_at) VALUES(1,'Owned','{}',?,?)",
        at.toISOString(),
        at.toISOString(),
      );
      await run(
        "INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(2,'Owned','Member','member','[]',?,?)",
        at.toISOString(),
        at.toISOString(),
      );
      issued = await createD1SessionStore(raw).issue(2);
      store = createCalendarConnectionStore(createD1Database(raw));
    }
    await (
      await createCalendarSyncService({ store, deploymentKey: key })
    ).completeOAuth({ userId: 2, sessionId: issued.session.id }, "google", 0, {
      refreshToken: "OWNED_PRIVATE_REFRESH",
      scopes: ["calendar.readonly"],
    });
    const app = createApp(services),
      headers = {
        origin: "https://owned.example",
        cookie: `__Host-ezacto_session=${issued.token}`,
        "content-type": "application/json",
      };
    const response = await app.request(
      "https://owned.example/api/v1/calendar-connections/google/refresh",
      { method: "POST", headers, body: "{}" },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { state: "connected", applied: 1 },
    });
    expect(reads).toBe(1);
    expect(await count()).toBe(1);
  }, 60000);
