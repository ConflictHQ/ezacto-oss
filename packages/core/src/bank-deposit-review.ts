import type { BankDepositObservation } from "./bank-deposit-matching.js";
export interface BankReviewAuthority {
  userId: number;
  sessionId: string;
}
export interface BankFeedAccount {
  id: number;
  provider: "mercury" | "wise";
  name: string;
}
export interface BankReviewInvoice {
  id: number;
  number: string;
  currency: string;
  due_amount_cents: number;
  version: number;
  state: string;
}
export interface BankDepositRow {
  id: number;
  account_id: number;
  account_name: string;
  provider: "mercury" | "wise";
  provider_transaction_id: string;
  currency: string;
  posted_at: string;
  amount_cents: number;
  memo: string | null;
  counterparty: string | null;
  state: "unmatched" | "suggested" | "confirmed" | "rejected";
  version: number;
  suggested_invoice: BankReviewInvoice | null;
  source_status: BankDepositObservation["status"];
  classification: BankDepositObservation["classification"];
  source_reason: string | null;
  verified_at: string | null;
  verified_by_user_id: number | null;
  verification_reference: string | null;
  confirmation_basis: "provider" | "operator" | null;
  confirmation_ready: boolean;
  payment_id: number | null;
  confirmed_invoice_id: number | null;
}
export class BankDepositReviewError extends Error {
  constructor(
    readonly code:
      "forbidden" | "invalid" | "conflict" | "not_found" | "overpayment",
    message: string,
  ) {
    super(message);
    this.name = "BankDepositReviewError";
  }
}
