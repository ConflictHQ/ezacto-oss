import {
  createTenantCredentialVault,
  type TenantCredentialVault,
} from "./tenant-credential-vault.js";

export const managedWiseLimits = {
  tokenLength: 4096,
  profileIdLength: 64,
  freshSessionMs: 15 * 60 * 1000,
} as const;
export interface ManagedWiseCredentials {
  token: string;
  profileId: string;
}
export type ManagedWiseAuthority =
  | { kind: "native-session"; userId: number; sessionId: number }
  | { kind: "guarded-session"; userId: number };
export type ManagedWiseConnectionStatus =
  "disconnected" | "configured" | "connected" | "unavailable";
export interface ManagedWiseConnectionState {
  generation: number;
  status: ManagedWiseConnectionStatus;
  profileId: string | null;
}
interface CommandBase {
  commandId: string;
  expectedActorUserId: number;
  expectedGeneration: number;
  fingerprint: string;
}
export type ManagedWiseCommand = CommandBase &
  (
    | { action: "connect"; profileId: string; sealed: string }
    | { action: "disconnect" }
  );
export interface ManagedWiseCommandResult extends ManagedWiseConnectionState {
  outcome: "applied" | "replayed";
}
export interface ManagedWiseConnectionStore {
  state(): Promise<ManagedWiseConnectionState>;
  prepare(
    authority: ManagedWiseAuthority,
    now: string,
  ): Promise<ManagedWiseConnectionState>;
  apply(
    command: ManagedWiseCommand,
    authority: ManagedWiseAuthority,
    now: string,
  ): Promise<ManagedWiseCommandResult>;
  readSealed(): Promise<
    (ManagedWiseConnectionState & { sealed: string }) | null
  >;
  recordHealth(
    generation: number,
    healthy: boolean,
    now: string,
  ): Promise<void>;
  erase(now: string): Promise<void>;
  inventory(): Promise<{ sealedCredentials: number; commandReceipts: number }>;
}
export class ManagedWiseConnectionError extends Error {
  constructor(readonly kind: "invalid" | "forbidden" | "conflict") {
    super(
      "The Wise connection or administrator authority changed. Restart from settings.",
    );
    this.name = "ManagedWiseConnectionError";
  }
}
export function validateManagedWiseCredentials(
  value: unknown,
): asserts value is ManagedWiseCredentials {
  const credentials = value as Partial<ManagedWiseCredentials> | null;
  if (
    !credentials ||
    typeof credentials !== "object" ||
    typeof credentials.token !== "string" ||
    !credentials.token ||
    credentials.token.length > managedWiseLimits.tokenLength ||
    /[\s\p{Cc}]/u.test(credentials.token) ||
    typeof credentials.profileId !== "string" ||
    !/^[1-9][0-9]{0,63}$/u.test(credentials.profileId)
  )
    throw new ManagedWiseConnectionError("invalid");
}
export type ManagedWiseVault = TenantCredentialVault<ManagedWiseCredentials>;
export const createManagedWiseVault = (options: {
  custodyKey: string;
  fingerprintKey: string;
  tenantBinding: string;
}): Promise<ManagedWiseVault> =>
  createTenantCredentialVault({
    ...options,
    purpose: "ezacto-managed-wise-read-credential",
    validate: validateManagedWiseCredentials,
    invalid: () => new ManagedWiseConnectionError("invalid"),
  });

export class ManagedWiseUnavailableError extends Error {
  constructor() {
    super(
      "The Wise connection is unavailable or changed. Reopen its settings.",
    );
    this.name = "ManagedWiseUnavailableError";
  }
}
