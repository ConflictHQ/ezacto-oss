import type {
  BankDeposit,
  BankFeedAccount,
  BankReviewInvoice,
  BankDepositAssignInput,
  BankDepositDecisionInput,
  BankDepositConfirmInput,
  BankDepositVerifyInput,
} from "@conflict-hq/ezacto-client";
export interface BankDepositApi {
  bankFeedStatus?(signal: AbortSignal): Promise<
    {
      provider: "mercury" | "wise";
      configured: boolean;
      account_name: string | null;
      last_synced_at: string | null;
      last_error: string | null;
      next_poll_at: string | null;
    }[]
  >;
  bankFeedSync?(
    signal: AbortSignal,
  ): Promise<{ checked: number; failed: number }>;
  bankDepositAccounts(signal: AbortSignal): Promise<BankFeedAccount[]>;
  bankDepositList(
    state: BankDeposit["state"] | undefined,
    page: number,
    signal: AbortSignal,
  ): Promise<{ data: BankDeposit[]; total: number }>;
  bankDepositInvoices(
    id: number,
    signal: AbortSignal,
  ): Promise<BankReviewInvoice[]>;
  bankDepositAssign(
    id: number,
    key: string,
    body: BankDepositAssignInput,
    signal: AbortSignal,
  ): Promise<BankDeposit>;
  bankDepositReject(
    id: number,
    key: string,
    body: BankDepositDecisionInput,
    signal: AbortSignal,
  ): Promise<BankDeposit>;
  bankDepositReopen(
    id: number,
    key: string,
    body: BankDepositDecisionInput,
    signal: AbortSignal,
  ): Promise<BankDeposit>;
  bankDepositConfirm(
    id: number,
    key: string,
    body: BankDepositConfirmInput,
    signal: AbortSignal,
  ): Promise<BankDeposit>;
  bankDepositVerify(
    id: number,
    key: string,
    body: BankDepositVerifyInput,
    signal: AbortSignal,
  ): Promise<BankDeposit>;
}
export const bankDepositSourceLabel = (row: BankDeposit): string => {
  const provider =
    row.source_status === "ineligible"
      ? "Not eligible at provider"
      : row.source_status === "pending"
        ? "Pending at provider"
        : row.source_status === "reversed"
          ? "Reversed at provider"
          : row.source_status === "final"
            ? "Posted at provider"
            : "Provider settlement unverified";
  return row.confirmation_basis === "operator"
    ? `${provider}; source verified by an administrator`
    : provider;
};
