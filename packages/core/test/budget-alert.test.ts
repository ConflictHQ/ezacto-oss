import { describe, expect, it } from "vitest";
import {
  budgetThresholdCrossed,
  budgetUsedPercent,
  composeBudgetAlert,
  type BudgetAlertMessageInput,
} from "../src/budget-alert.js";

describe("budget threshold (issue 934)", () => {
  it("[unit] is crossed exactly at the line, not a hair before", () => {
    expect(budgetThresholdCrossed(84, 100, 85)).toBe(false);
    expect(budgetThresholdCrossed(85, 100, 85)).toBe(true);
    // 0.85 * 3 is not exactly 2.55 in floating point; cross-multiplying is.
    expect(budgetThresholdCrossed(255, 300, 85)).toBe(true);
    expect(budgetThresholdCrossed(254, 300, 85)).toBe(false);
  });

  it("[unit] reads an unset threshold as 100% and never alerts on no budget", () => {
    expect(budgetThresholdCrossed(99, 100, null)).toBe(false);
    expect(budgetThresholdCrossed(100, 100, null)).toBe(true);
    expect(budgetThresholdCrossed(5, null, 50)).toBe(false);
    expect(budgetThresholdCrossed(5, 0, 50)).toBe(false);
    expect(budgetThresholdCrossed(0, 0, 0)).toBe(false);
  });

  it("[unit] reports the percent used rounded down, so the mail never claims more than is true", () => {
    expect(budgetUsedPercent(8499, 10000)).toBe(84);
    expect(budgetUsedPercent(12000, 10000)).toBe(120);
  });
});

const input = (over: Partial<BudgetAlertMessageInput> = {}): BudgetAlertMessageInput => ({
  companyName: "CONFLICT",
  projectName: "Site survey",
  clientName: "Kestrel Environmental",
  unit: "seconds",
  budgetAmount: 360_000,
  spentAmount: 324_000,
  thresholdPercent: 85,
  period: "lifetime",
  currency: "USD",
  amountsVisible: true,
  basis: "hours",
  ...over,
});

describe("budget alert message (issue 934)", () => {
  it("[unit] states hours, the project and the client", () => {
    const { subject, text } = composeBudgetAlert(input());
    expect(subject).toBe("Budget alert: Site survey has used 90% of its hours budget");
    expect(text).toContain("Site survey (Kestrel Environmental) has used 90% of its hours budget");
    expect(text).toContain("Budget: 100 hours");
    expect(text).toContain("Used: 90 hours");
  });

  it("[unit] says over budget once the budget is passed, and names the month of a monthly one", () => {
    const { subject, text } = composeBudgetAlert(
      input({ spentAmount: 400_000, period: "2026-10", thresholdPercent: 100 }),
    );
    expect(subject).toBe("Over budget: Site survey has used 111% of its hours budget");
    expect(text).toContain("in October 2026");
  });

  it("[security] leaves the money out for a reader who may not see it", () => {
    const visible = composeBudgetAlert(
      input({ unit: "cents", basis: "fees", budgetAmount: 100_000, spentAmount: 90_000 }),
    );
    expect(visible.text).toContain("Budget: $1,000.00");
    expect(visible.text).toContain("Used: $900.00");

    const hidden = composeBudgetAlert(
      input({
        unit: "cents",
        basis: "fees",
        budgetAmount: 100_000,
        spentAmount: 90_000,
        amountsVisible: false,
      }),
    );
    expect(hidden.subject).toBe("Budget alert: Site survey has used 90% of its fee budget");
    expect(hidden.text).not.toContain("$");
    expect(hidden.text).not.toContain("Budget:");
  });
});
