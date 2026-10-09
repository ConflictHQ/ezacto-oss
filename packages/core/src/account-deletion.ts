import type { AccountRetentionPolicy } from "./account-retention.js";

export type AccountDeletionStatus =
  "pending" | "in_progress" | "action_required" | "completed";
export type AccountDeletionNotification =
  "pending" | "sending" | "queued" | "failed" | "unavailable";

/** No copied name/email: identity stays in the existing, access-controlled user directory. */
export interface AccountDeletionRecord {
  id: string;
  user_id: number;
  requested_at: string;
  policy_version: number | null;
  policy_snapshot: AccountRetentionPolicy | null;
  /** True only when the caller explicitly supplied the version they reviewed. */
  policy_reviewed: boolean;
  status: AccountDeletionStatus;
  version: number;
  message: string;
  response_target_at: string | null;
  expected_completion_at: string | null;
  completed_at: string | null;
  completion_confirmation: string | null;
  notification: AccountDeletionNotification;
  notification_updated_at: string;
  notification_delivery_id: number | null;
  updated_at: string;
}

export class AccountDeletionError extends Error {
  constructor(
    readonly code:
      | "stale_policy"
      | "stale_request"
      | "administrator_required"
      | "account_unavailable"
      | "request_not_found"
      | "request_completed"
      | "notification_busy",
  ) {
    super(
      {
        stale_policy:
          "The operator policy changed. Review the current policy before submitting.",
        stale_request: "This request changed. Reload before saving.",
        administrator_required:
          "An active administrator must manage deletion requests.",
        account_unavailable: "The requesting account is unavailable.",
        request_not_found: "The deletion request was not found.",
        request_completed: "A completed request cannot be edited.",
        notification_busy:
          "This notification cannot be retried now. Check its current delivery status and any suppression first.",
      }[code],
    );
    this.name = "AccountDeletionError";
  }
}

export interface AccountDeletionUpdate {
  id: string;
  actorUserId: number;
  expectedVersion: number;
  status: Exclude<AccountDeletionStatus, "completed">;
  message: string;
  expectedCompletionAt: string | null;
  now: string;
}

export interface AccountDeletionStore {
  request(input: {
    userId: number;
    id: string;
    now: string;
    expectedPolicyVersion?: number | null;
  }): Promise<{ record: AccountDeletionRecord; created: boolean }>;
  readOwn(userId: number): Promise<AccountDeletionRecord | null>;
  list(
    actorUserId: number,
    after: string | null,
  ): Promise<AccountDeletionRecord[]>;
  readAdmin(actorUserId: number, id: string): Promise<AccountDeletionRecord>;
  update(input: AccountDeletionUpdate): Promise<AccountDeletionRecord>;
  claimNotification(
    id: string,
    actorUserId: number,
    now: string,
  ): Promise<boolean>;
  finishNotification(
    id: string,
    claimedAt: string,
    outcome: Exclude<AccountDeletionNotification, "pending" | "sending">,
    deliveryId: number | null,
  ): Promise<void>;
  notificationRecipients(
    id: string,
  ): Promise<{
    person: { name: string; email: string | null };
    administrators: string[];
  }>;
}

/** Allow normal multiline prose while refusing hidden control bytes. */
export const hasAccountDeletionControlCharacters = (text: string): boolean =>
  Array.from(text).some((character) => {
    const code = character.charCodeAt(0)
    return code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13)
  })
