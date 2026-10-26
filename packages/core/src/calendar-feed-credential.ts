import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export const calendarFeedDefaultLifetimeMs = 30 * 86400000;
export const calendarFeedMaximumLifetimeMs = 90 * 86400000;
const hex64 = (value: string) => /^[a-f0-9]{64}$/.test(value);
export const isCalendarFeedId = (value: string) => /^[a-f0-9]{32}$/.test(value);
const isPassword = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);
const encode = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
export const createCalendarFeedSecret = () => ({
  id: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
  password: encode(crypto.getRandomValues(new Uint8Array(32))),
  namespace: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
});
const key = async (instanceNonce: string) => {
  if (!hex64(instanceNonce))
    throw new Error("Invalid calendar credential context.");
  return crypto.subtle.importKey(
    "raw",
    new Uint8Array(hexToBytes(instanceNonce)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
};
const message = (id: string, password: string) =>
  new TextEncoder().encode(
    JSON.stringify(["planning-calendar-password@1", id, password]),
  );
/** A per-instance, per-feed keyed hash of a 256-bit random password. Never
 * accepts an ordinary account/sign-in password or stores recoverable material. */
export const hashCalendarFeedPassword = async (
  instanceNonce: string,
  id: string,
  password: string,
): Promise<string> => {
  if (!isCalendarFeedId(id) || !isPassword(password))
    throw new Error("Invalid calendar credential context.");
  return bytesToHex(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        await key(instanceNonce),
        message(id, password),
      ),
    ),
  );
};
export const verifyCalendarFeedPassword = async (
  instanceNonce: string,
  id: string,
  password: string,
  expectedHash: string,
): Promise<boolean> => {
  if (
    !hex64(instanceNonce) ||
    !isCalendarFeedId(id) ||
    !isPassword(password) ||
    !hex64(expectedHash)
  )
    return false;
  return crypto.subtle.verify(
    "HMAC",
    await key(instanceNonce),
    new Uint8Array(hexToBytes(expectedHash)),
    message(id, password),
  );
};
/** RFC7617 Basic only. The nonsecret feed ID is the username, never URL userinfo.
 * All accepted characters are ASCII; malformed or oversized input stays private. */
export const parseCalendarFeedAuthorization = (
  header: string | null,
): { id: string; password: string } | null => {
  if (header === null || header.length > 256) return null;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header);
  if (!match) return null;
  try {
    const decoded = atob(match[1]!);
    if (btoa(decoded) !== match[1]) return null;
    const colon = decoded.indexOf(":");
    if (colon < 0) return null;
    const id = decoded.slice(0, colon),
      password = decoded.slice(colon + 1);
    return isCalendarFeedId(id) && isPassword(password)
      ? { id, password }
      : null;
  } catch {
    return null;
  }
};
export const calendarFeedExpiry = (now: Date, requested?: string): string => {
  const instant = now.getTime(),
    expires =
      requested === undefined
        ? instant + calendarFeedDefaultLifetimeMs
        : Date.parse(requested);
  if (
    !Number.isFinite(instant) ||
    !Number.isFinite(expires) ||
    expires <= instant ||
    expires - instant > calendarFeedMaximumLifetimeMs ||
    (requested !== undefined && new Date(expires).toISOString() !== requested)
  )
    throw new Error("Calendar expiry must be within 90 days.");
  return new Date(expires).toISOString();
};
