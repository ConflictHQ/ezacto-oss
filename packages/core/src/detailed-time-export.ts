import type {
  JournalEntry,
  JournalRecapRow,
  JournalReportInput,
  JournalReportRecap,
} from "./journal-document.js";
import type { JournalFormat } from "./journal-files.js";

/**
 * The detailed time report as a file: Reports, Detailed time, Export.
 *
 * Harvest exported this report as the PDF a client is sent every month -- its
 * title, the client across the top, a recap of what the report covers, then
 * every entry under its person with the note in full. The work journal
 * (`journal-document.ts`) is already that layout. This is the report's side of
 * it: the recap stated from the filters the report was run with, the heading
 * and the name it is filed under, so the file a person sends is the report
 * they were reading.
 *
 * Hours only, as Harvest's document is: what was worked, never what it costs.
 */

export type DetailedTimeExportHours =
  | "all"
  | "billable"
  | "non_billable"
  | "uninvoiced"
  | "claimed"
  | "unclaimed";
export type DetailedTimeExportInvoiceState = "all" | "invoiced" | "uninvoiced";
export type DetailedTimeExportBillingMethod = "non_billable" | "time_materials" | "fixed_fee";

/**
 * What the report was asked for, each filter by the name it stands for and
 * `null` where it was not set. Names rather than ids, because the recap is
 * read by a client who has never seen either.
 */
export interface DetailedTimeExportScope {
  readonly from: string;
  readonly to: string;
  readonly hours: DetailedTimeExportHours;
  readonly invoiceState: DetailedTimeExportInvoiceState;
  readonly client: string | null;
  readonly project: string | null;
  readonly task: string | null;
  readonly person: string | null;
  readonly role: string | null;
  readonly tag: string | null;
  readonly manager: string | null;
  readonly contractorsOnly: boolean;
  readonly fixedFeeExcluded: boolean;
  readonly currency: string | null;
  readonly projectStatus: "all" | "active" | "archived";
  readonly activeProjectsOnly: boolean;
  readonly billingMethod: DetailedTimeExportBillingMethod | null;
}

const hoursNames: Readonly<Record<DetailedTimeExportHours, string>> = {
  all: "hours",
  billable: "billable hours",
  non_billable: "non-billable hours",
  uninvoiced: "uninvoiced billable hours",
  claimed: "claimed hours",
  unclaimed: "unclaimed hours",
};

/**
 * Which hours the total adds up, as Harvest writes it after the figure:
 * "86.83 Uninvoiced billable hours". The Show filter names them, and the
 * invoice state narrows them further where Show has not already said which
 * side of an invoice they are on -- `uninvoiced`, `claimed` and `unclaimed`
 * have, and qualifying them again would say it twice.
 */
export const detailedTimeHoursLabel = (
  hours: DetailedTimeExportHours,
  invoiceState: DetailedTimeExportInvoiceState,
): string => {
  const qualifiable = hours === "all" || hours === "billable" || hours === "non_billable";
  const label =
    qualifiable && invoiceState !== "all" ? `${invoiceState} ${hoursNames[hours]}` : hoursNames[hours];
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
};

const billingMethods: Readonly<Record<DetailedTimeExportBillingMethod, string>> = {
  time_materials: "Time & materials",
  fixed_fee: "Fixed fee",
  non_billable: "Non-billable",
};

/**
 * Harvest's four lines -- clients, projects, tasks, team -- in its words, then
 * one line for each filter Harvest does not have, in the words the report's
 * own screen uses for it. A filter that narrowed the report and is not stated
 * would leave the total claiming more than it covers, so every one that is set
 * is said; none that is unset is.
 */
export const detailedTimeRecap = (scope: DetailedTimeExportScope): JournalReportRecap => {
  const rows: JournalRecapRow[] = [
    scope.client === null ? ["Clients", "All clients"] : ["1 Client", scope.client],
    scope.project === null ? ["Projects", "All projects"] : ["1 Project", scope.project],
    scope.task === null ? ["Tasks", "All tasks"] : ["1 Task", scope.task],
    ["Team", scope.person ?? (scope.contractorsOnly ? "Contractors only" : "Everyone")],
  ];
  if (scope.role !== null) rows.push(["Role", scope.role]);
  if (scope.tag !== null) rows.push(["Tag", scope.tag]);
  if (scope.manager !== null) rows.push(["Project manager", scope.manager]);
  if (scope.billingMethod !== null) rows.push(["Billing method", billingMethods[scope.billingMethod]]);
  if (scope.fixedFeeExcluded) rows.push(["Fixed-fee projects", "Excluded"]);
  if (scope.currency !== null) rows.push(["Currency", scope.currency]);
  if (scope.projectStatus === "archived") rows.push(["Project status", "Archived only"]);
  else if (scope.projectStatus === "active" || scope.activeProjectsOnly) {
    rows.push(["Project status", "Active only"]);
  }
  return { hoursLabel: detailedTimeHoursLabel(scope.hours, scope.invoiceState), scope: rows };
};

export interface DetailedTimeExportSource {
  /** The organization's own name: the heading of a report that is not one client's. */
  readonly companyName: string;
  readonly scope: DetailedTimeExportScope;
  /** In the report's order, notes already reduced to the reader's (D20). */
  readonly entries: readonly JournalEntry[];
}

/**
 * The document the journal renderers draw. Headed by the client when the
 * report is one client's, as Harvest heads it, and by the organization when it
 * spans clients; dated by the report's own period, not by the span of the work
 * it found, because a month with nothing in its last week is still the month.
 */
export const detailedTimeDocument = (source: DetailedTimeExportSource): JournalReportInput => ({
  detail: "detailed",
  companyName: source.companyName,
  clientName: source.scope.client ?? source.companyName,
  periodStart: source.scope.from,
  periodEnd: source.scope.to,
  timeFormat: "decimal",
  entries: source.entries,
  recap: detailedTimeRecap(source.scope),
});

/**
 * The most rows a PDF of this report is drawn with. Above it the CSV and the
 * workbook still serve: they are what a file that long is for.
 *
 * Memory, not time, is the limit. A Worker isolate has 128 MB, and a PDF holds
 * every line of every page as it is laid out. Measured with notes of one to six
 * ticket URLs each: 2,000 entries render in about 0.1 s of CPU, 15,000 still
 * fit in a 128 MB heap, and 20,000 -- the report's own ceiling -- do not, which
 * on a Worker ends every request the isolate is serving. 5,000 rows is some 900
 * pages, already far past anything a client reads, and leaves room for notes a
 * few times longer than those.
 */
export const DETAILED_TIME_PDF_ROW_LIMIT = 5_000;

/** Long enough for any client's name a person would recognise in a list of files. */
const CLIENT_SLUG_LIMIT = 60;

/**
 * `detailed-time-<from>-to-<to>[-<client>].<format>`: the name the screen's own
 * export went by, with the client when the report is one client's, which is
 * the file a person attaches to that client's email. The client is reduced to
 * lower-case letters, digits and dashes -- accents dropped rather than the
 * letter -- so the name reads the same on every filesystem and needs no
 * quoting in a header. A name with nothing left in it is left out.
 */
export const detailedTimeFilename = (
  scope: Pick<DetailedTimeExportScope, "from" | "to" | "client">,
  format: JournalFormat,
): string => {
  const client = (scope.client ?? "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+/u, "")
    .slice(0, CLIENT_SLUG_LIMIT)
    .replace(/-+$/u, "");
  return `detailed-time-${scope.from}-to-${scope.to}${client === "" ? "" : `-${client}`}.${format}`;
};
