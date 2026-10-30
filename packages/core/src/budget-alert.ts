/**
 * Project budget alerts (issue 934): when a budget has used enough of itself to
 * be worth telling someone, and what the telling says.
 *
 * The arithmetic is here, away from the database, because two readers need the
 * same answer and a second copy is how an alert would come to disagree with the
 * budget report beside it.
 */

/** What an unset `over_budget_pct` means: tell me when the budget is used up. */
export const DEFAULT_OVER_BUDGET_PERCENT = 100;

/**
 * Whether `spent` has reached `percent` of `budget`.
 *
 * Cross-multiplied rather than divided so a threshold of 85 against a budget of
 * 100 is crossed at exactly 85, not at 84.99999999999999. A budget that is zero
 * or absent never alerts: "100% of nothing" is not a crossing anybody asked to
 * hear about, and every project that has not set a budget would otherwise
 * alert on its first minute.
 */
export const budgetThresholdCrossed = (
  spent: number,
  budget: number | null,
  percent: number | null,
): boolean => {
  if (budget === null || !(budget > 0)) return false;
  const threshold = percent === null || !(percent > 0) ? DEFAULT_OVER_BUDGET_PERCENT : percent;
  return spent * 100 >= budget * threshold;
};

export type BudgetAlertUnit = "seconds" | "cents";

/** Whole percent, rounded down: 84.9% has not used 85%, and the mail must not claim it. */
export const budgetUsedPercent = (spent: number, budget: number): number =>
  Math.floor((spent * 100) / budget);

const hoursText = (seconds: number): string => {
  const hours = seconds / 3600;
  return `${hours.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 0 })} hours`;
};

const moneyText = (cents: number, currency: string): string => {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
};

export interface BudgetAlertMessageInput {
  readonly companyName: string;
  readonly projectName: string;
  readonly clientName: string;
  readonly unit: BudgetAlertUnit;
  readonly budgetAmount: number;
  readonly spentAmount: number;
  readonly thresholdPercent: number;
  /** `lifetime`, or the month `YYYY-MM` a monthly budget is read over. */
  readonly period: string;
  readonly currency: string;
  /**
   * Whether this reader may be shown money. A project manager is told an hours
   * budget in hours and a money budget as a percentage only: the figures are
   * the firm's, and the recipient's profile decides whether they are theirs.
   */
  readonly amountsVisible: boolean;
  /** What the budget is measured by, for the reader: "hours", "fees" or "cost". */
  readonly basis: "hours" | "cost" | "fees";
}

const monthName = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const periodText = (period: string): string => {
  if (period === "lifetime") return "over the life of the project";
  const month = new Date(`${period}-01T00:00:00.000Z`);
  return Number.isFinite(month.valueOf()) ? `in ${monthName.format(month)}` : period;
};

const basisText: Readonly<Record<BudgetAlertMessageInput["basis"], string>> = {
  hours: "hours budget",
  cost: "cost budget",
  fees: "fee budget",
};

/**
 * The email a crossing sends. Plain text: it is an internal notice to the
 * people who run the work, not an invoice, and it carries no link a mail
 * scanner could follow on someone's behalf.
 */
export const composeBudgetAlert = (
  input: Readonly<BudgetAlertMessageInput>,
): { readonly subject: string; readonly text: string } => {
  const used = budgetUsedPercent(input.spentAmount, input.budgetAmount);
  const over = input.spentAmount > input.budgetAmount;
  const basis = basisText[input.basis];
  const project =
    input.clientName === "" ? input.projectName : `${input.projectName} (${input.clientName})`;
  const subject = over
    ? `Over budget: ${input.projectName} has used ${String(used)}% of its ${basis}`
    : `Budget alert: ${input.projectName} has used ${String(used)}% of its ${basis}`;
  const show = (amount: number): string =>
    input.unit === "seconds" ? hoursText(amount) : moneyText(amount, input.currency);
  const lines = [
    `${project} has used ${String(used)}% of its ${basis} ${periodText(input.period)}.`,
    "",
  ];
  if (input.amountsVisible) {
    lines.push(`Budget: ${show(input.budgetAmount)}`, `Used: ${show(input.spentAmount)}`, "");
  }
  lines.push(
    `You are receiving this because "Notify when over budget" is on for this project in ${input.companyName}, at ${String(
      input.thresholdPercent,
    )}%. It is sent once each time the budget crosses that line.`,
  );
  return { subject, text: lines.join("\n") };
};
