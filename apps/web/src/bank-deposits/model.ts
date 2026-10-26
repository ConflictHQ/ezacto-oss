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
export const bankDepositSourceLabel = (row: BankDeposit): string =>
  row.source_status === "pending"
    ? "Pending at provider"
    : row.source_status === "reversed"
      ? "Reversed at provider"
      : row.confirmation_basis === "operator"
        ? "Source verified by an administrator"
        : row.source_status === "final"
          ? "Posted at provider"
          : "Provider settlement unverified";
