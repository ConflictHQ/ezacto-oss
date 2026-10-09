import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import type { AppleGrantProof, AppleRevocationProof } from "@ezacto/core";

export const APPLE_LIFECYCLE_ISSUER = "https://apple-auth.ezacto.com";
export const APPLE_LIFECYCLE_JWKS = `${APPLE_LIFECYCLE_ISSUER}/.well-known/jwks.json`;
export class AppleProofUnavailable extends Error {}
export type AppleLifecycleProof = AppleGrantProof | AppleRevocationProof;
export interface AppleLifecycleVerifier {
  verify(receipt: string, origin: string): Promise<AppleLifecycleProof | null>;
}

/** APP_BASE_URL, never an origin submitted by the client or forwarded headers. */
export function appleInstanceOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.origin === value &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
      ? value
      : null;
  } catch {
    return null;
  }
}

const compact = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const opaque = (value: unknown, max = 500): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  Array.from(value).every(character => character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127);
const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** Shared transport for separately validated native and web receipt channels. */
export function createAppleLifecycleKeySet(
  options: { fetch?: typeof fetch } = {},
) {
  const retrieve = options.fetch ?? fetch;
  return createRemoteJWKSet(new URL(APPLE_LIFECYCLE_JWKS), {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 10 * 60_000,
    [customFetch]: async (url, init) => {
      try {
        if (String(url) !== APPLE_LIFECYCLE_JWKS)
          throw new Error("Untrusted key URL");
        const response = await retrieve(url, { ...init, redirect: "error" });
        if (!response.ok || response.body === null)
          throw new Error("Key service unavailable");
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        try {
          while (true) {
            const result = await reader.read();
            if (result.done) break;
            length += result.value.length;
            if (length > 32_768) throw new Error("Key response too large");
            chunks.push(result.value);
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        return new Response(bytes, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      } catch {
        throw new AppleProofUnavailable(
          "Apple cleanup verification is temporarily unavailable",
        );
      }
    },
  });
}

export function createAppleLifecycleVerifier(
  options: {
    fetch?: typeof fetch;
    now?: () => Date;
  } = {},
): AppleLifecycleVerifier {
  const keys = createAppleLifecycleKeySet(options);
  return {
    async verify(receipt, origin) {
      if (
        !appleInstanceOrigin(origin) ||
        typeof receipt !== "string" ||
        receipt.length > 16_384 ||
        !compact.test(receipt)
      )
        return null;
      try {
        const now = options.now?.() ?? new Date();
        const { payload, protectedHeader } = await jwtVerify(receipt, keys, {
          algorithms: ["ES256"],
          issuer: APPLE_LIFECYCLE_ISSUER,
          audience: origin,
          requiredClaims: ["iss", "aud", "sub", "iat", "exp", "jti"],
          currentDate: now,
        });
        const seconds = Math.floor(now.valueOf() / 1000);
        if (
          payload.channel !== undefined ||
          payload.client_id !== undefined ||
          protectedHeader.typ !== "JWT" ||
          !opaque(protectedHeader.kid, 200) ||
          payload.aud !== origin ||
          !opaque(payload.sub) ||
          !opaque(payload.jti, 200) ||
          !opaque(payload.grant_id, 200) ||
          !positive(payload.generation) ||
          !positive(payload.iat) ||
          !positive(payload.exp) ||
          payload.iat > seconds ||
          payload.exp <= payload.iat
        )
          return null;
        const binding = {
          subject: payload.sub,
          origin,
          grantId: payload.grant_id,
          generation: payload.generation,
          eventId: payload.jti,
        };
        if (payload.type === "apple_grant") {
          if (
            payload.exp - payload.iat > 300 ||
            !opaque(payload.nonce, 200) ||
            !opaque(payload.challenge_id, 200) ||
            (payload.purpose !== "sign-in" && payload.purpose !== "cleanup") ||
            (payload.purpose === "sign-in"
              ? payload.request_id !== undefined
              : !opaque(payload.request_id, 100))
          )
            return null;
          return {
            ...binding,
            type: "apple_grant",
            purpose: payload.purpose,
            nonce: payload.nonce,
            challengeId: payload.challenge_id,
            ...(payload.purpose === "cleanup"
              ? { requestId: payload.request_id as string }
              : {}),
          };
        }
        if (
          payload.type !== "apple_revocation" ||
          payload.exp - payload.iat > 7 * 86400 ||
          payload.status !== "revoked" ||
          !opaque(payload.request_id, 100) ||
          !positive(payload.revoked_at) ||
          payload.revoked_at > payload.iat
        )
          return null;
        return {
          ...binding,
          type: "apple_revocation",
          requestId: payload.request_id,
          revokedAt: new Date(payload.revoked_at * 1000).toISOString(),
        };
      } catch (error) {
        if (
          error instanceof AppleProofUnavailable ||
          (error instanceof Error &&
            "code" in error &&
            error.code === "ERR_JWKS_TIMEOUT")
        )
          throw new AppleProofUnavailable(
            "Apple cleanup verification is temporarily unavailable",
          );
        return null;
      }
    },
  };
}
