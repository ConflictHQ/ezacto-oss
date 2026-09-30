import type { StaffPaymentReport } from "./staff-payments.js";

export type PaymentItemState =
  | "draft"
  | "queued"
  | "creating"
  | "funding"
  | "processing"
  | "paid"
  | "failed"
  | "attention"
  | "cancelled";
export interface PaymentSelection {
  user_id: number;
  month: string;
  amount_cents: number;
  expected_version: number;
}
export interface PaymentRunCommand {
  id: string;
  name: string;
  source_currency: string;
  scheduled_at: string;
  timezone: string;
  items: PaymentSelection[];
}
export interface PaymentQuote {
  id: string;
  profile_id: string;
  recipient_id: string;
  recipient_name: string;
  source_currency: string;
  target_currency: string;
  target_cents: number;
  source_cents: number;
  fee_cents: number;
  rate: number;
  expires_at: string;
  estimated_arrival: string | null;
}
export interface PaymentDestination {
  id: number;
  external_id: string;
  kind: "contact" | "account";
}
export interface PaymentItem extends PaymentSelection {
  id: string;
  run_id: string;
  name: string;
  currency: string;
  destination: PaymentDestination;
  quote: PaymentQuote;
  execution_quote: PaymentQuote | null;
  max_source_cents: number;
  state: PaymentItemState;
  transfer_id: string | null;
  provider_status: string | null;
  failure: string | null;
  attempts: number;
  next_attempt_at: string;
  updated_at: string;
  version: number;
  lease_token: string | null;
  lease_until: string | null;
}
export interface PaymentRun {
  id: string;
  name: string;
  source_currency: string;
  scheduled_at: string;
  timezone: string;
  state: "draft" | "approved" | "cancelled";
  actor_id: number;
  approved_by: number | null;
  created_at: string;
  approved_at: string | null;
  request_id: string;
  items: PaymentItem[];
}
export interface PaymentRunApproval {
  limits: { item_id: string; max_source_cents: number }[];
}
export interface PaymentTransfer {
  id: string;
  status: string;
  customer_transaction_id: string;
  recipient_id: string;
  target_cents: number;
  target_currency: string;
}
export interface PaymentProvider {
  quote(
    destination: PaymentDestination,
    sourceCurrency: string,
    targetCurrency: string,
    amountCents: number,
  ): Promise<PaymentQuote>;
  create(item: PaymentItem, quote: PaymentQuote): Promise<PaymentTransfer>;
  fund(
    profileId: string,
    transferId: string,
    correlationId: string,
  ): Promise<"accepted" | "rejected">;
  read(transferId: string): Promise<PaymentTransfer>;
}
export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "PaymentProviderError";
  }
}
export interface PaymentRunReport {
  from: string;
  to: string;
  ledgers: StaffPaymentReport[];
  runs: PaymentRun[];
}
export interface PaymentRunsService {
  preview(
    command: PaymentRunCommand,
    actorId: number,
    requestId: string,
    now: string,
  ): Promise<PaymentRun>;
  approve(
    id: string,
    approval: PaymentRunApproval,
    actorId: number,
    requestId: string,
    now: string,
  ): Promise<PaymentRun>;
  cancel(
    id: string,
    actorId: number,
    requestId: string,
    now: string,
  ): Promise<PaymentRun>;
  retry(
    id: string,
    itemId: string,
    actorId: number,
    requestId: string,
    now: string,
  ): Promise<PaymentRun>;
  report(from: string, to: string, now: string): Promise<PaymentRunReport>;
  processDue(now: string): Promise<{ examined: number }>;
}
