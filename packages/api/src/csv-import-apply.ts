import type { Hono } from "hono";
import { canonicalCsvApplyCommand, CsvApplyRefusal } from "@ezacto/core";
import type { ApiContext } from "./context.js";
import { ApiError, readJsonBody } from "./errors.js";
import type { CsvImportApplyPort } from "./csv-import-apply-port.js";
import type { CsvImportStagingPort } from "./csv-import-staging-port.js";
import {
  csvStagingAuthority,
  csvStagingSafeFailure,
} from "./csv-import-staging.js";

/** Install below the same current-session/owned-stage admission boundary as
 * staging. Body and command headers are deliberately read only after ownership. */
export const installCsvImportApplyRoutes = <B extends object>(
  api: Hono<ApiContext<B>>,
  staging: CsvImportStagingPort,
  port: CsvImportApplyPort,
): void => {
  const failure = (cause: unknown): never => {
    if (cause instanceof CsvApplyRefusal) {
      const status =
        cause.code === "run_not_found"
          ? 404
          : cause.code === "authority_required"
            ? 401
            : cause.code === "invalid_command"
              ? 400
              : 409;
      return csvStagingSafeFailure(
        new ApiError({
          status,
          code: cause.code,
          message: "The CSV apply operation could not be completed.",
        }),
      );
    }
    return csvStagingSafeFailure(cause);
  };
  for (const operation of ["apply", "resume"] as const) {
    api.post(`/csv-imports/:runId/${operation}`, async (c) => {
      try {
        const authority = csvStagingAuthority(c),
          stageId = c.req.param("runId");
        await staging.authorizeRun(authority, stageId);
        const { command } = canonicalCsvApplyCommand(
          await readJsonBody<unknown>(c, { maxBytes: 2048 }),
        );
        if (c.req.header("idempotency-key") !== command.command_id)
          throw new CsvApplyRefusal("invalid_command");
        return c.json(
          { data: await port[operation](authority, stageId, command) },
          200,
          { "cache-control": "no-store" },
        );
      } catch (cause) {
        return failure(cause);
      }
    });
  }
  api.get("/csv-imports/:runId/apply", async (c) => {
    try {
      const authority = csvStagingAuthority(c),
        stageId = c.req.param("runId");
      await staging.authorizeRun(authority, stageId);
      const command = c.req.query("command_id");
      if (
        command !== undefined &&
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(command)
      )
        throw new CsvApplyRefusal("invalid_command");
      return c.json(
        { data: await port.status(authority, stageId, command) },
        200,
        { "cache-control": "no-store" },
      );
    } catch (cause) {
      return failure(cause);
    }
  });
  api.post("/csv-imports/:runId/cancel", async (c) => {
    try {
      const authority = csvStagingAuthority(c),
        stageId = c.req.param("runId");
      await staging.authorizeRun(authority, stageId);
      const body = await readJsonBody<unknown>(c, { maxBytes: 256 });
      if (
        body === null ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 1 ||
        !("command_id" in body) ||
        typeof body.command_id !== "string" ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
          body.command_id,
        ) ||
        c.req.header("idempotency-key") !== body.command_id
      )
        throw new CsvApplyRefusal("invalid_command");
      return c.json(
        {
          data: await port.cancel(authority, stageId, {
            command_id: body.command_id,
          }),
        },
        200,
        { "cache-control": "no-store" },
      );
    } catch (cause) {
      return failure(cause);
    }
  });
};
