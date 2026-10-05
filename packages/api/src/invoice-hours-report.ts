/**
 * The hours an invoice billed, as a file to download (issue 647).
 *
 * The same report the invoice's email can carry -- the work journal -- in any
 * of its formats, at either level, on demand. Rendered from the same source as
 * the email, so the file an operator downloads to check before sending is the
 * file the client would be sent, internal notes withheld exactly as they are
 * there (D20).
 *
 * Read with the authority that reads the invoice itself: the report is the
 * invoice's own billed lines, broken out, and anybody who can read what the
 * invoice charges can read what it charged for. A session or a token carrying
 * `invoices:read`, as `GET /invoices/:id` takes.
 */

import {
  isJournalFormat,
  journalDocumentFor,
  journalFilename,
  journalFormatContentType,
  renderJournalFile,
  type JournalDetail,
  type JournalSource,
} from "@ezacto/core";
import type { Hono } from "hono";
import { requireApiScope } from "./auth.js";
import type { ApiContext } from "./context.js";
import { ApiError, validationError, type FieldError } from "./errors.js";

export interface InvoiceHoursReport extends JournalSource {
  /** The level the invoice's journal would go at; `null` when it would not go. */
  readonly level: JournalDetail | null;
}

export interface InvoiceHoursReportService {
  /** `null` for an invoice that does not exist. Notes already reduced to the client's (D20). */
  readHoursReport(invoiceId: number): Promise<InvoiceHoursReport | null>;
}

const hoursReportKeys = new Set(["format", "detail"]);

/** Quoted for every browser, and the exact UTF-8 name for those that read it. */
const contentDisposition = (name: string): string =>
  `attachment; filename="${name.replace(/[^\x20-\x7e]/gu, "_").replace(/["\\]/gu, "_")}"; ` +
  `filename*=UTF-8''${encodeURIComponent(name)}`;

export const installInvoiceHoursReportRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  service: Readonly<InvoiceHoursReportService>,
): void => {
  api.get("/invoices/:id/hours-report", async (context) => {
    requireApiScope(context, "invoices:read");
    const invoiceId = Number(context.req.param("id") ?? "");
    const url = new URL(context.req.url);
    const errors: FieldError[] = [];
    if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) {
      errors.push({ field: "id", code: "invalid", message: "id must be a positive integer." });
    }
    for (const key of new Set(url.searchParams.keys())) {
      if (!hoursReportKeys.has(key)) {
        errors.push({ field: key, code: "unknown", message: `${key} is not a parameter of this report.` });
      } else if (url.searchParams.getAll(key).length > 1) {
        errors.push({ field: key, code: "invalid", message: `${key} must be given once.` });
      }
    }
    const format = url.searchParams.get("format");
    if (!isJournalFormat(format)) {
      errors.push({
        field: "format",
        code: format === null ? "required" : "invalid",
        message: 'format must be "pdf", "csv" or "xlsx".',
      });
    }
    const detail = url.searchParams.get("detail");
    if (detail !== null && detail !== "detailed" && detail !== "summary") {
      errors.push({
        field: "detail",
        code: "invalid",
        message: 'detail must be "detailed" or "summary".',
      });
    }
    if (errors.length > 0) throw validationError(errors);

    const report = await service.readHoursReport(invoiceId);
    if (report === null) {
      throw new ApiError({
        status: 404,
        code: "not_found",
        message: "The requested resource does not exist.",
      });
    }
    // 409 rather than 422: the request is well formed, and the invoice is what
    // stands in the way. An empty report would tell whoever opens it that the
    // invoice is backed by no work, which is a stronger claim than "this was
    // not raised from tracked time" -- the same reason the email sends none.
    if (report.entries.length === 0) {
      throw new ApiError({
        status: 409,
        code: "no_billed_time",
        message:
          "This invoice has billed no time entries, so there is no hours report to download.",
      });
    }
    // Unasked, the level the invoice's own journal goes at; detailed for an
    // invoice whose journal is off, because a person who asks for the hours
    // behind an invoice is asking to see them.
    const level: JournalDetail =
      detail === "detailed" || detail === "summary" ? detail : (report.level ?? "detailed");
    const chosen = format as Parameters<typeof renderJournalFile>[0];
    const bytes = renderJournalFile(chosen, journalDocumentFor(report, level));
    return new Response(bytes as BodyInit, {
      status: 200,
      headers: {
        "content-type": journalFormatContentType[chosen],
        "content-length": String(bytes.byteLength),
        "content-disposition": contentDisposition(
          journalFilename(level, report.invoiceNumber, chosen),
        ),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  });
};
