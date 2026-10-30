import {
  ManagedDeelConnectionError,
  type ManagedDeelAuthority,
  type ManagedDeelConnectCommand,
  type ManagedDeelConnectionStore,
  type ManagedDeelDisconnectCommand,
  type ManagedDeelState,
} from "@ezacto/core";
import { createApiApp } from "./app.js";
import {
  requireSessionPrincipal,
  type ApiAuthentication,
  type ApiSessionResolver,
} from "./auth.js";
import { ApiError } from "./errors.js";

export type ManagedDeelConnectionOptions = {
  store: ManagedDeelConnectionStore;
  now?: () => string;
  /** Original unexpected cause, trusted in-process only. Expected 4xx are not reported. */
  reportError?: (error: Error, requestId: string) => void | Promise<void>;
} & (
  | { authentication: ApiAuthentication; guardedUserId?: never }
  /** A fresh trusted host identity, never a caller-supplied user id. The store
   * still checks the current active administrator in SQL; the host proves its
   * own session's freshness and tenant. */
  | {
      guardedUserId: (request: Request) => Promise<number | null | Response>;
      authentication?: never;
    }
);

const expectedFailure = (error: unknown): ApiError | null => {
  if (!(error instanceof ManagedDeelConnectionError)) return null;
  return new ApiError({
    status:
      error.kind === "forbidden" ? 403 : error.kind === "invalid" ? 422 : 409,
    code: `managed_deel_${error.kind}`,
    message:
      error.kind === "forbidden"
        ? "Sign in again as an administrator to change the Deel connection."
        : "The Deel connection changed or the values are not valid. Reopen the settings and retry.",
    ...(error.kind === "invalid"
      ? {
          fields: [
            {
              field: "connection",
              code: "invalid",
              message: "Provide a token and a real start date, then retry.",
            },
          ],
        }
      : {}),
  });
};

/**
 * Private in-process commands for the tenant's Deel connection. They install no
 * public route and make no provider request. Native auth and exact-origin CSRF
 * apply to every call, reads included, because the session can rotate. The token
 * is only ever in the command a trusted host passes; it is never logged or
 * returned, and a failure's body is static.
 */
export const createManagedDeelConnectionCommands = (
  options: ManagedDeelConnectionOptions,
) => {
  const clock = () => options.now?.() ?? new Date().toISOString();
  const invoke = async (
    request: Request,
    work: (
      authority: ManagedDeelAuthority,
      now: string,
    ) => Promise<ManagedDeelState>,
  ) => {
    let result: (ManagedDeelState & { actorUserId: number }) | undefined;
    let original: Error | undefined;
    let guardedRefusal: Response | undefined;
    const fail = (error: unknown): never => {
      const expected = expectedFailure(error);
      if (expected) throw expected;
      original =
        error instanceof Error
          ? error
          : new Error("Managed Deel command failed");
      throw new ApiError({
        status: 503,
        code: "managed_deel_unavailable",
        message: "The Deel connection could not be confirmed. Retry.",
      });
    };
    const sessions: ApiSessionResolver = {
      resolve: async (incoming) => {
        try {
          if (!options.guardedUserId)
            return (
              (await options.authentication?.sessions?.resolve(incoming)) ??
              null
            );
          const userId = await options.guardedUserId(incoming);
          if (userId instanceof Response) {
            if (userId.status < 400 || userId.status > 599)
              throw new Error(
                "Managed Deel identity returned a non-failure response",
              );
            guardedRefusal = userId;
            return null;
          }
          if (userId === null || !Number.isSafeInteger(userId) || userId < 1)
            return null;
          return {
            type: "user",
            userId,
            profile: "administrator",
            managerGrants: [],
            authentication: { kind: "session", sessionId: "managed-host" },
          };
        } catch (error) {
          return fail(error);
        }
      },
    };
    const app = createApiApp({
      authentication: { sessions },
      reportError: (error, requestId) => {
        try {
          void Promise.resolve(
            options.reportError?.(original ?? error, requestId),
          ).catch(() => undefined);
        } catch {
          // A trusted observer cannot alter the command's response.
        }
      },
      installApi: (api) => {
        api.post("/_managed/deel/connection", async (context) => {
          const principal = requireSessionPrincipal(context);
          if (principal.profile !== "administrator")
            throw new ApiError({
              status: 403,
              code: "profile_forbidden",
              message: "An administrator session is required.",
            });
          const sessionId = Number(principal.authentication.sessionId);
          if (
            !options.guardedUserId &&
            (!Number.isSafeInteger(sessionId) || sessionId < 1)
          )
            throw new ApiError({
              status: 403,
              code: "profile_forbidden",
              message: "A native administrator session is required.",
            });
          const authority: ManagedDeelAuthority = options.guardedUserId
            ? { kind: "guarded-session", userId: principal.userId }
            : { kind: "native-session", userId: principal.userId, sessionId };
          try {
            result = {
              ...(await work(authority, clock())),
              actorUserId: principal.userId,
            };
          } catch (error) {
            return fail(error);
          }
          return context.body(null, 204);
        });
      },
    });
    const response = await app.fetch(
      new Request(new URL("/api/v1/_managed/deel/connection", request.url), {
        method: "POST",
        headers: request.headers,
      }),
    );
    if (guardedRefusal) return guardedRefusal;
    if (response.status !== 204 || result === undefined) return response;
    return result;
  };
  return {
    state: (request: Request) =>
      invoke(request, (authority, now) => options.store.state(authority, now)),
    connect: (request: Request, command: ManagedDeelConnectCommand) =>
      invoke(request, (authority, now) =>
        options.store.connect(command, authority, now),
      ),
    disconnect: (request: Request, command: ManagedDeelDisconnectCommand) =>
      invoke(request, (authority, now) =>
        options.store.disconnect(command, authority, now),
      ),
  };
};
