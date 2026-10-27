import type { Hono } from "hono";
import {
  BankDepositReviewError,
  type BankDepositRow,
  type BankReviewAuthority,
  type BankFeedAccount,
  type BankReviewInvoice,
} from "@ezacto/core";
import type { ApiContext } from "./context.js";
import { requireSessionPrincipal } from "./auth.js";
import { ApiError, validationError } from "./errors.js";
import {
  readObjectBody,
  unknownFieldErrors,
  assertFields,
} from "./resources/support.js";
export interface BankDepositReviewApi {
  accounts(who: BankReviewAuthority): Promise<BankFeedAccount[]>;
  list(
    who: BankReviewAuthority,
    input: {
      state?: BankDepositRow["state"];
      page?: number;
      per_page?: number;
    },
  ): Promise<{
    data: BankDepositRow[];
    page: number;
    per_page: number;
    total: number;
  }>;
  candidates(
    who: BankReviewAuthority,
    id: number,
    query: string,
  ): Promise<BankReviewInvoice[]>;
  act(
    who: BankReviewAuthority,
    input: {
      command_id: string;
      deposit_id: number;
      expected_version: number;
      operation: "assign" | "reject" | "reopen" | "verify";
      invoice_id?: number;
      verification_reference?: string;
    },
  ): Promise<BankDepositRow | null>;
  confirm(
    who: BankReviewAuthority,
    input: {
      command_id: string;
      deposit_id: number;
      expected_version: number;
      invoice_id: number;
      expected_invoice_version: number;
      confirm_overpayment: boolean;
    },
  ): Promise<BankDepositRow | null>;
}
export const installBankDepositRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  service: BankDepositReviewApi,
  feeds?: {
    status(): Promise<
      Array<{
        provider: "mercury" | "wise";
        configured: boolean;
        account_name: string | null;
        last_synced_at: string | null;
        last_error: string | null;
        next_poll_at: string | null;
      }>
    >;
    processDue(): Promise<{ checked: number; failed: number }>;
  },
): void => {
  const who = (
    c: Parameters<typeof requireSessionPrincipal<Bindings>>[0],
  ): BankReviewAuthority => {
    const p = requireSessionPrincipal(c);
    if (
      p.type !== "user" ||
      !["administrator", "accounting"].includes(p.profile)
    )
      throw new ApiError({
        status: 403,
        code: "profile_forbidden",
        message: "Only administrators and accounting can review bank deposits.",
      });
    return { userId: p.userId, sessionId: p.authentication.sessionId };
  };
  const integer = (value: unknown, field: string, minimum = 1) => {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < minimum
    )
      throw validationError([
        { field, code: "invalid", message: "Provide a valid integer." },
      ]);
    return value;
  };
  const id = (value: string) => integer(Number(value), "id");
  const run = async <T>(action: () => Promise<T>): Promise<T> => {
    try {
      return await action();
    } catch (error) {
      if (error instanceof BankDepositReviewError)
        throw new ApiError({
          status:
            error.code === "forbidden"
              ? 403
              : error.code === "not_found"
                ? 404
                : error.code === "invalid"
                  ? 422
                  : 409,
          code: "bank_deposit_" + error.code,
          message: error.message,
          ...(error.code === "invalid"
            ? {
                fields: [
                  { field: "body", code: "invalid", message: error.message },
                ],
              }
            : {}),
        });
      throw error;
    }
  };
  api.get("/bank-feed-status", async (c) => {
    who(c);
    return c.json(
      {
        data: feeds
          ? await feeds.status()
          : ["mercury", "wise"].map((provider) => ({
              provider,
              configured: false,
              account_name: null,
              last_synced_at: null,
              last_error: null,
              next_poll_at: null,
            })),
      },
      200,
      { "cache-control": "no-store" },
    );
  });
  api.post("/bank-feeds/sync", async (c) => {
    who(c);
    const body = await readObjectBody(c);
    assertFields(unknownFieldErrors(body, new Set()));
    return c.json(
      { data: feeds ? await feeds.processDue() : { checked: 0, failed: 0 } },
      200,
      { "cache-control": "no-store" },
    );
  });
  api.get("/bank-deposit-accounts", async (c) =>
    c.json({ data: await run(() => service.accounts(who(c))) }, 200, {
      "cache-control": "no-store",
    }),
  );
  api.get("/bank-deposits", async (c) => {
    const authority = who(c),
      q = new URL(c.req.url).searchParams;
    const input = {
      ...(q.has("state")
        ? { state: q.get("state") as BankDepositRow["state"] }
        : {}),
      ...(q.has("page")
        ? { page: integer(Number(q.get("page")), "page") }
        : {}),
      ...(q.has("per_page")
        ? { per_page: integer(Number(q.get("per_page")), "per_page") }
        : {}),
    };
    return c.json(await run(() => service.list(authority, input)), 200, {
      "cache-control": "no-store",
    });
  });
  api.get("/bank-deposits/:id/invoices", async (c) =>
    c.json(
      {
        data: await run(() =>
          service.candidates(
            who(c),
            id(c.req.param("id")),
            c.req.query("query") ?? "",
          ),
        ),
      },
      200,
      { "cache-control": "no-store" },
    ),
  );
  for (const operation of [
    "assign",
    "reject",
    "reopen",
    "confirm",
    "verify-source",
  ] as const)
    api.post("/bank-deposits/:id/" + operation, async (c) => {
      const authority = who(c);
      if (
        operation === "verify-source" &&
        c.get("principal").profile !== "administrator"
      )
        throw new ApiError({
          status: 403,
          code: "profile_forbidden",
          message: "Only administrators can attest uncertain source funds.",
        });
      const body = await readObjectBody(c);
      assertFields(
        unknownFieldErrors(
          body,
          new Set([
            "expected_version",
            ...(operation === "verify-source"
              ? [
                  "verification_reference",
                  "confirm_posted_funds",
                  "confirm_external_credit",
                ]
              : []),
            ...(operation === "assign" || operation === "confirm"
              ? ["invoice_id"]
              : []),
            ...(operation === "confirm"
              ? ["expected_invoice_version", "confirm_overpayment"]
              : []),
          ]),
        ),
      );
      const command = c.req.header("Idempotency-Key");
      if (!command || !/^[A-Za-z0-9._:-]{1,128}$/.test(command))
        throw validationError([
          {
            field: "Idempotency-Key",
            code: "required",
            message: "Provide a stable command identity.",
          },
        ]);
      const input = {
        command_id: command,
        deposit_id: id(c.req.param("id") ?? ""),
        expected_version: integer(body.expected_version, "expected_version", 0),
      };
      let result: BankDepositRow | null;
      if (operation === "confirm") {
        if (typeof body.confirm_overpayment !== "boolean")
          throw validationError([
            {
              field: "confirm_overpayment",
              code: "required",
              message: "Review whether this deposit exceeds the balance.",
            },
          ]);
        result = await run(() =>
          service.confirm(authority, {
            ...input,
            invoice_id: integer(body.invoice_id, "invoice_id"),
            expected_invoice_version: integer(
              body.expected_invoice_version,
              "expected_invoice_version",
              0,
            ),
            confirm_overpayment: body.confirm_overpayment as boolean,
          }),
        );
      } else if (operation === "verify-source") {
        if (
          body.confirm_posted_funds !== true ||
          body.confirm_external_credit !== true ||
          typeof body.verification_reference !== "string"
        )
          throw validationError([
            {
              field: "verification_reference",
              code: "required",
              message:
                "Record the provider reference and explicitly verify posted external funds.",
            },
          ]);
        result = await run(() =>
          service.act(authority, {
            ...input,
            operation: "verify",
            verification_reference: body.verification_reference as string,
          }),
        );
      } else
        result = await run(() =>
          service.act(authority, {
            ...input,
            operation,
            ...(operation === "assign"
              ? { invoice_id: integer(body.invoice_id, "invoice_id") }
              : {}),
          }),
        );
      if (!result)
        throw new ApiError({
          status: 409,
          code: "bank_deposit_changed",
          message: "The deposit is no longer available.",
        });
      return c.json({ data: result }, 200, { "cache-control": "no-store" });
    });
};
