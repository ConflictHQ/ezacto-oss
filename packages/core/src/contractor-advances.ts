/** #900: settled deposits are credit, not a second earning or a payment for
 * invented hours. Only an explicit, reasoned application pays existing earnings. */
import type { PaymentAllocationScope } from "./payment-allocations.js";
export interface ApplyAdvanceCredit {
  id: string;
  advance_item_id: string;
  user_id: number;
  currency: string;
  month: string;
  amount_cents: number;
  scope: PaymentAllocationScope;
  project_id: number | null;
  entry_id: number | null;
  reason: string;
}
export interface ReverseAdvanceCredit {
  id: string;
  application_id: string;
  reason: string;
}
export interface ReturnAdvanceCredit {
  id: string;
  advance_item_id: string;
  amount_cents: number;
  reference: string;
  reason: string;
}
export interface AdvanceCreditApplication extends ApplyAdvanceCredit {
  actor_id: number;
  recorded_at: string;
  reversed_at: string | null;
  reversal_reason: string | null;
}
export interface AdvanceCreditReturn extends ReturnAdvanceCredit {
  actor_id: number;
  recorded_at: string;
}
export interface AdvanceCredit {
  advance_item_id: string;
  user_id: number;
  name: string;
  currency: string;
  month: string;
  advance_project_id: number | null;
  advance_reason: string;
  state: string;
  amount_cents: number;
  settled_cents: number;
  settled_at: string | null;
  applied_cents: number;
  returned_cents: number;
  reserved_cents: number;
  available_cents: number;
  opening_cents: number;
  period_settled_cents: number;
  period_applied_cents: number;
  period_returned_cents: number;
  closing_cents: number;
  applications: AdvanceCreditApplication[];
  returns: AdvanceCreditReturn[];
}
export interface AdvanceCreditReport {
  from: string;
  to: string;
  advances: AdvanceCredit[];
}
export interface AdvanceCreditsStore {
  report(from: string, to: string): Promise<AdvanceCreditReport>;
  apply(
    command: ApplyAdvanceCredit,
    actorId: number,
    requestId: string,
    now: string,
  ): Promise<void>;
  reverse(
    command: ReverseAdvanceCredit,
    actorId: number,
    requestId: string,
    now: string,
  ): Promise<void>;
  recordReturn(
    command: ReturnAdvanceCredit,
    actorId: number,
    requestId: string,
    now: string,
  ): Promise<void>;
}
