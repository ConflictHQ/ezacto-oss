import type {
  CalendarConnectionAuthority,
  CalendarCredentialIdentity,
} from "./calendar-connection.js";
import type { CalendarProvider } from "./calendar-proposal.js";

export interface CalendarOAuthAttempt {
  stateHash: string;
  requesterHash: string;
  authority: CalendarConnectionAuthority;
  provider: CalendarProvider;
  instance: string;
  generation: number;
}
export interface CalendarCleanupClaim extends CalendarCredentialIdentity {
  id: string;
  keyId: string;
  sealedGrant: string;
  holder: string;
}
export interface CalendarOAuthStore {
  manualCleanup(
    authority: CalendarConnectionAuthority,
  ): Promise<
    readonly {
      id: string;
      generation: number;
      credential_revision: number;
      reason: "disconnect" | "reauth";
      created_at: string;
    }[]
  >;
  confirmManualCleanup(
    authority: CalendarConnectionAuthority,
    input: { id: string; generation: number; credentialRevision: number },
    now: string,
  ): Promise<void>;
  begin(attempt: CalendarOAuthAttempt, expiresAt: string): Promise<void>;
  consume(
    authority: CalendarConnectionAuthority,
    provider: CalendarProvider,
    stateHash: string,
    requesterHash: string,
  ): Promise<CalendarOAuthAttempt | null>;
  orphan(
    attempt: CalendarOAuthAttempt,
    credential: CalendarCredentialIdentity & {
      keyId: string;
      sealedGrant: string;
    },
    now: string,
  ): Promise<void>;
  claimCleanup(
    keyId: string,
    holder: string,
    now: string,
  ): Promise<readonly CalendarCleanupClaim[]>;
  finishCleanup(
    claim: CalendarCleanupClaim,
    outcome: "revoked" | "manual_required" | "retry",
    now: string,
  ): Promise<void>;
  dueConnections(
    now: string,
  ): Promise<readonly { userId: number; provider: CalendarProvider }[]>;
}
