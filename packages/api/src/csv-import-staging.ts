import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ApiContext } from "./context.js";
import { requireSessionPrincipal } from "./auth.js";
import { ApiError, readJsonBody } from "./errors.js";
import {
  CsvStagingError,
  CSV_STAGING_LIMITS,
  csvStagingErrorStatus,
} from "./csv-import-staging-contract.js";
import type {
  CsvImportStagingPort,
  CsvStagingAuthority,
  CsvStagingMappingInput,
} from "./csv-import-staging-port.js";

export const isCsvStagingPath = (path: string): boolean =>
  path === "/api/v1/csv-imports" || path.startsWith("/api/v1/csv-imports/");
export const csvStagingCapabilities = (port?: CsvImportStagingPort) => ({
  runtime: port ? "container" : "worker",
  staging_supported: port !== undefined,
  browser_ready: false,
  apply_supported: false,
  max_csv_bytes: CSV_STAGING_LIMITS.maxBytes,
  max_mapping_bytes: CSV_STAGING_LIMITS.maxMappingBytes,
  raw_retention_hours: 24,
});
const safeFailure = (error: unknown): never => {
  // Only preserve recognized HTTP classifications, never their messages,
  // fields or causes: even an unexpected ApiError can carry a source cell.
  const httpStatuses: Readonly<Record<string, number>> = {
    unsupported_media_type: 415,
    invalid_content_length: 400,
    payload_too_large: 413,
    invalid_json: 400,
    session_required: 403,
  };
  const httpCode = error instanceof ApiError && httpStatuses[error.code] === error.status
    ? error.code : undefined;
  const expected = error instanceof CsvStagingError;
  const status = expected ? csvStagingErrorStatus[error.code] : httpCode === undefined ? 503 : httpStatuses[httpCode]!;
  const code = expected ? error.code : httpCode ?? "storage_unavailable";
  const message = "The private CSV operation could not be completed.";
  const safe = new ApiError({
    status: status as ContentfulStatusCode,
    code,
    message,
    ...(status === 422 ? { fields: [{ field: "input", code, message }] } : {}),
  });
  // Parser and storage exceptions can contain raw cells. Report only this fixed
  // boundary error and request id; never retain the original as a cause.
  throw safe;
};
const authority = <B extends object>(
  context: Context<ApiContext<B>>,
): CsvStagingAuthority => {
  if (context.get("principal").authentication.kind !== "session")
    throw new CsvStagingError("token_denied");
  const principal = requireSessionPrincipal(context);
  if (principal.profile !== "administrator")
    throw new CsvStagingError("administrator_required");
  const sessionRowId = Number(principal.authentication.sessionId);
  if (!Number.isSafeInteger(sessionRowId) || sessionRowId <= 0)
    throw new CsvStagingError("session_required");
  return { userId: principal.userId, sessionRowId };
};
const body = async function* (request: Request) {
  if (!request.body) return;
  const reader = request.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  request.signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const chunk = await reader.read();
      if (request.signal.aborted) throw new CsvStagingError("upload_aborted");
      if (chunk.done) return;
      yield chunk.value;
    }
  } finally {
    request.signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
};
export const installCsvImportStagingRoutes = <B extends object>(
  api: Hono<ApiContext<B>>,
  port: CsvImportStagingPort,
): void => {
  api.use("/csv-imports", async (c, next) => {
    try {
      await port.authorize(authority(c));
      await next();
    } catch (error) {
      safeFailure(error);
    }
  });
  api.use("/csv-imports/*", async (c, next) => {
    if (c.req.path === "/api/v1/csv-imports") return next();
    try {
      await port.authorizeRun(
        authority(c),
        c.req.param("runId") ?? c.req.path.split("/")[4] ?? "",
      );
      await next();
    } catch (error) {
      safeFailure(error);
    }
  });
  api.post("/csv-imports", async (c) => {
    try {
      const a = authority(c);
      await port.authorize(a);
      const type = c.req.header("content-type")?.split(";")[0]?.trim();
      if (type !== "application/octet-stream" && type !== "text/csv")
        throw new CsvStagingError("not_csv");
      const bytes = c.req.header("x-csv-bytes") ?? "";
      if (!/^[1-9][0-9]{0,7}$/.test(bytes))
        throw new CsvStagingError("length_mismatch");
      const data = await port.upload(
        a,
        body(c.req.raw),
        { sha256: c.req.header("x-csv-sha256") ?? "", bytes: Number(bytes) },
        c.req.raw.signal,
      );
      return c.json({ data }, 201);
    } catch (error) {
      safeFailure(error);
    }
  });
  api.get("/csv-imports/:runId", async (c) => {
    try {
      return c.json({
        data: await port.read(authority(c), c.req.param("runId")),
      });
    } catch (error) {
      safeFailure(error);
    }
  });
  api.get("/csv-imports/:runId/mapping", async (c) => {
    try {
      return c.json({
        data: await port.mapping(authority(c), c.req.param("runId")),
      });
    } catch (error) {
      safeFailure(error);
    }
  });
  api.patch("/csv-imports/:runId/mapping", async (c) => {
    try {
      const a = authority(c),
        run = c.req.param("runId");
      await port.authorizeRun(a, run);
      const input = await readJsonBody<CsvStagingMappingInput>(c, {
        maxBytes: CSV_STAGING_LIMITS.maxMappingBytes,
      });
      if (input === null || typeof input !== "object" || Array.isArray(input))
        throw new CsvStagingError("mapping_invalid");
      return c.json({ data: await port.map(a, run, input) });
    } catch (error) {
      safeFailure(error);
    }
  });
  api.post("/csv-imports/:runId/preview", async (c) => {
    try {
      const a = authority(c),
        run = c.req.param("runId");
      await port.authorizeRun(a, run);
      const input = await readJsonBody<{ preview_id?: string }>(c, {
        maxBytes: 4096,
        allowEmptyObject: true,
      });
      if (
        input === null ||
        typeof input !== "object" ||
        Array.isArray(input) ||
        Object.keys(input).some((x) => x !== "preview_id") ||
        (input.preview_id !== undefined && typeof input.preview_id !== "string")
      )
        throw new CsvStagingError("mapping_invalid");
      return c.json({
        data: await port.preview(a, run, input.preview_id, c.req.raw.signal),
      });
    } catch (error) {
      safeFailure(error);
    }
  });
  const pagination = <B2 extends object>(c: Context<ApiContext<B2>>) => {
    const raw = c.req.query("per_page") ?? "100";
    if (!/^[1-9][0-9]{0,2}$/.test(raw) || Number(raw) > 100)
      throw new CsvStagingError("mapping_invalid");
    return {
      limit: Number(raw),
      ...(c.req.query("cursor") ? { cursor: c.req.query("cursor")! } : {}),
      ...(c.req.query("preview_id")
        ? { previewId: c.req.query("preview_id")! }
        : {}),
    };
  };
  api.get("/csv-imports/:runId/errors", async (c) => {
    try {
      const kind = c.req.query("kind");
      if (
        kind !== undefined &&
        kind !== "invalid" &&
        kind !== "unsupported" &&
        kind !== "warning"
      )
        throw new CsvStagingError("mapping_invalid");
      const data = await port.errors(authority(c), c.req.param("runId"), {
        ...pagination(c),
        ...(kind ? { kind } : {}),
      });
      return c.json({ data });
    } catch (error) {
      safeFailure(error);
    }
  });
  api.get("/csv-imports/:runId/catalog", async (c) => {
    try {
      const kind = c.req.query("kind"),
        previewId = c.req.query("preview_id");
      if (
        !previewId ||
        !["people", "clients", "projects", "tasks"].includes(kind ?? "")
      )
        throw new CsvStagingError("mapping_invalid");
      const data = await port.catalog(authority(c), c.req.param("runId"), {
        ...pagination(c),
        kind: kind as "people" | "clients" | "projects" | "tasks",
        previewId,
        ...(c.req.query("source_key")
          ? { sourceKey: c.req.query("source_key")! }
          : {}),
      });
      return c.json({ data });
    } catch (error) {
      safeFailure(error);
    }
  });
  api.get("/csv-imports/:runId/diagnostics", async (c) => {
    try {
      const text = await port.diagnostics(
        authority(c),
        c.req.param("runId"),
        c.req.query("preview_id"),
      );
      return new Response(text, {
        headers: {
          "content-type": "application/json",
          "content-disposition": 'attachment; filename="csv-diagnostics.json"',
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    } catch (error) {
      safeFailure(error);
    }
  });
  api.delete("/csv-imports/:runId/input", async (c) => {
    try {
      await port.purge(authority(c), c.req.param("runId"));
      return c.body(null, 204);
    } catch (error) {
      safeFailure(error);
    }
  });
};

export {authority as csvStagingAuthority,safeFailure as csvStagingSafeFailure};
