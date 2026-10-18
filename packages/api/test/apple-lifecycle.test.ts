import { describe, expect, it, vi } from "vitest";
import type { AppleLifecycleStore, AppleRevocationProof } from "@ezacto/core";
import { createApiApp } from "../src/app.js";
import { installAppleLifecycleRoutes } from "../src/apple-lifecycle.js";
import { AppleProofUnavailable } from "../src/apple-lifecycle-proof.js";
const origin = "https://time.example.test";
const now = new Date("2026-10-09T00:00:00.000Z");
describe("proof-only Apple cleanup delivery", () => {
  const proof: AppleRevocationProof = {
    type: "apple_revocation",
    subject: "apple-subject",
    origin,
    grantId: "grant-one",
    generation: 12,
    eventId: "event-one",
    requestId: "request-one",
    revokedAt: now.toISOString(),
  };
  function harness() {
    const store: AppleLifecycleStore = {
      begin: vi.fn(async () => undefined),
      status: vi.fn(async () => "pending" as const),
      recordSignIn: vi.fn(async () => true),
      rebind: vi.fn(async () => true),
      acceptRevocation: vi.fn(async () => false),
      allowProof: vi.fn(async () => true),
    };
    const verifier = { verify: vi.fn(async () => proof) };
    const app = createApiApp({
      installApp: (app) =>
        installAppleLifecycleRoutes(app, {
          store,
          verifier,
          origin: () => origin,
          clock: () => now.toISOString(),
        }),
    });
    const call = (
      path = "revocation",
      body: unknown = { receipt: "signed-proof" },
    ) =>
      app.request(`/auth/apple/deletion-requests/request-one/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    return { store, verifier, call };
  }
  it("returns204 only after durable matching acceptance, and409 cannot be mistaken for ACK", async () => {
    const { store, call } = harness();
    const refused = await call();
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      error: { code: "receipt_not_accepted" },
    });
    vi.mocked(store.acceptRevocation).mockResolvedValue(true);
    const accepted = await call();
    expect(accepted.status).toBe(204);
    expect(accepted.headers.get("cache-control")).toBe("no-store");
    expect(store.acceptRevocation).toHaveBeenCalledWith({
      ...proof,
      now: now.toISOString(),
    });
  });
  it("never acknowledges lost persistence and returns a retryable opaque outage",async()=>{
    const {store,call}=harness();
    vi.mocked(store.acceptRevocation).mockRejectedValue(new Error("private SQL diagnostics"));
    const failed=await call();
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("private SQL");
    vi.mocked(store.allowProof).mockRejectedValue(new Error("private limiter failure"));
    expect((await call()).status).toBe(503);
  });
  it("does not accept a request mismatch or ordinary sign-in receipt as cleanup rebinding", async () => {
    const { store, verifier, call } = harness();
    verifier.verify.mockResolvedValue({
      ...proof,
      requestId: "different-request",
    });
    expect((await call()).status).toBe(409);
    expect(store.acceptRevocation).not.toHaveBeenCalled();
    const grant = {
      ...proof,
      type: "apple_grant" as const,
      purpose: "sign-in" as const,
      nonce: "nonce",
      challengeId: "challenge",
    };
    verifier.verify.mockResolvedValue(grant as never);
    expect((await call("binding")).status).toBe(409);
    expect(store.rebind).not.toHaveBeenCalled();
    verifier.verify.mockResolvedValue({
      ...grant,
      purpose: "cleanup",
    } as never);
    expect((await call("binding")).status).toBe(204);
  });
  it("separates invalid proof, key outages, bounded bodies and rate limits without requiring account access", async () => {
    const { store, verifier, call } = harness();
    verifier.verify.mockResolvedValue(null as never);
    expect((await call()).status).toBe(401);
    verifier.verify.mockRejectedValue(new AppleProofUnavailable());
    expect((await call()).status).toBe(503);
    expect(
      (await call("revocation", { receipt: "x".repeat(18000) })).status,
    ).toBe(413);
    expect(
      (
        await call("revocation", {
          receipt: "x",
          url: "https://attacker.example/keys",
        })
      ).status,
    ).toBe(422);
    vi.mocked(store.allowProof).mockResolvedValue(false);
    const limited = await call();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
  });
});
