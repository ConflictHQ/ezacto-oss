/** Bounds of the canonical Deel connection row (migration 0159). */
export const managedDeelLimits = {
  tokenLength: 4096,
  /** A credential or start-date change needs a sign-in this recent. */
  freshSessionMs: 15 * 60 * 1000,
} as const;

export type ManagedDeelAuthority =
  | { kind: "native-session"; userId: number; sessionId: number }
  | { kind: "guarded-session"; userId: number };

export interface ManagedDeelState {
  /** Opaque lifecycle counter; connect, rotate and disconnect each advance it. */
  generation: number;
  connected: boolean;
  /** The first day whose time may be sent; null while disconnected. */
  startDate: string | null;
  connectedAt: string | null;
  connectedByUserId: number | null;
}

export interface ManagedDeelConnectCommand {
  expectedActorUserId: number;
  expectedGeneration: number;
  token: string;
  /** ISO calendar date. Time before it is never sent. */
  startDate: string;
}

export interface ManagedDeelDisconnectCommand {
  expectedActorUserId: number;
  expectedGeneration: number;
}

/** The state read never contains the token; nothing here can echo it. */
export interface ManagedDeelConnectionStore {
  state(
    authority: ManagedDeelAuthority,
    now: string,
  ): Promise<ManagedDeelState>;
  /** Connects, or rotates the token and start date of the live connection. */
  connect(
    command: ManagedDeelConnectCommand,
    authority: ManagedDeelAuthority,
    now: string,
  ): Promise<ManagedDeelState>;
  /** Erases the token. Advances the generation even when nothing was connected. */
  disconnect(
    command: ManagedDeelDisconnectCommand,
    authority: ManagedDeelAuthority,
    now: string,
  ): Promise<ManagedDeelState>;
}

export class ManagedDeelConnectionError extends Error {
  constructor(readonly kind: "invalid" | "forbidden" | "conflict") {
    super(
      "The Deel connection or administrator authority changed. Reopen the settings and retry.",
    );
    this.name = "ManagedDeelConnectionError";
  }
}
