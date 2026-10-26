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
              : error.code === "not_configured"
                ? 409
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
          state: url.searchParams.get("state") ?? "",
          requester: requester(c.req.raw, kind),
          ...(url.searchParams.has("code")
            ? { code: url.searchParams.get("code")! }
            : {}),
          denied: url.searchParams.has("error"),
          requestOrigin: url.origin,
        },
      );
      result = "connected";
      c.header("set-cookie", cookie(kind, "", 0), { append: true });
    } catch (error) {
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
