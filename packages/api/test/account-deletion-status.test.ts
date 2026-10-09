import { describe, expect, it, vi } from "vitest";
import type { AccountDeletionStatusStore } from "@ezacto/core";
import {
  createApiApp,
  installAccountDeletionStatusRoutes,
} from "../src/index.js";
function harness() {
  const store: AccountDeletionStatusStore = {
    issue: vi.fn(async () => {
      throw new Error("not used");
    }),
    read: vi.fn(async () => null),
    allowRead: vi.fn(async () => true),
  };
  const app = createApiApp({
    installApp: (app) =>
      installAccountDeletionStatusRoutes(app, {
        store,
        clock: () => "2026-10-09T00:00:00.000Z",
      }),
  });
  const call = (body: unknown) =>
    app.request("/account-deletion/requests/request-1/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return { app, store, call };
}
describe("private deletion tracking", () => {
  it("needs only the scoped token and gives a generic unavailable result with no cache", async () => {
    const { app, store, call } = harness();
    const response = await call({ token: "ezacto_deletion_" + "a".repeat(64) });
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      error: { code: "tracking_unavailable" },
    });
    expect(store.read).toHaveBeenCalledWith({
      requestId: "request-1",
      token: "ezacto_deletion_" + "a".repeat(64),
      now: "2026-10-09T00:00:00.000Z",
    });
    expect(
      (
        await app.request("/api/v1/whoami", {
          headers: {
            authorization: "Bearer ezacto_deletion_" + "a".repeat(64),
          },
        })
      ).status,
    ).toBe(401);
  });
  it("bounds bodies, rejects extra fields and limits reads before looking up a request", async () => {
    const { store, call } = harness();
    expect((await call({ token: "a".repeat(600) })).status).toBe(413);
    expect((await call({ token: "small", user_id: 2 })).status).toBe(422);
    expect(store.read).not.toHaveBeenCalled();
    vi.mocked(store.allowRead).mockResolvedValue(false);
    const response = await call({ token: "small" });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(store.read).not.toHaveBeenCalled();
  });
});
