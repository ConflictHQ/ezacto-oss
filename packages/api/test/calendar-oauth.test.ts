import { expect, it, vi } from "vitest";
import { CalendarAuthorizationError } from "@ezacto/core";
import { createApiApp } from "../src/app.js";
import {
  installCalendarAuthorizationRoutes,
  type CalendarAuthorizationPort,
} from "../src/calendar-oauth.js";

const setup = () => {
  const port: CalendarAuthorizationPort = {
    begin: vi.fn(async () => ({
      requester: "R".repeat(43),
      authorizationUrl:
        "https://accounts.google.com/o/oauth2/v2/auth?state=owned",
    })),
    complete: vi.fn(async () => {}),
  };
  const app = createApiApp({
    authentication: {
      sessions: {
        resolve: async (request) =>
          request.headers.get("cookie")?.includes("session=owned")
            ? {
                type: "user",
                userId: 2,
                profile: "member",
                authentication: { kind: "session", sessionId: "10" },
              }
            : null,
      },
    },
    installApi: (api) => installCalendarAuthorizationRoutes(api, port),
  });
  const request = (
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request("https://owned.example/api/v1/calendar-connections" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie: "session=owned",
        origin: "https://owned.example",
        "content-type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { app, port, request };
};
it("starts only for a native same-origin session and exposes no requester secret in JSON", async () => {
  const f = setup();
  expect(
    (await f.request("/google/authorize", { generation: 0 }, { cookie: "" }))
      .status,
  ).toBe(401);
  expect(
    (
      await f.request(
        "/google/authorize",
        { generation: 0 },
        { origin: "https://foreign.example" },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await f.request("/google/authorize", {
        generation: 0,
        token: "not allowed",
      })
    ).status,
  ).toBe(422);
  const response = await f.request("/google/authorize", { generation: 0 });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    data: {
      authorization_url:
        "https://accounts.google.com/o/oauth2/v2/auth?state=owned",
    },
  });
  expect(response.headers.get("set-cookie")).toContain(
    "__Host-ezacto_calendar_google=",
  );
  for (const flag of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/"])
    expect(response.headers.get("set-cookie")).toContain(flag);
  expect(f.port.begin).toHaveBeenCalledOnce();
});
it("uses a fixed return path and clears only the successful provider cookie", async () => {
  const f = setup();
  const response = await f.request(
    "/google/callback?state=owned&code=owned&return_to=https://foreign.example",
    {},
    {},
  );
  // Only the GET callback exists.
  expect(response.status).toBe(404);
  const ok = await f.request(
    "/google/callback?state=owned&code=owned&return_to=https://foreign.example",
    undefined,
    {
      cookie: "session=owned; __Host-ezacto_calendar_google=" + "R".repeat(43),
    },
  );
  expect(ok.status).toBe(303);
  expect(ok.headers.get("location")).toBe(
    "/settings/user?calendar=connected&provider=google",
  );
  expect(ok.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(ok.headers.get("referrer-policy")).toBe("no-referrer");
  vi.mocked(f.port.complete).mockRejectedValueOnce(
    new CalendarAuthorizationError(),
  );
  const denied = await f.request(
    "/microsoft/callback?state=owned&error=access_denied&error_description=PRIVATE",
  );
  expect(denied.headers.get("location")).toBe(
    "/settings/user?calendar=failed&provider=microsoft",
  );
  expect(await denied.text()).not.toContain("PRIVATE");
});
