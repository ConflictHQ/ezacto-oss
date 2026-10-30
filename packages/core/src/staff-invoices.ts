import { StaffPaymentError, validPaymentMonth } from "./staff-payments.js";
import { trackedAmountCents } from "./reports.js";
import type { PaymentActualEntry } from "./payment-actuals.js";

export interface StaffInvoiceLine {
  description: string;
  project_id: number | null;
  entry_id: number | null;
  seconds: number;
  rate_cents: number;
}
export type StaffInvoiceKind = "draft" | "received" | "void";
export interface SaveStaffInvoice {
  id: string;
  invoice_id: number | null;
  expected_version: number;
  user_id: number;
  month: string;
  currency: string;
  reference: string;
  kind: StaffInvoiceKind;
  from_review: boolean;
  lines: StaffInvoiceLine[];
  document_id: string | null;
  reason: string;
  acknowledge_paid_history: boolean;
}
export interface StaffInvoiceVersion {
  command_id: string;
  version: number;
  month: string;
  currency: string;
  kind: StaffInvoiceKind;
  lines: StaffInvoiceLine[];
  amount_cents: number;
  review_id: string | null;
  document_id: string | null;
  reason: string;
  actor_id: number;
  recorded_at: string;
  paid_cents_at_recording: number;
  has_payment_history: boolean;
}
export interface StaffInvoice {
  id: number;
  user_id: number;
  month: string;
  currency: string;
  reference: string;
  versions: StaffInvoiceVersion[];
  matched_cents: number;
  flags: string[];
  line_flags: string[][];
}
export interface StaffInvoicePerson {
  user_id: number;
  name: string;
  currency: string | null;
  earned_cents: number | null;
  paid_cents: number;
  invoiced_cents: number;
  matched_invoice_cents: number;
  uninvoiced_cents: number | null;
  invoices: StaffInvoice[];
}
export interface StaffInvoiceReport {
  month: string;
  people: StaffInvoicePerson[];
}
export interface StaffInvoiceDocument {
  id: string;
  invoice_id: number;
  file_key: string;
  name: string;
  content_hash: string;
  byte_size: number;
  content_type: string;
}
export type RecordStaffInvoiceDocument = StaffInvoiceDocument;
export interface StaffInvoicesStore {
  save(
    command: SaveStaffInvoice,
    actorId: number,
    requestId: string,
    now: string,
  ): Promise<StaffInvoice>;
  report(month: string, ownUserId?: number): Promise<StaffInvoiceReport>;
  recordDocument(
    command: RecordStaffInvoiceDocument,
    actorId: number,
    requestId: string,
    now: string,
  ): Promise<void>;
  document(
    invoiceId: number,
    id: string,
    ownUserId?: number,
  ): Promise<StaffInvoiceDocument | null>;
}
export const staffInvoiceAmount = (
  lines: readonly StaffInvoiceLine[],
): number => {
  let total = 0n;
  if (lines.length > 500)
    throw new StaffPaymentError("invalid", "Use at most 500 invoice lines.");
  for (const line of lines) {
    if (
      typeof line.description !== "string" ||
      !line.description.trim() ||
      line.description.length > 2000 ||
      !Number.isSafeInteger(line.seconds) ||
      line.seconds === 0 ||
      !Number.isSafeInteger(line.rate_cents) ||
      line.rate_cents < 0 ||
      (line.project_id !== null &&
        (!Number.isSafeInteger(line.project_id) || line.project_id <= 0)) ||
      (line.entry_id !== null &&
        (!Number.isSafeInteger(line.entry_id) || line.entry_id <= 0))
    )
      throw new StaffPaymentError(
        "invalid",
        "Provide a description, non-zero hours in whole seconds, a non-negative rate and valid earning references.",
      );
    const cents = trackedAmountCents(line.seconds, line.rate_cents);
    if (!Number.isSafeInteger(cents) || Math.abs(cents) > 9_000_000_000_000)
      throw new StaffPaymentError(
        "invalid",
        "The invoice amount exceeds the supported range.",
      );
    total += BigInt(cents);
  }
  if (total < 0n || total > 9_000_000_000_000n)
    throw new StaffPaymentError(
      "invalid",
      "The invoice amount exceeds the supported range.",
    );
  return Number(total);
};
export const validateStaffInvoice = (command: SaveStaffInvoice): void => {
  if (
    !/^[a-zA-Z0-9._-]{1,100}$/u.test(command.id) ||
    !Number.isSafeInteger(command.user_id) ||
    command.user_id <= 0 ||
    !Number.isSafeInteger(command.expected_version) ||
    command.expected_version < 0 ||
    (command.invoice_id !== null &&
      (!Number.isSafeInteger(command.invoice_id) || command.invoice_id <= 0)) ||
    (command.expected_version === 0) !== (command.invoice_id === null) ||
    !validPaymentMonth(command.month) ||
    !/^[A-Z]{3}$/u.test(command.currency) ||
    typeof command.reference !== "string" ||
    !command.reference.trim() ||
    command.reference.length > 200 ||
    (command.expected_version === 0 && command.kind === "void") ||
    !["draft", "received", "void"].includes(command.kind) ||
    typeof command.reason !== "string" ||
    !command.reason.trim() ||
    command.reason.length > 2000 ||
    typeof command.from_review !== "boolean" ||
    typeof command.acknowledge_paid_history !== "boolean" ||
    (command.document_id !== null &&
      !/^[a-zA-Z0-9._-]{1,100}$/u.test(command.document_id)) ||
    (command.from_review && command.lines.length > 0)
  )
    throw new StaffPaymentError(
      "invalid",
      "Provide a contractor, work month, currency, reference, version and reason. Draft from a review or supply explicit lines.",
    );
  staffInvoiceAmount(command.lines);
};
/** Compare actual received documents to the same earnings; never mint an
 * obligation. Overlapping received lines all need review, rather than silently
 * favoring whichever document happened to be read first. */
