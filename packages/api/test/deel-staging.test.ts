import { describe, it, expect, vi } from "vitest";
import { createApiApp } from "../src/app.js";
import {
  installDeelStagingRoutes,
  type DeelStagingApiRuntime,
} from "../src/deel-staging.js";
const selection = { from: "2026-10-01", to: "2026-10-20", user_ids: [2] };
const command = {
  ...selection,
  command_id: "a1234567-1234-4123-8123-123456789012",
  preview_fingerprint: "a".repeat(64),
};
const fixture = () => {
  const runtime = {
    configured: true,
    bounds: () => ({ from: "2026-10-01", to: "2026-10-25" }),
    preview: vi.fn(async () => ({
      status: "ready" as const,
      selection: { from: selection.from, to: selection.to, userIds: [2] },
      fingerprint: command.preview_fingerprint,
      entryIds: [1],
      seconds: 3600,
      timesheets: 1,
      alreadyStaged: 0,
      people: [{ userId: 2, contractId: "c2", seconds: 3600, entries: 1 }],
      conflicts: [],
      unsyncable: [],
      unmatched: [],
      unresolved: [],
    })),
    stage: vi.fn(async () => ({
      status: "staged" as const,
      commandId: command.command_id,
      runId: 1,
      timesheetsStaged: 1,
      entriesStaged: 1,
      alreadyStaged: 0,
      unresolved: [],
      code: null,
    })),
    lookup: vi.fn(async () => null),
  } satisfies DeelStagingApiRuntime;
  const app = createApiApp({
    authentication: {
      tokens: {
        authenticate: async () => null,
        issue: vi.fn(),
        list: vi.fn(),
        revoke: vi.fn(),
      },
      sessions: {
        resolve: async (request) => {
          const cookie = request.headers.get("cookie");
          return cookie === "session=admin" || cookie === "session=member"
            ? {
                type: "user" as const,
                userId: 1,
                profile:
                  cookie === "session=admin"
                    ? ("administrator" as const)
                    : ("member" as const),
                authentication: { kind: "session" as const, sessionId: "1" },
              }
            : null;
        },
      },
    },
    installApi(api) {
      installDeelStagingRoutes(api, runtime);
    },
  });
  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(`/api/v1/deel-staging/${path}`, {
      method: "POST",
      headers: {
        cookie: "session=admin",
        origin: "http://localhost",
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  return { app, runtime, post };
};
describe("Deel selected staging HTTP boundary", () => {
  it("returns only safe configured date bounds without provider work", async () => {
    const { app, runtime } = fixture();
    const response = await app.request("/api/v1/deel-staging", {
      headers: { cookie: "session=admin" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: {
        configured: true,
        reason: null,
        start_date: "2026-10-01",
        last_complete_date: "2026-10-25",
      },
    });
    expect(runtime.preview).not.toHaveBeenCalled();
    expect(runtime.stage).not.toHaveBeenCalled();
  });
  it("requires a current admin session and same-origin cookie mutation before provider work", async () => {
    const { post, runtime } = fixture();
    for (const headers of [
      { cookie: "session=member" },
      { cookie: "" },
      { origin: "https://elsewhere.example" },
      { origin: "" },
    ])
      expect(
        (await post("preview", selection, headers)).status,
      ).toBeGreaterThanOrEqual(400);
    expect(runtime.preview).not.toHaveBeenCalled();
  });
  it("requires exact UUID body/header and rejects unexpected amount/rate inputs", async () => {
    const { post, runtime } = fixture();
    expect((await post("commands", command)).status).toBe(422);
    expect(
      (await post("commands", command, { "Idempotency-Key": "another" }))
        .status,
    ).toBe(422);
    expect((await post("preview", { ...selection, amount: 100 })).status).toBe(
      422,
    );
    expect(runtime.stage).not.toHaveBeenCalled();
    const response = await post("commands", command, {
      "Idempotency-Key": command.command_id,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(runtime.stage).toHaveBeenCalledWith(
      { userId: 1, sessionId: 1 },
      {
        id: command.command_id,
        fingerprint: command.preview_fingerprint,
        from: selection.from,
        to: selection.to,
        userIds: [2],
      },
    );
    expect(await response.json()).toMatchObject({
      data: { status: "staged", entries_staged: 1 },
    });
  });
  it("uses status as a read-only reconciliation call without repeating stage", async () => {
    const { post, runtime } = fixture();
    expect((await post("status", command)).status).toBe(200);
    expect(runtime.lookup).toHaveBeenCalledOnce();
    expect(runtime.stage).not.toHaveBeenCalled();
  });
});
