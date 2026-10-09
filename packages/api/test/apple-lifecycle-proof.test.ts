import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it, vi } from "vitest";
import {
  APPLE_LIFECYCLE_ISSUER,
  APPLE_LIFECYCLE_JWKS,
  AppleProofUnavailable,
  appleInstanceOrigin,
  createAppleLifecycleVerifier,
} from "../src/apple-lifecycle-proof.js";

const origin = "https://time.example.test";
const now = new Date("2026-10-09T00:00:00.000Z");
const epoch = Math.floor(now.valueOf() / 1000);
async function signing() {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const publicKey = {
    ...(await exportJWK(pair.publicKey)),
    kid: "fixture-key",
    alg: "ES256",
    use: "sig",
  };
  const fetcher = vi.fn(async (url: RequestInfo | URL) => {
    expect(String(url)).toBe(APPLE_LIFECYCLE_JWKS);
    return Response.json({ keys: [publicKey] });
  });
  const verifier = createAppleLifecycleVerifier({
    fetch: fetcher,
    now: () => now,
  });
  const claims = {
    iss: APPLE_LIFECYCLE_ISSUER,
    aud: origin,
    sub: "apple-subject",
    type: "apple_grant",
    purpose: "sign-in",
    grant_id: "grant-one",
    generation: 12,
    nonce: "nonce-one",
    challenge_id: "challenge-one",
    iat: epoch - 10,
    exp: epoch + 290,
    jti: "binding-one",
  };
  const sign = (changes: Record<string, unknown> = {}) =>
    new SignJWT({ ...claims, ...changes })
      .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: "fixture-key" })
      .sign(pair.privateKey);
  return { verifier, fetcher, sign, pair };
}

describe("fixed-trust Apple lifecycle proof", () => {
  it("verifies native grant and refreshed immutable revocation events against only the configured instance", async () => {
    const { verifier, fetcher, sign } = await signing();
    expect(await verifier.verify(await sign(), origin)).toMatchObject({
      type: "apple_grant",
      subject: "apple-subject",
      origin,
      purpose: "sign-in",
      generation: 12,
    });
    const event = {
      type: "apple_revocation",
      request_id: "request-one",
      status: "revoked",
      revoked_at: epoch - 100,
      jti: "event-one",
      exp: epoch + 86400,
    };
    const first = await verifier.verify(await sign(event), origin);
    const refreshed = await verifier.verify(
      await sign({ ...event, iat: epoch, exp: epoch + 86401 }),
      origin,
    );
    expect(first).toEqual(refreshed);
    expect(first).toMatchObject({
      type: "apple_revocation",
      requestId: "request-one",
      revokedAt: new Date((epoch - 100) * 1000).toISOString(),
      eventId: "event-one",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects wrong issuer/audience/type/time, noncanonical audiences, web channels and invalid purpose bindings", async () => {
    const { verifier, sign } = await signing();
    for (const change of [
      { iss: "https://attacker.example" },
      { aud: "https://other.example" },
      { aud: [origin, "https://other.example"] },
      { type: "not-a-grant" },
      { iat: epoch + 1 },
      { exp: epoch - 1 },
      { exp: epoch + 301 },
      { generation: 1.5 },
      { purpose: "cleanup" },
      { purpose: "sign-in", request_id: "unexpected" },
      { nonce: "" },
      { channel: "web", client_id: "com.ezacto.web" },
      { channel: "web" },
      { client_id: "com.ezacto.web" },
      {
        type: "apple_revocation",
        request_id: "request-one",
        status: "revoked",
        revoked_at: epoch + 1,
      },
    ])
      expect(await verifier.verify(await sign(change), origin)).toBeNull();
    expect(await verifier.verify("a".repeat(17000), origin)).toBeNull();
    expect(appleInstanceOrigin(origin + "/")).toBeNull();
    expect(
      appleInstanceOrigin("https://user:password@time.example.test"),
    ).toBeNull();
  });
  it("rejects untrusted signatures and algorithms while distinguishing fixed-key service outage", async () => {
    const { verifier, sign } = await signing();
    const other = await generateKeyPair("ES256");
    const good = await sign();
    const payload = JSON.parse(
      Buffer.from(good.split(".")[1]!, "base64url").toString(),
    );
    expect(
      await verifier.verify(
        await new SignJWT(payload)
          .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: "fixture-key" })
          .sign(other.privateKey),
        origin,
      ),
    ).toBeNull();
    expect(
      await verifier.verify(
        await new SignJWT(payload)
          .setProtectedHeader({ alg: "HS256", typ: "JWT", kid: "fixture-key" })
          .sign(new Uint8Array(32)),
        origin,
      ),
    ).toBeNull();
    const outage = createAppleLifecycleVerifier({
      now: () => now,
      fetch: async () => {
        throw new Error("private network diagnostic");
      },
    });
    await expect(outage.verify(good, origin)).rejects.toBeInstanceOf(
      AppleProofUnavailable,
    );
  });
});

