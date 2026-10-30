import type { CalendarProvider } from "./calendar-proposal.js";
import type {
  CalendarProposalSnapshot,
  CalendarSource,
  CalendarSyncAction,
  CalendarSyncWindow,
} from "./calendar-sync.js";

export interface CalendarCleanupStatus {
  pending: number;
  manual_required: number;
  revoked: number;
  /** Owner confirmation of manual permission removal; not provider verification. */
  manual_confirmed?: number;
  /** Administrator attestation of retained custody cleanup; not provider verification. */
  operator_confirmed?: number;
}
export interface CalendarConnectionAuthority {
  userId: number;
  sessionId: number;
}
export type CalendarConnectionState =
  "connected" | "needs_reauth" | "disconnected";
export type CalendarSyncFailure =
  | "credential_unavailable"
  | "authorization"
  | "unavailable"
  | "invalid_source"
  | "limit"
  | "changed";
export class CalendarConnectionError extends Error {
  constructor(
    readonly code:
      | "forbidden"
      | "changed"
      | "unavailable"
      | "invalid"
      | "busy"
      | "not_configured"
      | "not_connected"
      | "consent_required",
  ) {
    super(`Calendar connection ${code}.`);
    this.name = "CalendarConnectionError";
  }
}
export interface CalendarOAuthGrant {
  readonly refreshToken: string;
  readonly accessToken?: string;
  readonly expiresAt?: string;
  readonly scopes: readonly string[];
}
export interface CalendarCredentialIdentity {
  readonly instance: string;
  readonly userId: number;
  readonly provider: CalendarProvider;
  readonly generation: number;
  readonly credentialRevision: number;
}
export interface CalendarConnectionSummary {
  readonly provider: CalendarProvider;
  readonly state: CalendarConnectionState;
  readonly generation: number;
  readonly lastSyncedAt: string | null;
  readonly lastError: CalendarSyncFailure | null;
  readonly cleanupPending: boolean;
  readonly syncing: boolean;
}
export interface CalendarPrivateConnection extends CalendarCredentialIdentity {
  readonly state: CalendarConnectionState;
  readonly keyId: string | null;
  readonly sealedGrant: string | null;
  readonly sealedCursor: string | null;
  readonly window: CalendarSyncWindow | null;
}
export interface CalendarSyncLease extends CalendarPrivateConnection {
  readonly holder: string;
  readonly leaseGeneration: number;
}
export interface CalendarConnectionStore {
  instance(): Promise<string>;
  cleanupStatus(
    authority: CalendarConnectionAuthority,
    now: string,
  ): Promise<CalendarCleanupStatus>;
  list(
    authority: CalendarConnectionAuthority,
    now: string,
  ): Promise<readonly CalendarConnectionSummary[]>;
  authorize(authority: CalendarConnectionAuthority, now: string): Promise<void>;
  read(
    userId: number,
    provider: CalendarProvider,
  ): Promise<CalendarPrivateConnection | null>;
  connect(
    authority: CalendarConnectionAuthority,
    provider: CalendarProvider,
    expectedGeneration: number,
    credential: { instance: string; keyId: string; sealedGrant: string },
    now: string,
  ): Promise<void>;
  disconnect(
    authority: CalendarConnectionAuthority,
    provider: CalendarProvider,
    expectedGeneration: number,
    now: string,
    manualCleanup?: boolean,
  ): Promise<void>;
  snapshots(
    userId: number,
    provider: CalendarProvider,
    window: CalendarSyncWindow,
  ): Promise<ReadonlyMap<string, CalendarProposalSnapshot>>;
  claim(
    connection: CalendarPrivateConnection,
    holder: string,
    now: string,
    expiresAt: string,
  ): Promise<CalendarSyncLease | null>;
  rotate(
    lease: CalendarSyncLease,
    credential: {
      keyId: string;
      sealedGrant: string;
      sealedCursor: string | null;
    },
    now: string,
  ): Promise<CalendarSyncLease>;
  commit(
    lease: CalendarSyncLease,
    input: {
      actions: readonly CalendarSyncAction[];
      sealedCursor: string | null;
      window: CalendarSyncWindow;
    },
    now: string,
  ): Promise<void>;
  fail(
    lease: CalendarSyncLease,
    failure: CalendarSyncFailure,
    now: string,
  ): Promise<void>;
}
export interface CalendarGrantVault {
  readonly keyId: string;
  sealGrant(
    grant: CalendarOAuthGrant,
    identity: CalendarCredentialIdentity,
  ): Promise<string>;
  openGrant(
    envelope: string,
    identity: CalendarCredentialIdentity,
  ): Promise<CalendarOAuthGrant>;
  sealCursor(
    cursor: string,
    identity: CalendarCredentialIdentity,
  ): Promise<string>;
  openCursor(
    envelope: string,
    identity: CalendarCredentialIdentity,
  ): Promise<string>;
}
export type CalendarSourceFactory = (context: {
  readonly grant: CalendarOAuthGrant;
  readonly rotateGrant: (grant: CalendarOAuthGrant) => Promise<void>;
  readonly retainRejectedGrant?: (grant: CalendarOAuthGrant) => Promise<void>;
}) => Promise<CalendarSource>;

