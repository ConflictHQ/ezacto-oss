/** Monthly staff payment register. Recording a payment never initiates a transfer. */
export type StaffPaymentKind =
  "amount" | "payment" | "void" | "opening" | "reopen" | "note";
export interface StaffPaymentCommand {
  id: string;
  user_id: number;
  month: string;
  expected_version: number;
  kind: StaffPaymentKind;
  amount_cents: number | null;
  currency: string | null;
  paid_on: string | null;
  due_on: string | null;
  reference: string;
  note: string;
  payment_id: string | null;
  source: "wise" | "historical";
}
export interface StaffPaymentEvent extends StaffPaymentCommand {
  version: number;
  actor_id: number;
  actor_name: string;
  recorded_at: string;
  request_id: string;
}
export interface StaffPaymentPerson {
  user_id: number;
  name: string;
  active: boolean;
  wise_ready: boolean;
}
export interface StaffPaymentRow extends StaffPaymentPerson {
  month: string;
  version: number;
  amount_cents: number | null;
  currency: string | null;
  paid_cents: number;
  balance_cents: number | null;
  due_on: string | null;
  settled_through: string | null;
  status: "in_progress" | "pending" | "partial" | "paid" | "settled";
  overdue: boolean;
  events: StaffPaymentEvent[];
}
export interface StaffPaymentReport {
  month: string;
  as_of: string;
  rows: StaffPaymentRow[];
}
export interface StaffPaymentStore {
  report(month: string, today: string): Promise<StaffPaymentReport>;
  append(
    command: StaffPaymentCommand,
    actorId: number,
    requestId: string,
    now: string,
  ): Promise<void>;
}
export class StaffPaymentError extends Error {
  constructor(
    readonly code: "invalid" | "conflict" | "not_found",
    message: string,
  ) {
    super(message);
    this.name = "StaffPaymentError";
  }
}
export const validPaymentMonth = (value: string): boolean =>
  /^\d{4}-(?:0[1-9]|1[0-2])$/u.test(value) && value >= "1900-01";
export const validPaymentDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const stamp = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(stamp) &&
    new Date(stamp).toISOString().slice(0, 10) === value
  );
};
export const paymentMonthEnd = (month: string): string => {
  if (!validPaymentMonth(month))
    throw new StaffPaymentError("invalid", "Choose a valid month.");
  const [year, number] = month.split("-").map(Number);
  return new Date(Date.UTC(year!, number!, 0)).toISOString().slice(0, 10);
};

export const summarizeStaffPayments = (
  person: StaffPaymentPerson,
  month: string,
  events: readonly StaffPaymentEvent[],
  today: string,
): StaffPaymentRow => {
  const own = events
    .filter((event) => event.month === month)
    .sort((a, b) => a.version - b.version);
  const openings = events
    .filter((event) => event.kind === "opening" && event.month >= month)
    .sort((a, b) => b.month.localeCompare(a.month));
  let settled: string | null = openings[0]?.month ?? null;
  let amount: number | null = null;
  let currency: string | null = null;
  let due: string | null = null;
  const payments = new Map<string, number>();
  for (const event of own) {
    if (event.kind === "amount") {
      amount = event.amount_cents;
      currency = event.currency;
      due = event.due_on;
      settled = null;
    }
    if (event.kind === "payment") {
      payments.set(event.id, event.amount_cents!);
      settled = null;
    }
    if (event.kind === "void") payments.delete(event.payment_id!);
    if (event.kind === "opening")
      settled =
        settled === null || event.month > settled ? event.month : settled;
    if (event.kind === "reopen") settled = null;
  }
  const paid = [...payments.values()].reduce((sum, value) => sum + value, 0);
  const balance = amount === null ? null : amount - paid;
  const status =
    settled !== null
      ? "settled"
      : balance === 0
        ? "paid"
        : paid > 0
          ? "partial"
          : paymentMonthEnd(month) >= today
            ? "in_progress"
            : "pending";
  return {
    ...person,
    month,
    version: own.at(-1)?.version ?? 0,
    amount_cents: amount,
    currency,
    paid_cents: paid,
    balance_cents: balance,
    due_on: due,
    settled_through: settled === null ? null : paymentMonthEnd(settled),
    status,
    overdue:
      status !== "paid" &&
      status !== "settled" &&
      due !== null &&
      due < today &&
      paymentMonthEnd(month) < today,
    events: [...own, ...openings.filter((event) => event.month !== month)],
  };
};

