import {
  CalendarConnectionError,
  CalendarSyncLimitError,
  type CalendarConnectionAuthority,
  type CalendarCleanupStatus,
  type CalendarConnectionSummary,
  type CalendarProvider,
} from "@ezacto/core";
import type { Hono } from "hono";
import { requireSessionPrincipal } from "./auth.js";
import type { ApiContext } from "./context.js";
import { ApiError } from "./errors.js";
import {
  assertFields,
  readObjectBody,
  requiredPositiveInteger,
  unknownFieldErrors,
} from "./resources/support.js";

export interface CalendarConnectionPort {
  cleanupStatus(
    authority: CalendarConnectionAuthority,
  ): Promise<CalendarCleanupStatus>;
  connections(
    authority: CalendarConnectionAuthority,
  ): Promise<readonly (CalendarConnectionSummary & { available: boolean })[]>;
  disconnect(
    authority: CalendarConnectionAuthority,
    provider: CalendarProvider,
    expectedGeneration: number,
  ): Promise<void>;
  refresh(
    authority: CalendarConnectionAuthority,
    provider: CalendarProvider,
    signal?: AbortSignal,
    days?: { past?: number; future?: number },
  ): Promise<{ state: "connected" | "needs_reauth"; applied: number }>;
}
const provider = (value: string): CalendarProvider => {
  if (value !== "google" && value !== "microsoft")
    throw new ApiError({
      status: 404,
      code: "not_found",
      message: "The calendar provider does not exist.",
    });
  return value;
};
const authority = (
  principal: ReturnType<typeof requireSessionPrincipal>,
): CalendarConnectionAuthority => ({
  userId: principal.userId,
  sessionId: Number(principal.authentication.sessionId),
});
const safe = (error: unknown): never => {
  if (error instanceof ApiError) throw error;
  if (error instanceof CalendarConnectionError) {
    const status =
      error.code === "forbidden"
        ? 403
        : error.code === "changed" ||
            error.code === "busy" ||
            error.code === "not_configured" ||
            error.code === "not_connected"
          ? 409
          : error.code === "invalid"
            ? 400
            : 503;
    throw new ApiError({
      status,
      code: `calendar_${error.code}`,
      message: "The calendar connection operation could not be completed.",
    });
  }
  if (error instanceof CalendarSyncLimitError)
    throw new ApiError({
      status: 422,
      code: "calendar_sync_limit",
      message: "The calendar read exceeded its supported size.",
      fields: [
        {
          field: "window",
          code: "too_large",
          message: "Choose a smaller calendar window.",
        },
      ],
    });
  throw new ApiError({
    status: 503,
    code: "calendar_unavailable",
    message: "The calendar connection is temporarily unavailable.",
  });
};
export const installCalendarConnectionRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  port: CalendarConnectionPort,
) => {
  api.get("/calendar-cleanup-status", async (c) => {
    try {
      return c.json(
        {
          data: await port.cleanupStatus(authority(requireSessionPrincipal(c))),
        },
        200,
        { "cache-control": "no-store" },
      );
    } catch (error) {
      return safe(error);
    }
  });
  api.get("/calendar-connections", async (c) => {
    try {
      const rows = await port.connections(
        authority(requireSessionPrincipal(c)),
      );
      return c.json(
        {
          data: rows.map((row) => ({
            provider: row.provider,
            status: row.state,
            generation: row.generation,
            last_synced_at: row.lastSyncedAt,
            last_error: row.lastError,
            syncing: row.syncing,
            cleanup_pending: row.cleanupPending,
            available: row.available,
          })),
        },
        200,
        { "cache-control": "no-store" },
      );
    } catch (error) {
      return safe(error);
    }
  });
  api.delete("/calendar-connections/:provider", async (c) => {
    try {
      const actor = authority(requireSessionPrincipal(c)),
        kind = provider(c.req.param("provider")),
        body = await readObjectBody(c),
        errors = unknownFieldErrors(body, new Set(["generation"]));
      const generation = requiredPositiveInteger(body, "generation", errors);
      assertFields(errors);
      await port.disconnect(actor, kind, generation!);
      return c.body(null, 204, { "cache-control": "no-store" });
    } catch (error) {
      return safe(error);
    }
  });
  api.post("/calendar-connections/:provider/refresh", async (c) => {
    try {
      const actor = authority(requireSessionPrincipal(c)),
        kind = provider(c.req.param("provider")),
        body = await readObjectBody(c);
      const errors = unknownFieldErrors(
        body,
        new Set(["past_days", "future_days"]),
      );
      for (const key of ["past_days", "future_days"])
        if (
          body[key] !== undefined &&
          (!Number.isInteger(body[key]) ||
            Number(body[key]) < 0 ||
            Number(body[key]) > 90)
        )
          errors.push({
            field: key,
            code: "invalid",
            message: "Use a whole number from zero through 90.",
          });
      if (
        (body.past_days !== undefined || body.future_days !== undefined) &&
        Number(body.past_days ?? 14) + Number(body.future_days ?? 0) === 0
      )
        errors.push({
          field: "past_days",
          code: "invalid",
          message: "Choose a non-empty calendar window.",
        });
      assertFields(errors);
      const days =
        body.past_days !== undefined || body.future_days !== undefined
          ? {
              ...(body.past_days !== undefined
                ? { past: Number(body.past_days) }
                : {}),
              ...(body.future_days !== undefined
                ? { future: Number(body.future_days) }
                : {}),
            }
          : undefined;
      return c.json(
        { data: await port.refresh(actor, kind, c.req.raw.signal, days) },
        200,
        { "cache-control": "no-store" },
      );
    } catch (error) {
      return safe(error);
    }
  });
};
