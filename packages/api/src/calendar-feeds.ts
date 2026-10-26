import type { Hono, Context } from "hono";
import {
  CalendarFeedError,
  CalendarFeedInputError,
  parseCalendarFeedAuthorization,
  type CalendarFeedAuthority,
  type CalendarFeedInput,
  type CalendarFeedService,
} from "@ezacto/core";
import type { ApiContext } from "./context.js";
import { requireSessionPrincipal } from "./auth.js";
import { ApiError, validationError } from "./errors.js";
import {
  assertFields,
  readObjectBody,
  unknownFieldErrors,
} from "./resources/support.js";
const headers = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-robots-tag": "noindex",
  "x-content-type-options": "nosniff",
};
const actor = <B extends object>(
  context: Context<ApiContext<B>>,
): CalendarFeedAuthority => {
  const principal = requireSessionPrincipal(context),
    sessionId = Number(principal.authentication.sessionId);
  if (!Number.isSafeInteger(sessionId) || sessionId < 1)
    throw new ApiError({
      status: 403,
      code: "forbidden",
      message: "A native session is required.",
    });
  return { userId: principal.userId, sessionId };
};
const error = (cause: unknown): never => {
  if (cause instanceof CalendarFeedError) {
    if (cause.code === "invalid")
      throw validationError([
        { field: "calendar_feed", code: "invalid", message: cause.message },
      ]);
    throw new ApiError({
      status: (
        {
          forbidden: 403,
          not_found: 404,
          conflict: 409,
          rate_limited: 429,
        } as const
      )[cause.code],
      code: `calendar_feed_${cause.code}`,
      message: cause.message,
    });
  }
  if (cause instanceof CalendarFeedInputError)
    throw validationError([
      { field: "calendar_feed", code: "invalid", message: cause.message },
    ]);
  throw cause;
};
export const installCalendarFeedRoutes = <B extends object>(
  api: Hono<ApiContext<B>>,
  service: CalendarFeedService,
) => {
  api.get("/calendar-feeds", async (c) => {
    try {
      return c.json({ data: await service.list(actor(c)) });
    } catch (e) {
      return error(e);
    }
  });
  api.post("/calendar-feeds", async (c) => {
    const authority = actor(c),
      body = await readObjectBody(c);
    assertFields(
      unknownFieldErrors(
        body,
        new Set([
          "scope",
          "project_id",
          "from_date",
          "through_date",
          "include_names",
          "expires_at",
        ]),
      ),
    );
    if (
      typeof body.scope !== "string" ||
      typeof body.from_date !== "string" ||
      typeof body.through_date !== "string" ||
      typeof body.include_names !== "boolean" ||
      (body.project_id !== null && typeof body.project_id !== "number") ||
      (body.expires_at !== undefined && typeof body.expires_at !== "string")
    )
      throw validationError([
        {
          field: "calendar_feed",
          code: "invalid",
          message: "Choose scope, dates, names and expiry.",
        },
      ]);
    try {
      return c.json(
        {
          data: await service.create(
            authority,
            body as unknown as CalendarFeedInput,
          ),
        },
        201,
      );
    } catch (e) {
      return error(e);
    }
  });
  api.post("/calendar-feeds/:id/rotate", async (c) => {
    try {
      return c.json({
        data: await service.rotate(actor(c), c.req.param("id")),
      });
    } catch (e) {
      return error(e);
    }
  });
  api.delete("/calendar-feeds/:id", async (c) => {
    try {
      await service.revoke(actor(c), c.req.param("id"));
      return c.body(null, 204);
    } catch (e) {
      return error(e);
    }
  });
  api.get("/calendar-feeds/:id/download", async (c) => {
    try {
      return new Response(await service.download(actor(c), c.req.param("id")), {
        headers: {
          ...headers,
          "content-type": "text/calendar; charset=utf-8",
          "content-disposition": 'attachment; filename="ezacto-planning.ics"',
        },
      });
    } catch (e) {
      return error(e);
    }
  });
};
/** External calendar clients authenticate with a separate random scoped password. */
export const installCalendarSubscriptionRoute = <B extends object>(
  app: Hono<ApiContext<B>>,
  service: CalendarFeedService,
) => {
  app.get("/calendar/planning.ics", async (c) => {
    const url=new URL(c.req.url)
    if(url.protocol!=='https:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname.toLowerCase())) return new Response(null,{status:404,headers})
    if (new URL(c.req.url).search)
      return new Response(null, { status: 404, headers });
    const credential = parseCalendarFeedAuthorization(
      c.req.header("authorization") ?? null,
    );
    if (!credential)
      return new Response(null, {
        status: 401,
        headers: {
          ...headers,
          "www-authenticate":
            'Basic realm="eZacto advisory calendar", charset="UTF-8"',
        },
      });
    try {
      return new Response(
        await service.subscribe(credential.id, credential.password),
        {
          headers: {
            ...headers,
            "content-type": "text/calendar; charset=utf-8",
          },
        },
      );
    } catch (e) {
      return new Response(null, {
        status:
          e instanceof CalendarFeedError && e.code === "rate_limited"
            ? 429
            : 404,
        headers: {
          ...headers,
          ...(e instanceof CalendarFeedError && e.code === "rate_limited"
            ? { "retry-after": "60" }
            : {}),
        },
      });
    }
  });
};