export const validateStaffPayment = (
  command: StaffPaymentCommand,
  row: StaffPaymentRow,
  today: string,
): void => {
  const fail = (message: string): never => {
    throw new StaffPaymentError("invalid", message);
  };
  if (!validPaymentMonth(command.month)) fail("Choose a valid month.");
  if (
    !Number.isSafeInteger(command.expected_version) ||
    command.expected_version < 0
  )
    fail("Invalid version.");
  if (command.expected_version !== row.version)
    throw new StaffPaymentError(
      "conflict",
      "This record changed. Refresh before saving.",
    );
  if (!/^[a-zA-Z0-9._:-]{1,128}$/u.test(command.id))
    fail("Invalid command identifier.");
  if (command.note.trim().length === 0 || command.note.length > 2000)
    fail("Add a note of up to 2,000 characters explaining this entry.");
  if (command.reference.length > 255) fail("Payment reference is too long.");
  if (!["wise", "historical"].includes(command.source))
    fail("Choose Wise or a historical record.");
  if (
    !["amount", "payment", "void", "opening", "reopen", "note"].includes(
      command.kind,
    )
  )
    fail("Invalid action.");
  if (command.kind === "amount" || command.kind === "payment") {
    if (
      command.amount_cents === null ||
      !Number.isSafeInteger(command.amount_cents) ||
      command.amount_cents < (command.kind === "payment" ? 1 : 0) ||
      command.amount_cents > 9_000_000_000_000
    )
      fail("Enter an exact amount within the supported range.");
    if (command.currency === null || !/^[A-Z]{3}$/u.test(command.currency))
      fail("Enter a three-letter currency.");
    if (row.status === "settled")
      fail("Reopen the historical settlement before adding exact amounts.");
  } else if (command.amount_cents !== null || command.currency !== null)
    fail("This action does not take an amount or currency.");
  if (command.kind === "amount") {
    if (command.amount_cents! < row.paid_cents)
      fail(
        "The amount owed cannot be less than recorded payments. Void an incorrect payment first.",
      );
    if (row.paid_cents > 0 && command.currency !== row.currency)
      fail("Currency cannot change while payments remain recorded.");
    if (command.due_on !== null && !validPaymentDate(command.due_on))
      fail("Choose a valid due date.");
  } else if (command.due_on !== null)
    fail("Only an amount entry can set a due date.");
  if (command.kind === "payment") {
    if (row.balance_cents === null)
      fail("Record the amount owed before recording a payment.");
    if (command.currency !== row.currency)
      fail("The payment currency must match the amount owed.");
    if (command.amount_cents! > row.balance_cents!)
      fail("The payment exceeds the remaining balance.");
    if (
      command.paid_on === null ||
      !validPaymentDate(command.paid_on) ||
      command.paid_on > today
    )
      fail("Choose an actual payment date, today or earlier.");
    if (command.reference.trim() === "")
      fail("Enter the payment or receipt reference.");
    const voided = new Set(
      row.events
        .filter((event) => event.kind === "void")
        .map((event) => event.payment_id),
    );
    if (
      row.events.some(
        (event) =>
          event.kind === "payment" &&
          !voided.has(event.id) &&
          event.source === command.source &&
          event.reference === command.reference,
      )
    )
      fail("This payment reference is already recorded for this period.");
  } else if (command.paid_on !== null || command.reference !== "")
    fail("Only a payment entry takes a payment date or reference.");
  if (command.kind === "void") {
    if (
      !row.events.some(
        (event) => event.kind === "payment" && event.id === command.payment_id,
      ) ||
      row.events.some(
        (event) =>
          event.kind === "void" && event.payment_id === command.payment_id,
      )
    )
      fail("Choose a recorded payment that has not already been voided.");
  } else if (command.payment_id !== null)
    fail("Only a void entry can name a previous payment.");
  if (
    command.kind === "opening" &&
    (paymentMonthEnd(command.month) >= today ||
      row.amount_cents !== null ||
      row.paid_cents > 0)
  )
    fail(
      "Opening settlement is only for completed periods with no exact amounts recorded.",
    );
  if (command.kind === "reopen" && row.status !== "settled")
    fail(
      "Only historical settlement can be reopened. Correct actual payments with a void entry.",
    );
};
