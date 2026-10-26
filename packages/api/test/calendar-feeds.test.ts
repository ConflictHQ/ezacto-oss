import { describe, it, expect, vi } from "vitest";
import { CalendarFeedError } from "@ezacto/core";
import { createApiApp } from "../src/app.js";
import {
  installCalendarFeedRoutes,
  installCalendarSubscriptionRoute,
} from "../src/calendar-feeds.js";
const id = "a".repeat(32),
  password = "b".repeat(43);
const feed = {
  id,
  scope: "self" as const,
  project_id: null,
  from_date: "2026-10-05",
  through_date: "2026-10-11",
  include_names: false,
  issued_at: "2026-10-05T00:00:00.000Z",
  expires_at: "2026-11-04T00:00:00.000Z",
  revoked_at: null,
  credential_generation: 1,
};
const fixture = () => {
  const service = {
    list: vi.fn(async () => [feed]),
    create: vi.fn(async () => ({ feed, username: id, password })),
    rotate: vi.fn(async () => ({ feed, username: id, password })),
    revoke: vi.fn(async () => {}),
    download: vi.fn(async () => "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"),
    subscribe: vi.fn(async () => "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"),
  };
  const app = createApiApp({
    authentication: {
      sessions: {
        resolve: async (request) =>
          request.headers.get("cookie") === "session=member"
            ? {
                type: "user" as const,
                userId: 3,
                profile: "member" as const,
                authentication: { kind: "session" as const, sessionId: "3" },
              }
            : null,
      },
    },
    installApi: (api) => installCalendarFeedRoutes(api, service),
    installApp: (app) => installCalendarSubscriptionRoute(app, service),
  });
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    extra: Record<string, string> = {},
  ) =>
    app.request(path, {
      method,
      headers: {
        cookie: "session=member",
        origin: "http://localhost",
        "content-type": "application/json",
        ...extra,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { service, app, request };
};
describe("calendar subscription HTTP boundary", () => {
  it("issues credentials only under a native session and exposes the explicit chosen scope", async () => {
    const f = fixture();
    const body = {
      scope: "self",
      project_id: null,
      from_date: "2026-10-05",
      through_date: "2026-10-11",
      include_names: false,
    };
    const response = await f.request("/api/v1/calendar-feeds", "POST", body);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(f.service.create).toHaveBeenCalledWith(
      { userId: 3, sessionId: 3 },
      body,
    );
    expect(((await response.json()) as {data:{password:string}}).data.password).toBe(password);
    expect(
      (await f.request("/api/v1/calendar-feeds", "POST", body, { cookie: "" }))
        .status,
    ).toBe(401);
    expect(
      (
        await f.request("/api/v1/calendar-feeds", "POST", body, {
          origin: "https://elsewhere.example",
        })
      ).status,
    ).toBe(403);
  });
  it('requires HTTPS outside loopback without challenging for a password over cleartext',async()=>{
    const f=fixture(),response=await f.app.request('http://calendar.example.test/calendar/planning.ics',{headers:{authorization:`Basic ${btoa(`${id}:${password}`)}`}})
    expect(response.status).toBe(404);expect(response.headers.has('www-authenticate')).toBe(false);expect(f.service.subscribe).not.toHaveBeenCalled()
  })
  it("downloads authenticated ICS as an attachment without shared-cache headers", async () => {
    const f = fixture(),
      response = await f.request(`/api/v1/calendar-feeds/${id}/download`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/calendar");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
  it("accepts credentials only in Basic authorization and never in URLs or ordinary account cookies", async () => {
    const f = fixture(),
      url = "/calendar/planning.ics";
    const unauth = await f.app.request(url, {
      headers: { cookie: "session=member" },
    });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("www-authenticate")).toContain("Basic");
    const ok = await f.app.request(url, {
      headers: { authorization: `Basic ${btoa(`${id}:${password}`)}` },
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    expect(f.service.subscribe).toHaveBeenCalledExactlyOnceWith(id, password);
    const bad = await f.app.request(`${url}?token=${password}`, {
      headers: { authorization: `Basic ${btoa(`${id}:${password}`)}` },
    });
    expect(bad.status).toBe(404);
    expect(await bad.text()).toBe("");
    expect(f.service.subscribe).toHaveBeenCalledTimes(1);
  });
  it.each(["not_found", "forbidden", "conflict", "invalid"] as const)(
    "returns no protected content after %s",
    async (code) => {
      const f = fixture();
      f.service.subscribe.mockRejectedValue(new CalendarFeedError(code));
      const r = await f.app.request("/calendar/planning.ics", {
        headers: {
          authorization: `Basic ${btoa(`${id}:${password}`)}`,
          "if-none-match": "old",
        },
      });
      expect(r.status).toBe(404);
      expect(await r.text()).toBe("");
      expect(r.headers.get("cache-control")).toBe("private, no-store");
      expect(r.headers.has("etag")).toBe(false);
    },
  );
  it("bounds authenticated feed reads with a retryable empty response", async () => {
    const f = fixture();
    f.service.subscribe.mockRejectedValue(
      new CalendarFeedError("rate_limited"),
    );
    const r = await f.app.request("/calendar/planning.ics", {
      headers: { authorization: `Basic ${btoa(`${id}:${password}`)}` },
    });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
    expect(await r.text()).toBe("");
  });
});
