import { describe, expect, it, vi } from "vitest";
import { AccountRetentionWriteError } from "@ezacto/core";
import {
  createApiApp,
  installAccountRetentionRoutes,
  type AccountRetentionService,
} from "../src/index.js";

const at = "2026-10-09T00:00:00.000Z";
const policy = {
  frameworks: ["gdpr", "colorado_cpa"],
  retained_records: [],
  response_target_days: 14,
  operator_contact: "privacy@example.test",
  user_notice: "Ask our operator to close your account.",
  backup_handling: "Replay completed closures before using restored backups.",
  acknowledged: true,
};
function harness() {
  const service: AccountRetentionService = {
    read: vi.fn(async () => null),
    publish: vi.fn(async () => {
      throw new Error("unexpected write");
    }),
  };
  const app = createApiApp({
    authentication: {
      sessions: {
        resolve: async (request) => {
          const user = request.headers.get("cookie");
          return user === null
            ? null
            : {
                type: "user" as const,
                userId: 1,
                profile:
                  user === "admin"
                    ? ("administrator" as const)
                    : ("member" as const),
                authentication: { kind: "session" as const, sessionId: "1" },
              };
        },
      },
    },
    installApi: (api) =>
      installAccountRetentionRoutes(api, { service, clock: () => at }),
  });
  const publish = (
    body: unknown,
    cookie = "admin",
    origin = "http://localhost",
  ) =>
    app.request("/api/v1/admin/retention-policy", {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { app, service, publish };
}

describe("operator retention API", () => {
  it("requires authentication to read a policy, and reports an unconfigured instance honestly", async () => {
    const { app } = harness();
    expect((await app.request("/api/v1/profile/retention-policy")).status).toBe(
      401,
    );
    const response = await app.request("/api/v1/profile/retention-policy", {
      headers: { cookie: "member" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ data: null });
  });
  it("requires an administrator session and same-origin protection for publication", async () => {
    const { publish, service } = harness();
    expect(
      (await publish({ expected_version: 0, policy }, "member")).status,
    ).toBe(403);
    expect(
      (
        await publish(
          { expected_version: 0, policy },
          "admin",
          "https://elsewhere.example",
        )
      ).status,
    ).toBe(403);
    expect(service.publish).not.toHaveBeenCalled();
  });
  it.each([
    { expected_version: 0, policy: { ...policy, acknowledged: false } },
    { expected_version: 0, policy: { ...policy, unknown: "ignored?" } },
    { expected_version: -1, policy },
    { expected_version: 0, policy, unknown: true },
    {
      expected_version: 0,
      policy: { ...policy, retained_records: [{ category: "legal_hold" }] },
    },
  ])("rejects incomplete or unknown settings before a write", async (body) => {
    const { publish, service } = harness();
    expect((await publish(body)).status).toBe(422);
    expect(service.publish).not.toHaveBeenCalled();
  });
  it("publishes a validated policy with server-owned identity and timestamp", async () => {
    const { publish, service } = harness();
    vi.mocked(service.publish).mockImplementation(async (input) => ({
      version: 1,
      policy: input.policy as never,
      publishedAt: input.now,
      publishedByUserId: input.actorUserId,
    }));
    const response = await publish({ expected_version: 0, policy });
    expect(response.status).toBe(200);
    expect(service.publish).toHaveBeenCalledWith({
      expectedVersion: 0,
      actorUserId: 1,
      now: at,
      policy,
    });
    expect(await response.json()).toEqual({
      data: { version: 1, policy, published_at: at },
      links: { self: "/api/v1/profile/retention-policy" },
    });
  });
  it.each([
    ["stale_policy", 409],
    ["administrator_required", 403],
  ] as const)(
    "maps a repository %s refusal without silently overwriting a policy",
    async (code, status) => {
      const { publish, service } = harness();
      vi.mocked(service.publish).mockRejectedValue(
        new AccountRetentionWriteError(code),
      );
      const response = await publish({ expected_version: 0, policy });
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { code } });
    },
  );
});
