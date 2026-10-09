import { describe, expect, it } from "vitest";
import {
  AccountRetentionPolicyError,
  parseAccountRetentionPolicy,
} from "../src/account-retention.js";

const policy = () => ({
  frameworks: ["gdpr", "california_ccpa_cpra", "texas_tdpsa", "us_florida"],
  retained_records: [
    {
      category: "time_and_worker_attribution",
      reason:
        "Necessary identified evidence supporting invoiced work and applicable accounting duties.",
      period:
        "Until the documented obligation for the associated invoice expires; review each case.",
      review_after_days: 90,
    },
  ],
  response_target_days: 14,
  operator_contact: "privacy@example.test",
  user_notice:
    "Account access and unnecessary personal data are removed. Required identified time and billing records are retained under this policy.",
  backup_handling:
    "Operator reviews each backup and restores only after replaying completed account closures.",
  acknowledged: true,
});

describe("operator account erasure and retention policy", () => {
  it("preserves explicit attribution, basis and retention rules without inferring a law or expiry", () => {
    const input = policy();
    expect(parseAccountRetentionPolicy(input)).toEqual(input);
    input.frameworks = [];
    expect(parseAccountRetentionPolicy(input).frameworks).toEqual([]);
  });

  it("accepts an explicit no-retained-category policy without inventing retention exceptions", () => {
    expect(
      parseAccountRetentionPolicy({ ...policy(), retained_records: [] })
        .retained_records,
    ).toEqual([]);
  });

  it.each([
    "acknowledged",
    "operator_contact",
    "user_notice",
    "backup_handling",
    "response_target_days",
  ])("requires %s before publication", (field) => {
    const input: Record<string, unknown> = policy();
    delete input[field];
    expect(() => parseAccountRetentionPolicy(input)).toThrow(
      AccountRetentionPolicyError,
    );
  });

  it.each(["reason", "period", "review_after_days"])(
    "refuses retained data without its %s",
    (field) => {
      const input = policy();
      delete (input.retained_records[0] as unknown as Record<string, unknown>)[
        field
      ];
      expect(() => parseAccountRetentionPolicy(input)).toThrow(
        AccountRetentionPolicyError,
      );
    },
  );

  it("rejects unsupported and duplicate categories/frameworks rather than broadening scope", () => {
    for (const patch of [
      { frameworks: ["all_laws"] },
      { frameworks: ["gdpr", "gdpr"] },
      {
        retained_records: [
          ...policy().retained_records,
          ...policy().retained_records,
        ],
      },
      {
        retained_records: [
          { ...policy().retained_records[0], category: "everything" },
        ],
      },
      { automaticCompliance: true },
    ])
      expect(() =>
        parseAccountRetentionPolicy({ ...policy(), ...patch }),
      ).toThrow(AccountRetentionPolicyError);
  });

  it("rejects invalid periods, acknowledgement and unsafe contact values", () => {
    for (const patch of [
      { response_target_days: 0 },
      { response_target_days: 1.5 },
      { response_target_days: "14" },
      { acknowledged: false },
      { acknowledged: "true" },
      {
        operator_contact: "privacy@example.test\r\nBCC: elsewhere@example.test",
      },
      {
        retained_records: [
          { ...policy().retained_records[0], review_after_days: 0 },
        ],
      },
      { retained_records: [{ ...policy().retained_records[0], period: "" }] },
    ])
      expect(() =>
        parseAccountRetentionPolicy({ ...policy(), ...patch }),
      ).toThrow(AccountRetentionPolicyError);
  });
});
