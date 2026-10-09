import type {
  AccountRetentionCategory,
  AccountRetentionPolicy,
} from "./account-retention.js";

export interface AccountClosureInventoryItem {
  location: string;
  count: number;
  category: AccountRetentionCategory;
}
export interface AccountClosureRecord {
  request_id: string;
  user_id: number;
  actor_user_id: number;
  closed_at: string;
  policy_version: number;
  policy_snapshot: AccountRetentionPolicy;
  inventory: AccountClosureInventoryItem[];
  retained_identity: boolean;
  apple_cleanup: "not_linked" | "pending";
}
export interface AccountClosurePreview {
  request_id: string;
  user_id: number;
  request_version: number;
  review_token: string;
  policy_version: number | null;
  policy_snapshot: AccountRetentionPolicy | null;
  inventory: AccountClosureInventoryItem[];
  uncovered_categories: AccountRetentionCategory[];
  owner_transfer_required: boolean;
  running_timer: boolean;
  closure: AccountClosureRecord | null;
}
export class AccountClosureError extends Error {
  constructor(
    readonly code:
      | "administrator_required"
      | "request_not_found"
      | "stale_request"
      | "stale_policy"
      | "retention_review_required"
      | "owner_transfer_required"
      | "concurrent_change"
      | "running_timer",
  ) {
    super(
      {
        administrator_required:
          "An active administrator must close this account.",
        request_not_found: "The deletion request was not found.",
        stale_request:
          "The request changed. Reload before closing the account.",
        stale_policy:
          "Publish and review the current operator policy before closing the account.",
        retention_review_required:
          "Review a documented retention basis for each remaining record category before closing the account.",
        owner_transfer_required:
          "The current owner must transfer ownership before account closure.",
        running_timer:
          "Stop the running timer before closing this account so recorded work has a final duration.",
        concurrent_change:
          "Account data changed during review. Reload before closing the account.",
      }[code],
    );
    this.name = "AccountClosureError";
  }
}
export interface AccountClosureInput {
  actorUserId: number;
  id: string;
  expectedVersion: number;
  reviewToken: string;
  expectedPolicyVersion: number;
  now: string;
  acknowledged: true;
}
export interface AccountClosureStore {
  preview(actorUserId: number, id: string): Promise<AccountClosurePreview>;
  close(input: AccountClosureInput): Promise<AccountClosureRecord>;
}
