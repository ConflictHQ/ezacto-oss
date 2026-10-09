export type AppleCleanupStatus =
  "not_linked" | "pending" | "revoked" | "manual_required";

/** Web owns encrypted server-held capabilities; native persistence never does. */
export interface AppleCleanupPort {
  /** Capture obligations only; never revoke remotely from this method. */
  begin(userId: number, deletionRequestId: string): Promise<void>;
  status(deletionRequestId: string): Promise<AppleCleanupStatus>;
}

export interface AppleWebCleanupPort extends AppleCleanupPort {
  /** Called only after successful local closure; retain evidence for safe retries. */
  perform(deletionRequestId: string): Promise<void>;
}

export function aggregateAppleCleanup(
  states: readonly AppleCleanupStatus[],
): AppleCleanupStatus {
  if (states.includes("manual_required")) return "manual_required";
  if (states.includes("pending")) return "pending";
  return states.includes("revoked") ? "revoked" : "not_linked";
}

export interface AppleGrantBinding {
  subject: string;
  origin: string;
  grantId: string;
  generation: number;
  eventId: string;
}

export interface AppleGrantProof extends AppleGrantBinding {
  type: "apple_grant";
  purpose: "sign-in" | "cleanup";
  nonce: string;
  challengeId: string;
  requestId?: string;
}

export interface AppleRevocationProof extends AppleGrantBinding {
  type: "apple_revocation";
  requestId: string;
  revokedAt: string;
}

/** No Apple token or service capability crosses this persistence boundary. */
export interface AppleLifecycleStore extends AppleCleanupPort {
  recordSignIn(
    input: AppleGrantBinding & { userId: number; now: string },
  ): Promise<boolean>;
  rebind(
    input: AppleGrantBinding & { requestId: string; now: string },
  ): Promise<boolean>;
  acceptRevocation(
    input: AppleRevocationProof & { now: string },
  ): Promise<boolean>;
  status(requestId: string): Promise<AppleCleanupStatus>;
  allowProof(now: string): Promise<boolean>;
}
