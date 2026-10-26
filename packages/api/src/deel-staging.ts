import type { Context, Hono } from "hono";
import {
  DeelStageError,
  type DeelStageAuthority,
  type DeelStageCommand,
  type DeelStagePreview,
  type DeelStageResult,
  type DeelStageSelection,
} from "@ezacto/core";
import type { ApiContext } from "./context.js";
import { requireSessionPrincipal } from "./auth.js";
import { ApiError } from "./errors.js";
import {
  assertFields,
  readObjectBody,
  unknownFieldErrors,
} from "./resources/support.js";
export interface DeelStagingApiRuntime {
  configured: boolean;
  bounds(): { from: string; to: string } | null;
  preview(
    authority: DeelStageAuthority,
    selection: DeelStageSelection,
  ): Promise<DeelStagePreview>;
  stage(
    authority: DeelStageAuthority,
    command: DeelStageCommand,
  ): Promise<DeelStageResult>;
  lookup(
    authority: DeelStageAuthority,
    command: DeelStageCommand,
  ): Promise<DeelStageResult | null>;
}
const selection = (body: Record<string, unknown>): DeelStageSelection => {
  if (
    typeof body.from !== "string" ||
    typeof body.to !== "string" ||
    !Array.isArray(body.user_ids) ||
    body.user_ids.length < 1 ||
    body.user_ids.length > 100 ||
    body.user_ids.some((id) => !Number.isSafeInteger(id) || id < 1) ||
    new Set(body.user_ids).size !== body.user_ids.length
  )
    throw new ApiError({
      status: 422,
      fields: [
        {
          field: "selection",
          code: "invalid",
          message: "Use the reviewed selection and command.",
        },
      ],
      code: "invalid_deel_selection",
      message: "Choose one to 100 distinct people and a date range.",
    });
  return { from: body.from, to: body.to, userIds: body.user_ids as number[] };
};
const command = (body: Record<string, unknown>): DeelStageCommand => {
  if (
    typeof body.command_id !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      body.command_id,
    ) ||
    typeof body.preview_fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(body.preview_fingerprint)
  )
    throw new ApiError({
      status: 422,
      fields: [
        {
          field: "selection",
          code: "invalid",
          message: "Use the reviewed selection and command.",
        },
      ],
      code: "invalid_deel_command",
      message: "Use the command and fingerprint for the reviewed preview.",
    });
  return {
    ...selection(body),
    id: body.command_id,
    fingerprint: body.preview_fingerprint,
  };
};
const serialize = (r: DeelStageResult) => ({
  status: r.status,
  command_id: r.commandId,
  run_id: r.runId,
  timesheets_staged: r.timesheetsStaged,
  entries_staged: r.entriesStaged,
  already_staged: r.alreadyStaged,
  unresolved_entry_ids: r.unresolved,
  code: r.code,
});
const translate = (error: unknown): never => {
  if (error instanceof DeelStageError)
    throw new ApiError({
      status:
        error.code === "forbidden"
          ? 403
          : error.code === "invalid"
            ? 422
            : error.code === "provider_unavailable"
              ? 503
              : 409,
      ...(error.code === "invalid"
        ? {
            fields: [
              {
                field: "selection",
                code: "invalid",
                message:
                  "Choose a valid completed range and active Deel people.",
              },
            ],
          }
        : {}),
      code: `deel_stage_${error.code}`,
      message: {
        unconfigured: "Configure Deel time sync before staging hours.",
        invalid:
          "Choose active Deel people and a completed date range within the sync start date.",
        forbidden: "A current native administrator session is required.",
        stale:
          "The approved hours, contract match or prior sync changed. Review a fresh preview; unresolved transfers must be checked in Deel.",
        provider_unavailable:
          "Deel could not be reached for review. Nothing was staged.",
        command_reused:
          "This command belongs to a different reviewed selection.",
      }[error.code],
    });
  throw error;
};
export const installDeelStagingRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  runtime: DeelStagingApiRuntime,
) => {
  const authority = (
    context: Context<ApiContext<Bindings>>,
  ): DeelStageAuthority => {
    const p = requireSessionPrincipal(context);
    const sessionId = Number(p.authentication.sessionId);
    if (
      p.profile !== "administrator" ||
      !Number.isSafeInteger(sessionId) ||
      sessionId < 1
    )
      throw new ApiError({
        status: 403,
        code: "profile_forbidden",
        message:
          "Only a native administrator session may stage approved hours.",
      });
    return { userId: p.userId, sessionId };
  };
  api.use("/deel-staging/*", async (c, next) => {
    authority(c);
    c.header("Cache-Control", "no-store");
    await next();
  });
  api.get("/deel-staging", async (c) => {
    authority(c);
    const bounds = runtime.bounds();
    return c.json(
      {
        data: {
          configured: runtime.configured,
          start_date: bounds?.from ?? null,
          last_complete_date: bounds?.to ?? null,
          reason: runtime.configured
            ? null
            : "Configure a Deel token and sync start date before staging approved hours.",
        },
      },
      200,
      { "cache-control": "no-store" },
    );
  });
  api.post("/deel-staging/preview", async (c) => {
    const actor = authority(c),
      body = await readObjectBody(c);
    assertFields(unknownFieldErrors(body, new Set(["from", "to", "user_ids"])));
    try {
      const p = await runtime.preview(actor, selection(body));
      return c.json({
        data: {
          status: p.status,
          from: p.selection.from,
          to: p.selection.to,
          user_ids: p.selection.userIds,
          preview_fingerprint: p.fingerprint,
          entry_ids: p.entryIds,
          seconds: p.seconds,
          timesheets: p.timesheets,
          already_staged: p.alreadyStaged,
          people: p.people.map((x) => ({
            user_id: x.userId,
            contract_id: x.contractId,
            seconds: x.seconds,
            entries: x.entries,
          })),
          conflict_entry_ids: p.conflicts,
          unsyncable_entry_ids: p.unsyncable,
          unmatched: p.unmatched.map((x) => ({
            user_id: x.userId,
            reason: x.reason,
          })),
          unresolved_entry_ids: p.unresolved,
        },
      });
    } catch (error) {
      return translate(error);
    }
  });
  api.post("/deel-staging/commands", async (c) => {
    const actor = authority(c),
      body = await readObjectBody(c);
    assertFields(
      unknownFieldErrors(
        body,
        new Set([
          "from",
          "to",
          "user_ids",
          "command_id",
          "preview_fingerprint",
        ]),
      ),
    );
    const requested = command(body);
    if (c.req.header("Idempotency-Key") !== requested.id)
      throw new ApiError({
        status: 422,
        fields: [
          {
            field: "selection",
            code: "invalid",
            message: "Use the reviewed selection and command.",
          },
        ],
        code: "idempotency_key_required",
        message: "The idempotency key must match the reviewed command.",
      });
    try {
      return c.json({ data: serialize(await runtime.stage(actor, requested)) });
    } catch (error) {
      return translate(error);
    }
  });
  api.post("/deel-staging/status", async (c) => {
    const actor = authority(c),
      body = await readObjectBody(c);
    assertFields(
      unknownFieldErrors(
        body,
        new Set([
          "from",
          "to",
          "user_ids",
          "command_id",
          "preview_fingerprint",
        ]),
      ),
    );
    try {
      const result = await runtime.lookup(actor, command(body));
      return c.json({ data: result === null ? null : serialize(result) });
    } catch (error) {
      return translate(error);
    }
  });
};
