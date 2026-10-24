import type { ApplyCommand, ImportPreview } from "./contract.js";

/**
 * The review step's state: what the administrator has confirmed against which
 * preview. Pure, so the rules the plan gives for confirmation can be tested
 * without a server or a DOM.
 */
export interface Review {
  preview: ImportPreview;
  /** Signed-in administrator and role the preview was fetched under, as one string. */
  actor: string;
  rounding: boolean;
  partial: boolean;
  /** The count the reviewer typed or confirmed; null until they do. */
  excludedCount: number | null;
}

export const startReview = (preview: ImportPreview, actor: string): Review => ({
  preview,
  actor,
  rounding: false,
  partial: false,
  excludedCount: null,
});

/** Why apply is not yet allowed. Empty means the reviewer has done everything asked. */
export const blockers = (review: Review): string[] => {
  const { preview } = review;
  const reasons: string[] = [];
  if (preview.entries.rejected > 0) {
    if (!review.partial)
      reasons.push(
        "Rejected rows must be excluded as a partial run, or fixed.",
      );
    if (review.excludedCount !== preview.entries.rejected)
      reasons.push(`Confirm the ${preview.entries.rejected} excluded rows.`);
  }
  if (preview.seconds.source !== preview.seconds.rounded && !review.rounding)
    reasons.push("Acknowledge that rounded seconds differ from the source.");
  return reasons;
};

/** Throws rather than building a command the server would have to refuse. */
export const applyCommand = (review: Review): ApplyCommand => {
  const reasons = blockers(review);
  if (reasons.length > 0) throw new Error(reasons.join(" "));
  return {
    preview_id: review.preview.preview_id,
    acknowledgements: {
      rounding: review.rounding,
      partial: review.partial,
      excluded_count: review.excludedCount ?? 0,
    },
  };
};

/**
 * A different signed-in administrator, a signed-out session or a changed role
 * discards the review, so privileged state never outlives the session it was
 * fetched under. Returns null to discard.
 */
export const afterSessionChange = (
  review: Review,
  actor: string | null,
): Review | null => (actor === review.actor ? review : null);