export const matchStaffInvoices = (
  invoices: StaffInvoice[],
  entries: readonly PaymentActualEntry[],
  currency: string | null,
): void => {
  const review = new Map(entries.map((entry) => [entry.entry_id, entry]));
  const projects = new Map<
    number,
    { seconds: bigint; cents: bigint; rates: Set<number | null> }
  >();
  const abs = (n: bigint) => (n < 0n ? -n : n);
  for (const entry of entries.filter((e) => e.selected_seconds !== 0)) {
    const project = projects.get(entry.project_id) ?? {
      seconds: 0n,
      cents: 0n,
      rates: new Set<number | null>(),
    };
    project.seconds += BigInt(entry.selected_seconds);
    project.cents += BigInt(
      trackedAmountCents(entry.selected_seconds, entry.cost_rate_cents ?? 0),
    );
    project.rates.add(entry.cost_rate_cents);
    projects.set(entry.project_id, project);
  }
  const claimed = new Map<string, { seconds: bigint; cents: bigint }>(),
    projectScopes = new Set<number>(),
    entryScopes = new Set<number>();
  for (const invoice of invoices) {
    const version = invoice.versions.at(-1)!;
    if (version.kind !== "received") continue;
    for (const line of version.lines) {
      const key =
        line.entry_id !== null
          ? `entry:${line.entry_id}`
          : line.project_id !== null
            ? `project:${line.project_id}`
            : null;
      if (key) {
        const prev = claimed.get(key) ?? { seconds: 0n, cents: 0n };
        claimed.set(key, {
          seconds: prev.seconds + BigInt(Math.abs(line.seconds)),
          cents:
            prev.cents +
            BigInt(Math.abs(trackedAmountCents(line.seconds, line.rate_cents))),
        });
      }
      if (line.entry_id !== null) {
        const entry = review.get(line.entry_id);
        if (entry) entryScopes.add(entry.project_id);
      } else if (line.project_id !== null) projectScopes.add(line.project_id);
    }
  }
  for (const invoice of invoices) {
    const version = invoice.versions.at(-1)!;
    invoice.matched_cents = 0;
    invoice.line_flags = version.lines.map((line) => {
      const flags: string[] = [];
      if (invoice.currency !== currency)
        flags.push("Currency differs from reviewed earnings");
      const entry =
        line.entry_id === null ? undefined : review.get(line.entry_id);
      const project =
        line.project_id === null ? undefined : projects.get(line.project_id);
      let seconds: bigint | null = null,
        cents: bigint | null = null,
        key: string | null = null,
        projectId: number | null = null;
      if (line.entry_id !== null) {
        if (!entry || entry.selected_seconds === 0)
          flags.push("No matching reviewed earning");
        else {
          seconds = BigInt(entry.selected_seconds);
          cents = BigInt(
            trackedAmountCents(
              entry.selected_seconds,
              entry.cost_rate_cents ?? 0,
            ),
          );
          key = `entry:${entry.entry_id}`;
          projectId = entry.project_id;
          if (line.project_id !== entry.project_id)
            flags.push("Project differs from reviewed earning");
          if (line.rate_cents !== entry.cost_rate_cents)
            flags.push("Rate differs from reviewed earning");
        }
      } else if (project) {
        seconds = project.seconds;
        cents = project.cents;
        key = `project:${line.project_id}`;
        projectId = line.project_id;
        if (project.rates.size !== 1 || !project.rates.has(line.rate_cents))
          flags.push(
            "Project has different captured rates: link individual entries for review",
          );
      } else flags.push("No matching reviewed earning");
      if (seconds !== null && cents !== null && key !== null) {
        if (
          BigInt(line.seconds) * seconds <= 0n ||
          BigInt(Math.abs(line.seconds)) > abs(seconds)
        )
          flags.push("Hours exceed reviewed earning");
        const claim = claimed.get(key);
        if (
          version.kind === "received" &&
          claim &&
          (claim.seconds > abs(seconds) || claim.cents > abs(cents))
        )
          flags.push("Received invoice lines overlap this earning");
        if (
          version.kind === "received" &&
          projectId !== null &&
          projectScopes.has(projectId) &&
          entryScopes.has(projectId)
        )
          flags.push(
            "Project and entry invoice lines overlap: use one matching granularity",
          );
      }
      if (flags.length === 0 && version.kind !== "void")
        invoice.matched_cents += trackedAmountCents(
          line.seconds,
          line.rate_cents,
        );
      return flags;
    });
    invoice.flags = [...new Set(invoice.line_flags.flat())];
    if (version.version > 1 && version.has_payment_history)
      invoice.flags.push(
        "Corrected after payment: review allocations separately; payments were preserved",
      );
  }
};
