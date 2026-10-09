import {
  ACCOUNT_PRIVACY_FRAMEWORKS,
  type AccountPrivacyFramework,
} from "./privacy-frameworks.js";
export {
  ACCOUNT_PRIVACY_FRAMEWORKS,
  type AccountPrivacyFramework,
} from "./privacy-frameworks.js";

export const ACCOUNT_RETENTION_CATEGORIES = [
  "time_and_worker_attribution",
  "billing_and_payments",
  "audit_and_security",
  "legal_hold",
] as const;
export type AccountRetentionCategory =
  (typeof ACCOUNT_RETENTION_CATEGORIES)[number];

export interface AccountRetentionRule {
  category: AccountRetentionCategory;
  /** The operator's actual purpose/basis, not merely a selected law's name. */
  reason: string;
  /** Includes the trigger from which the operator calculates the period. */
  period: string;
  /** A follow-up target, never a representation that erasure already ran. */
  review_after_days: number;
}

export interface AccountRetentionPolicy {
  frameworks: AccountPrivacyFramework[];
  retained_records: AccountRetentionRule[];
  response_target_days: number;
  operator_contact: string;
  user_notice: string;
  backup_handling: string;
  acknowledged: true;
}

export interface AccountRetentionPolicyRecord {
  version: number;
  policy: AccountRetentionPolicy;
  publishedAt: string;
  publishedByUserId: number | null;
}

export interface AccountRetentionPolicyProblem {
  field: string;
  message: string;
}

export class AccountRetentionWriteError extends Error {
  constructor(readonly code: "stale_policy" | "administrator_required") {
    super(
      code === "stale_policy"
        ? "The policy changed. Reload it before saving."
        : "An active administrator must publish this policy.",
    );
    this.name = "AccountRetentionWriteError";
  }
}

export class AccountRetentionPolicyError extends Error {
  constructor(readonly problems: readonly AccountRetentionPolicyProblem[]) {
    super(
      "The operator erasure and retention policy is incomplete or invalid.",
    );
    this.name = "AccountRetentionPolicyError";
  }
}

/** Strict at every entry point, including operator tools bypassing the API. */
export function parseAccountRetentionPolicy(
  value: unknown,
): AccountRetentionPolicy {
  const problems: AccountRetentionPolicyProblem[] = [];
  const problem = (field: string, message: string): void => {
    problems.push({ field, message });
  };
  const object = (
    candidate: unknown,
    field: string,
  ): Record<string, unknown> => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      problem(field, "Must be an object.");
      return {};
    }
    return candidate as Record<string, unknown>;
  };
  const keys = (
    record: Record<string, unknown>,
    allowed: readonly string[],
    prefix = "",
  ): void => {
    for (const key of Object.keys(record)) {
      if (!allowed.includes(key)) problem(`${prefix}${key}`, "Unknown field.");
    }
  };
  const text = (candidate: unknown, field: string, maximum: number): string => {
    if (
      typeof candidate !== "string" ||
      candidate.trim().length === 0 ||
      candidate.length > maximum ||
      Array.from(candidate).some((character) => {
        const code = character.charCodeAt(0);
        return code === 127 || (code < 32 && ![9, 10, 13].includes(code));
      })
    ) {
      problem(
        field,
        `Provide non-empty text of at most ${maximum} characters.`,
      );
      return "";
    }
    return candidate.trim();
  };
  const days = (candidate: unknown, field: string, maximum: number): number => {
    if (
      typeof candidate !== "number" ||
      !Number.isSafeInteger(candidate) ||
      candidate < 1 ||
      candidate > maximum
    ) {
      problem(
        field,
        `Provide a whole number between 1 and ${maximum}. This setting does not override statutory deadlines.`,
      );
      return 1;
    }
    return candidate;
  };
  const input = object(value, "policy");
  keys(input, [
    "frameworks",
    "retained_records",
    "response_target_days",
    "operator_contact",
    "user_notice",
    "backup_handling",
    "acknowledged",
  ]);
  const frameworks: AccountPrivacyFramework[] = [];
  if (!Array.isArray(input.frameworks)) {
    problem(
      "frameworks",
      "Select applicable frameworks, or leave the list empty after reviewing applicability.",
    );
  } else {
    for (const candidate of input.frameworks) {
      if (
        !(ACCOUNT_PRIVACY_FRAMEWORKS as readonly unknown[]).includes(
          candidate,
        ) ||
        frameworks.includes(candidate as AccountPrivacyFramework)
      ) {
        problem("frameworks", "Use distinct supported framework identifiers.");
      } else frameworks.push(candidate as AccountPrivacyFramework);
    }
  }
  const retained_records: AccountRetentionRule[] = [];
  if (
    !Array.isArray(input.retained_records) ||
    input.retained_records.length > ACCOUNT_RETENTION_CATEGORIES.length
  ) {
    problem(
      "retained_records",
      "Provide the selected record categories, each with its reason, period and review interval.",
    );
  } else {
    for (const [index, candidate] of input.retained_records.entries()) {
      const prefix = `retained_records.${index}.`;
      const rule = object(candidate, `retained_records.${index}`);
      keys(rule, ["category", "reason", "period", "review_after_days"], prefix);
      const category = rule.category as AccountRetentionCategory;
      if (
        !ACCOUNT_RETENTION_CATEGORIES.includes(category) ||
        retained_records.some((entry) => entry.category === category)
      ) {
        problem(
          `${prefix}category`,
          "Select each supported category at most once.",
        );
      }
      retained_records.push({
        category,
        reason: text(rule.reason, `${prefix}reason`, 2000),
        period: text(rule.period, `${prefix}period`, 1000),
        review_after_days: days(
          rule.review_after_days,
          `${prefix}review_after_days`,
          365,
        ),
      });
    }
  }
  const operator_contact = text(
    input.operator_contact,
    "operator_contact",
    254,
  );
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(operator_contact)) {
    problem("operator_contact", "Provide an operator contact email address.");
  }
  if (input.acknowledged !== true) {
    problem(
      "acknowledged",
      "Confirm that the operator reviewed applicability, necessity, periods and user disclosures. Checkboxes do not establish legal compliance.",
    );
  }
  const result: AccountRetentionPolicy = {
    frameworks,
    retained_records,
    response_target_days: days(
      input.response_target_days,
      "response_target_days",
      90,
    ),
    operator_contact,
    user_notice: text(input.user_notice, "user_notice", 5000),
    backup_handling: text(input.backup_handling, "backup_handling", 5000),
    acknowledged: true,
  };
  if (problems.length > 0) throw new AccountRetentionPolicyError(problems);
  return result;
}
