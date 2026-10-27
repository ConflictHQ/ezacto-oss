import type { Hono } from "hono";
import {
  CalendarAuthorizationError,
  CalendarConnectionError,
  type CalendarConnectionAuthority,
  type CalendarProvider,
} from "@ezacto/core";
import type { ApiContext } from "./context.js";
import {
  requireSessionPrincipal,
  requireSameOriginForUnsafeSessionRequest,
} from "./auth.js";
import { ApiError, validationError } from "./errors.js";
import {
  readObjectBody,
  unknownFieldErrors,
  assertFields,
} from "./resources/support.js";

export interface CalendarAuthorizationPort {
  manualCleanup(authority: CalendarConnectionAuthority): Promise<
    readonly {
      id: string;
      generation: number;
      credential_revision: number;
      reason: "disconnect" | "reauth";
      created_at: string;
    }[]
  >;
  confirmManualCleanup(
    authority: CalendarConnectionAuthority,
    input: { id: string; generation: number; credentialRevision: number },
  ): Promise<void>;
  begin(
    authority: CalendarConnectionAuthority,
    provider: CalendarProvider,
    generation: number,
    origin: string,
  ): Promise<{ requester: string; authorizationUrl: string }>;
  complete(
    authority: CalendarConnectionAuthority,
    provider: CalendarProvider,
    input: {
      state: string;
      requester: string;
      code?: string;
      denied: boolean;
      consentRequired?: boolean;
      requestOrigin: string;
    },
  ): Promise<void>;
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
const cookieName = (kind: CalendarProvider) => `__Host-ezacto_calendar_${kind}`;
const cookie = (kind: CalendarProvider, value: string, seconds = 600) =>
  `${cookieName(kind)}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
const requiresTenantAdmin = (url: URL): boolean => {
  const codes = url.searchParams.get("error_codes") ?? "";
  const description = url.searchParams.get("error_description") ?? "";
  if (codes.length > 200 || description.length > 4096) return false;
  return (
    /(?:^|[^0-9])(?:90093|90094|900941)(?:[^0-9]|$)/.test(codes) ||
    /\bAADSTS(?:90093|90094|900941)\b/.test(description)
  );
};
const requester = (request: Request, kind: CalendarProvider) => {
  const values = (request.headers.get("cookie") ?? "")
    .split(";")
    .map((v) => v.trim())
    .filter((v) => v.startsWith(cookieName(kind) + "="));
  return values.length === 1
    ? values[0]!.slice(cookieName(kind).length + 1)
    : "";
};
export const installCalendarAuthorizationRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  port: CalendarAuthorizationPort,
) => {
  api.get("/calendar-connections/:provider/cleanup", async (c) => {
    const p = requireSessionPrincipal(c);
    if (provider(c.req.param("provider")) !== "microsoft")
      throw new ApiError({
        status: 404,
        code: "not_found",
        message: "This provider uses automatic cleanup.",
      });
    const data = await port.manualCleanup({
      userId: p.userId,
      sessionId: Number(p.authentication.sessionId),
    });
    return c.json({ data }, 200, { "cache-control": "no-store" });
  });
  api.post("/calendar-connections/:provider/cleanup/confirm", async (c) => {
    const p = requireSessionPrincipal(c);
    requireSameOriginForUnsafeSessionRequest(c.req.raw);
    if (provider(c.req.param("provider")) !== "microsoft")
      throw new ApiError({
        status: 404,
        code: "not_found",
        message: "This provider uses automatic cleanup.",
      });
    const body = await readObjectBody(c);
    assertFields(
      unknownFieldErrors(
        body,
        new Set([
          "obligation_id",
          "generation",
          "credential_revision",
          "confirm_removed",
        ]),
      ),
    );
    if (
      typeof body.obligation_id !== "string" ||
      !/^[a-f0-9]{64}$/.test(body.obligation_id) ||
      body.confirm_removed !== true ||
      !Number.isSafeInteger(body.generation) ||
      Number(body.generation) < 1 ||
      !Number.isSafeInteger(body.credential_revision) ||
      Number(body.credential_revision) < 1
    )
      throw validationError([
        {
          field: "body",
          code: "invalid",
          message:
            "Review the exact cleanup record and confirm provider permission removal.",
        },
      ]);
    try {
      await port.confirmManualCleanup(
        { userId: p.userId, sessionId: Number(p.authentication.sessionId) },
        {
          id: body.obligation_id,
          generation: Number(body.generation),
          credentialRevision: Number(body.credential_revision),
        },
      );
    } catch (error) {
      if (error instanceof CalendarConnectionError)
        throw new ApiError({
          status: error.code === "forbidden" ? 403 : 409,
          code: "calendar_cleanup_changed",
          message: "The cleanup record changed. Refresh and review it again.",
        });
      throw error;
    }
    return c.body(null, 204, { "cache-control": "no-store" });
  });
  api.post("/calendar-connections/:provider/authorize", async (c) => {
    const p = requireSessionPrincipal(c),
      kind = provider(c.req.param("provider"));
    requireSameOriginForUnsafeSessionRequest(c.req.raw);
    const body = await readObjectBody(c);
    assertFields(unknownFieldErrors(body, new Set(["generation"])));
    if (
      typeof body.generation !== "number" ||
      !Number.isSafeInteger(body.generation) ||
      body.generation < 0
    )
      throw validationError([
        {
          field: "generation",
          code: "invalid",
          message: "Use the current connection generation.",
        },
      ]);
    try {
      const result = await port.begin(
        { userId: p.userId, sessionId: Number(p.authentication.sessionId) },
        kind,
        body.generation,
        new URL(c.req.url).origin,
      );
      c.header("set-cookie", cookie(kind, result.requester), { append: true });
      return c.json(
        { data: { authorization_url: result.authorizationUrl } },
        200,
        { "cache-control": "no-store", "referrer-policy": "no-referrer" },
      );
    } catch (error) {
      if (error instanceof CalendarConnectionError)
        throw new ApiError({
          status:
            error.code === "forbidden"
              ? 403
              : error.code === "not_configured" ||
                  error.code === "changed" ||
                  error.code === "busy"
                ? 409
                : error.code === "invalid"
                  ? 400
                  : 503,
          code: "calendar_authorization_unavailable",
          message:
            "Calendar authorization could not begin. Refresh this page and try again.",
        });
      throw error;
    }
  });
  api.get("/calendar-connections/:provider/callback", async (c) => {
    const p = requireSessionPrincipal(c),
      kind = provider(c.req.param("provider")),
      url = new URL(c.req.url);
    let result = "failed";
    try {
      await port.complete(
        { userId: p.userId, sessionId: Number(p.authentication.sessionId) },
        kind,
        {
          state:
            url.searchParams.getAll("state").length === 1
              ? url.searchParams.get("state")!
              : "",
          requester: requester(c.req.raw, kind),
          ...(url.searchParams.has("code")
            ? { code: url.searchParams.get("code")! }
            : {}),
          denied: url.searchParams.has("error"),
          consentRequired:
            kind === "microsoft" &&
            url.searchParams.has("error") &&
            requiresTenantAdmin(url),
          requestOrigin: url.origin,
        },
      );
      result = "connected";
      c.header("set-cookie", cookie(kind, "", 0), { append: true });
    } catch (error) {
      if (
        error instanceof CalendarConnectionError &&
        error.code === "consent_required"
      )
        result = "admin_consent_required";
      // Expected refusals produce a fixed UI result; unexpected storage faults
      // still reach the runtime diagnostics without a provider payload.
      if (
        !(error instanceof CalendarConnectionError) &&
        !(error instanceof CalendarAuthorizationError)
      )
        throw error;
    }
    c.header("cache-control", "no-store");
    c.header("referrer-policy", "no-referrer");
    return c.redirect(
      `/settings/user?calendar=${result}&provider=${kind}`,
      303,
    );
  });
};
