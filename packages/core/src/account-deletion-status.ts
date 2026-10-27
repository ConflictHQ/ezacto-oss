import type { CalendarCleanupStatus } from './calendar-connection.js'
import type { AppleCleanupStatus } from './apple-lifecycle.js'
import type {
  AccountRetentionPolicy,
  AccountRetentionRule,
} from "./account-retention.js";
import type { AccountDeletionStatus } from "./account-deletion.js";
export interface AccountDeletionStatusAccess {
  token: string;
  expires_at: string;
  url: string;
}
export interface AccountDeletionTrackingStatus {
  apple_cleanup?: AppleCleanupStatus;
  calendar_cleanup?: CalendarCleanupStatus;
  request_id: string;
  status: AccountDeletionStatus;
  requested_at: string;
  expected_completion_at: string | null;
  closed_at: string | null;
  completed_at: string | null;
  message: string;
  completion_confirmation: string | null;
  policy_version: number | null;
  policy_snapshot: AccountRetentionPolicy | null;
  policy_reviewed: boolean;
  closure_disclosure: null | {
    retained_records: (AccountRetentionRule & { review_due: string })[];
    backup_handling: string;
    user_notice: string;
    operator_contact: string;
  };
  operator_contact: string | null;
  expires_at: string;
}
export interface AccountDeletionStatusStore {
  issue(input: {
    requestId: string;
    userId: number;
    now: string;
  }): Promise<AccountDeletionStatusAccess>;
  read(input: {
    requestId: string;
    token: string;
    now: string;
  }): Promise<AccountDeletionTrackingStatus | null>;
  allowRead(now: string): Promise<boolean>;
}
