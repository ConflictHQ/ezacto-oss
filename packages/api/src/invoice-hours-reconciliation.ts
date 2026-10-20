/**
 * Whether an invoice's billed hours agree with the time it claims (issue 924).
 *
 * The read model behind the mismatch warnings: per project and for the whole
 * invoice, the hours the linked entries total against the hours the lines
 * state, within a rounding tolerance. Lines with no project are listed as not
 * compared. Read with the authority that reads the invoice itself and its
 * hours report: a session or a token carrying `invoices:read`.
 */

import type { InvoiceHoursReconciliation } from "@ezacto/core";
import type { Hono } from "hono";
import { requireApiScope } from "./auth.js";
import type { ApiContext } from "./context.js";
import { ApiError, validationError } from "./errors.js";

export interface InvoiceHoursReconciliationService {
  /** `null` for an invoice that does not exist. */
  readHoursReconciliation(invoiceId: number): Promise<InvoiceHoursReconciliation | null>;
}

const serializeFigures = (figures: {
  linkedSeconds: number;
  billedSeconds: number;
  differenceSeconds: number;
  status: string;
}) => ({
  linked_seconds: figures.linkedSeconds,
  billed_seconds: figures.billedSeconds,
  difference_seconds: figures.differenceSeconds,
  status: figures.status,
});

export const installInvoiceHoursReconciliationRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  service: Readonly<InvoiceHoursReconciliationService>,
): void => {
  api.get("/invoices/:id/hours-reconciliation", async (context) => {
    requireApiScope(context, "invoices:read");
    const invoiceId = Number(context.req.param("id") ?? "");
    if (!Number.isSafeInteger(invoiceId) || invoiceId <= 0) {
      throw validationError([
        { field: "id", code: "invalid", message: "id must be a positive integer." },
      ]);
    }
    const result = await service.readHoursReconciliation(invoiceId);
    if (result === null) {
      throw new ApiError({
        status: 404,
        code: "not_found",
        message: "The requested resource does not exist.",
      });
    }
    return context.json(
      {
        data: {
          invoice_id: invoiceId,
          ...serializeFigures(result),
          tolerance_seconds: result.toleranceSeconds,
          projects: result.projects.map((project) => ({
            project_id: project.projectId,
            project_name: project.projectName,
            ...serializeFigures(project),
          })),
          not_compared: result.notCompared.map((line) => ({
            line_id: line.id,
            position: line.position,
            description: line.description,
            quantity: line.quantity,
          })),
        },
      },
      200,
      { "cache-control": "no-store" },
    );
  });
};
