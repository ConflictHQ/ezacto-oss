import type { AccountRetentionCategory } from "./account-retention.js";

export const retentionCleanupAreas = [
  "documents_and_notes",
  "attachments",
  "email_copies",
  "integrations_and_exports",
  "backups",
  "restore_safeguards",
  "apple_authorization",
] as const;
export type RetentionReviewArea =
  AccountRetentionCategory | (typeof retentionCleanupAreas)[number];
export type RetentionDecision =
  | "pending"
  | "retain"
  | "removed"
  | "not_applicable"
  | "failed"
  | "release_hold";
export interface RetentionObligation {
  request_id: string;
  area: RetentionReviewArea;
  kind: "retained_category" | "downstream";
  original_reason: string;
  original_period: string;
  decision: RetentionDecision;
  basis: string;
  release_condition: string;
  evidence: string;
  next_review_at: string | null;
  hold_active: boolean;
  version: number;
  reviewed_at: string | null;
  actor_user_id: number | null;
}
export interface RetentionReviewChange {
  requestId: string;
  area: RetentionReviewArea;
  actorUserId: number;
  expectedVersion: number;
  decision: Exclude<RetentionDecision, "pending">;
  basis: string;
  releaseCondition: string;
  evidence: string;
  nextReviewAt: string | null;
  acknowledged: true;
  now: string;
}
export class RetentionReviewError extends Error {
  constructor(
    readonly code:
      | "administrator_required"
      | "closure_required"
      | "review_changed"
      | "review_incomplete"
      | "hold_release_required"
      | "invalid_review",
  ) {
    super(
      {
        administrator_required:
          "An active administrator must review retained records.",
        closure_required:
          "Close local access before reviewing remaining cleanup.",
        review_changed: "This review changed. Reload before saving.",
        review_incomplete:
          "Resolve failed, pending or overdue obligations before confirming the request outcome.",
        hold_release_required:
          "Record the explicit legal-hold release before marking held data removed.",
        invalid_review:
          "Supply current evidence, basis and a valid future review date where required.",
      }[code],
    );
  }
}
export interface AccountRetentionReviewStore {
  list(
    actorUserId: number,
    now: string,
    after?: string,
  ): Promise<RetentionObligation[]>;
  read(actorUserId: number, requestId: string): Promise<RetentionObligation[]>;
  review(input: RetentionReviewChange): Promise<RetentionObligation>;
  complete(input: {
    actorUserId: number;
    requestId: string;
    expectedRequestVersion: number;
    expectedReviews: Readonly<Record<string, number>>;
    now: string;
    acknowledged: true;
    appleResolved: boolean;
  }): Promise<{ completed_at: string; confirmation: string }>;
}