const encode = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const decode = (value: string) =>
  Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (char) => char.charCodeAt(0),
  );
const text = new TextEncoder();
const fail = (): never => {
  throw new CalendarConnectionError("invalid");
};
const bounded = (value: unknown, max: number): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= max &&
  text.encode(value).byteLength <= max &&
  !/\p{Cc}/u.test(value);
export const validateCalendarGrant = (value: unknown): CalendarOAuthGrant => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fail();
  const grant = value as CalendarOAuthGrant;
  if (
    !bounded(grant.refreshToken, 16384) ||
    (grant.accessToken !== undefined && !bounded(grant.accessToken, 16384)) ||
    (grant.expiresAt !== undefined &&
      (!bounded(grant.expiresAt, 40) ||
        !Number.isFinite(Date.parse(grant.expiresAt)))) ||
    !Array.isArray(grant.scopes) ||
    grant.scopes.length > 32 ||
    grant.scopes.some((scope) => !bounded(scope, 256)) ||
    Object.keys(grant).some(
      (key) =>
        !["refreshToken", "accessToken", "expiresAt", "scopes"].includes(key),
    )
  )
    return fail();
  return grant;
};
/** Dedicated HKDF purpose key; envelopes cannot cross user/provider/incarnation
 * or connection/credential generations. The deployment secret never enters SQL. */
export const createCalendarGrantVault = async (
  deploymentKey: Uint8Array,
): Promise<CalendarGrantVault> => {
  if (deploymentKey.length !== 32) return fail();
  const base = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(deploymentKey),
    "HKDF",
    false,
    ["deriveBits"],
  );
  const material = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(),
      info: text.encode("ezacto calendar oauth custody v1"),
    },
    base,
    256,
  );
  const key = await crypto.subtle.importKey(
    "raw",
    material,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  const keyId = encode(
    new Uint8Array(await crypto.subtle.digest("SHA-256", material)),
  ).slice(0, 32);
  const aad = (identity: CalendarCredentialIdentity, purpose: string) => {
    if (
      !/^[a-f0-9]{64}$/.test(identity.instance) ||
      !Number.isSafeInteger(identity.userId) ||
      identity.userId < 1 ||
      !["google", "microsoft"].includes(identity.provider) ||
      !Number.isSafeInteger(identity.generation) ||
      identity.generation < 1 ||
      !Number.isSafeInteger(identity.credentialRevision) ||
      identity.credentialRevision < 1
    )
      return fail();
    return text.encode(
      JSON.stringify({
        purpose: `calendar-${purpose}-v1`,
        keyId,
        instance: identity.instance,
        userId: identity.userId,
        provider: identity.provider,
        generation: identity.generation,
        credentialRevision: identity.credentialRevision,
      }),
    );
  };
  const seal = async (
    value: string,
    identity: CalendarCredentialIdentity,
    purpose: string,
  ) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad(identity, purpose) },
      key,
      text.encode(value),
    );
    return JSON.stringify({
      version: 1,
      keyId,
      iv: encode(iv),
      data: encode(new Uint8Array(encrypted)),
    });
  };
  const open = async (
    envelope: string,
    identity: CalendarCredentialIdentity,
    purpose: string,
  ) => {
    try {
      if (envelope.length > 65536) return fail();
      const value = JSON.parse(envelope);
      if (
        value.version !== 1 ||
        value.keyId !== keyId ||
        typeof value.iv !== "string" ||
        !/^[A-Za-z0-9_-]{16}$/.test(value.iv) ||
        typeof value.data !== "string" ||
        !/^[A-Za-z0-9_-]+$/.test(value.data) ||
        Object.keys(value).sort().join(",") !== "data,iv,keyId,version"
      )
        return fail();
      const clear = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: decode(value.iv),
          additionalData: aad(identity, purpose),
        },
        key,
        decode(value.data),
      );
      return new TextDecoder("utf-8", { fatal: true }).decode(clear);
    } catch {
      return fail();
    }
  };
  return {
    keyId,
    sealGrant: (grant, identity) =>
      seal(JSON.stringify(validateCalendarGrant(grant)), identity, "grant"),
    openGrant: async (envelope, identity) => {
      try {
        return validateCalendarGrant(
          JSON.parse(await open(envelope, identity, "grant")),
        );
      } catch {
        return fail();
      }
    },
    sealCursor: (cursor, identity) => {
      if (!bounded(cursor, 16384))
        return Promise.reject(new CalendarConnectionError("invalid"));
      return seal(cursor, identity, "cursor");
    },
    openCursor: async (envelope, identity) => {
      const value = await open(envelope, identity, "cursor");
      return bounded(value, 16384) ? value : fail();
    },
  };
};
