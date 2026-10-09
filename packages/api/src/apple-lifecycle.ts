import type { Hono } from "hono";
import type { AppleLifecycleStore } from "@ezacto/core";
import type { ApiContext } from "./context.js";
import { ApiError, readJsonBody, validationError } from "./errors.js";
import {
  appleInstanceOrigin,
  AppleProofUnavailable,
  createAppleLifecycleVerifier,
  type AppleLifecycleVerifier,
} from "./apple-lifecycle-proof.js";

export interface AppleLifecycleOptions<Bindings extends object> {
  store: AppleLifecycleStore;
  origin(bindings: Bindings): string | undefined;
  clock(): string;
  verifier?: AppleLifecycleVerifier;
}

export function installAppleLifecycleRoutes<Bindings extends object>(
  app: Hono<ApiContext<Bindings>>,
  options: AppleLifecycleOptions<Bindings>,
): void {
  const persist = async <T>(action:()=>Promise<T>):Promise<T> => {
    try { return await action(); }
    catch { throw new ApiError({status:503,code:"apple_cleanup_unavailable",message:"Apple cleanup storage is temporarily unavailable."}); }
  };
  const verifier = options.verifier ?? createAppleLifecycleVerifier();
  for (const action of ["binding", "revocation"] as const) {
    app.post(`/auth/apple/deletion-requests/:id/${action}`, async (context) => {
      context.header("cache-control", "no-store");
      context.header("referrer-policy", "no-referrer");
      const origin = appleInstanceOrigin(options.origin(context.env));
      if (!origin)
        throw new ApiError({
          status: 503,
          code: "apple_cleanup_unavailable",
          message: "Apple cleanup verification is unavailable.",
        });
      const now = options.clock();
      if (!(await persist(()=>options.store.allowProof(now)))) {
        context.header("retry-after", "60");
        throw new ApiError({
          status: 429,
          code: "rate_limited",
          message: "Try Apple cleanup delivery again shortly.",
        });
      }
      const body = await readJsonBody<unknown>(context, { maxBytes: 17_408 });
      if (
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => key !== "receipt") ||
        !("receipt" in body) ||
        typeof body.receipt !== "string" ||
        body.receipt.length > 16_384
      )
        throw validationError([
          {
            field: "receipt",
            code: "invalid",
            message: "Supply only the signed cleanup receipt.",
          },
        ]);
      let proof;
      try {
        proof = await verifier.verify(body.receipt, origin);
      } catch (error) {
        if (error instanceof AppleProofUnavailable)
          throw new ApiError({
            status: 503,
            code: "apple_cleanup_unavailable",
            message: "Apple cleanup verification is temporarily unavailable.",
          });
        throw error;
      }
      if (!proof)
        throw new ApiError({
          status: 401,
          code: "invalid_apple_proof",
          message: "The Apple cleanup proof could not be authenticated.",
        });
      const requestId = context.req.param("id");
      const accepted =
        proof.requestId === requestId &&
        (action === "binding"
          ? proof.type === "apple_grant" &&
            proof.purpose === "cleanup" &&
            (await persist(()=>options.store.rebind({ ...proof, requestId, now })))
          : proof.type === "apple_revocation" &&
            (await persist(()=>options.store.acceptRevocation({ ...proof, now }))));
      if (!accepted)
        throw new ApiError({
          status: 409,
          code: "receipt_not_accepted",
          message: "This cleanup proof was not accepted for the request.",
        });
      return context.body(null, 204);
    });
  }
}
