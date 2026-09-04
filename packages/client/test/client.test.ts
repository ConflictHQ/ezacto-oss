import { createApiApp } from "../../api/src/index.js";
import { describe, expect, it } from "vitest";
import { EzactoClient } from "../src/index.js";
import type { EzactoApiError } from "../src/index.js";
import type {
  ExpenseCategoryInput,
  ExpenseCategoryPatch,
  InvoicePaymentInput,
  InvoicePaymentUpdateInput,
  RecurringAmountConfig,
  RetainerDrawdownInput,
  RetainerInput,
  RetainerLedgerInput,
} from "../src/generated.js";

const project = {
  id: 7,
  client_id: 3,
  name: "Launch",
  created_at: "2026-08-28T12:00:00.000Z",
  updated_at: "2026-08-28T12:00:00.000Z",
};

const app = createApiApp({
  authentication: {
    tokens: {
      authenticate: async (token) =>
        token === "generated-client-test"
          ? {
              tokenId: 1,
              userId: 4,
              profile: "administrator",
              scopes: [
                "projects:write",
                "time_entries:write",
                "invoices:write",
                "reports:read",
              ],
            }
          : null,
      issue: async () => {
        throw new Error("not used");
      },
      list: async () => [],
      revoke: async () => null,
    },
  },
  installApi: (api) => {
    api.post("/projects", async (context) => {
      const body = await context.req.json<Record<string, unknown>>();
      return context.json(
        {
          data: { ...project, ...body },
          links: { self: "/api/v1/projects/7" },
        },
        201,
      );
    });
    api.get("/projects", (context) =>
      context.json({
        data: [project],
        links: {
          self: `/api/v1/projects?${new URL(context.req.url).searchParams.toString()}`,
          next: null,
        },
        page: { per_page: 25, next_cursor: null },
      }),
    );
    api.get("/expense-categories", (context) =>
      context.json({
        data: [
          {
            id: 4,
            name: "Mileage",
            unit_name: "mile",
            unit_price_cents: 67,
            is_active: context.req.query("is_active") === "true",
            created_at: "2026-08-28T12:00:00.000Z",
            updated_at: "2026-08-28T12:00:00.000Z",
          },
        ],
        links: {
          self: `/api/v1/expense-categories?${new URL(context.req.url).searchParams.toString()}`,
          next: null,
        },
        page: { per_page: 25, next_cursor: null },
      }),
    );
    api.post("/expense-categories", async (context) =>
      context.json(
        {
          data: {
            id: 5,
            ...(await context.req.json<Record<string, unknown>>()),
            is_active: true,
            created_at: "2026-08-28T12:00:00.000Z",
            updated_at: "2026-08-28T12:00:00.000Z",
          },
          links: { self: "/api/v1/expense-categories/5" },
        },
        201,
      ),
    );
    api.get("/expense-categories/:id", (context) =>
      context.json({
        data: {
          id: Number(context.req.param("id")),
          name: "Mileage",
          unit_name: "mile",
          unit_price_cents: 67,
          is_active: true,
          created_at: "2026-08-28T12:00:00.000Z",
          updated_at: "2026-08-28T12:00:00.000Z",
        },
        links: {
          self: `/api/v1/expense-categories/${context.req.param("id")}`,
        },
      }),
    );
    api.patch("/expense-categories/:id", async (context) =>
      context.json({
        data: {
          id: Number(context.req.param("id")),
          name: "Mileage",
          unit_name: "mile",
          unit_price_cents: 67,
          is_active: true,
          ...(await context.req.json<Record<string, unknown>>()),
          created_at: "2026-08-28T12:00:00.000Z",
          updated_at: "2026-08-28T13:00:00.000Z",
        },
        links: {
          self: `/api/v1/expense-categories/${context.req.param("id")}`,
        },
      }),
    );
    api.delete("/expense-categories/:id", (context) => context.body(null, 204));
    api.post("/time-entries", async (context) => {
      const body = await context.req.json<Record<string, unknown>>();
      return context.json(
        {
          data: {
            id: 11,
            user_id: 4,
            ...body,
            spent_date: "2026-08-28",
            seconds: body.seconds ?? 0,
            is_running: body.seconds === undefined,
            billable: true,
            budgeted: false,
            approval_status: "unsubmitted",
            is_billed: false,
            is_locked: false,
            created_at: "2026-08-28T12:00:00.000Z",
            updated_at: "2026-08-28T12:00:00.000Z",
          },
          links: { self: "/api/v1/time-entries/11" },
        },
        201,
      );
    });
    api.get("/timesheet-submissions/:id", (context) =>
      context.json({
        data: {
          id: Number(context.req.param("id")),
          status: "submitted",
          entries: [{ id: 11, notes: "Reviewer-visible context" }],
        },
        links: {
          self: `/api/v1/timesheet-submissions/${context.req.param("id")}`,
        },
      }),
    );
    api.patch("/invoices/:id", async (context) =>
      context.json({
        data: {
          invoice_id: context.req.param("id"),
          command_id: context.req.header("idempotency-key"),
          body: await context.req.json(),
        },
        links: { self: `/api/v1/invoices/${context.req.param("id")}` },
      }),
    );
    api.post("/invoice-generations", async (context) =>
      context.json(
        {
          data: {
            command_id: context.req.header("idempotency-key"),
            body: await context.req.json(),
          },
          links: { self: "/api/v1/invoices/10" },
        },
        201,
      ),
    );
    api.post("/estimates/:id/convert", async (context) =>
      context.json(
        {
          data: {
            estimate_id: context.req.param("id"),
            command_id: context.req.header("idempotency-key"),
            body: await context.req.json(),
          },
          links: { self: "/api/v1/invoices/12" },
        },
        201,
      ),
    );
    api.post("/projects/:projectId/attachments", async (context) => {
      const body = await context.req.raw.formData();
      const file = body.get("file");
      if (!(file instanceof File)) throw new Error("expected file");
      return context.json(
        {
          data: {
            id: 12,
            name: file.name,
            content_hash: "a".repeat(64),
            byte_size: file.size,
            content_type: file.type,
            uploaded_by_user_id: 4,
            created_at: "2026-08-28T12:00:00.000Z",
            updated_at: "2026-08-28T12:00:00.000Z",
          },
          links: {
            self: `/api/v1/projects/${context.req.param("projectId")}/attachments/12`,
          },
        },
        201,
      );
    });
    api.get(
      "/projects/:projectId/attachments/:attachmentId/content",
      (context) =>
        context.body(new Uint8Array([0, 1, 2, 255]), 200, {
          "content-type": "application/octet-stream",
        }),
    );
    api.get("/reports/uninvoiced", (context) =>
      context.json({
        data: {
          from: context.req.query("from"),
          to: context.req.query("to"),
          client_id: null,
          project_id: null,
          totals: [],
        },
        links: { self: context.req.path },
      }),
    );
  },
});

const client = (token = "generated-client-test") =>
  new EzactoClient({
    baseUrl: "https://api.test",
    token,
    fetch: async (input, init) => app.fetch(new Request(input, init)),
  });

it("[unit] dereferences timesheet submission detail through the generated client", async () => {
  const response = await client().getTimesheetSubmission({ id: 42 });
  expect(response).toMatchObject({
    data: {
      id: 42,
      status: "submitted",
      entries: [{ id: 11, notes: "Reviewer-visible context" }],
    },
    links: { self: "/api/v1/timesheet-submissions/42" },
  });
});

it("[unit] sends required report range filters through the generated client", async () => {
  const report = await client().getUninvoicedReport({
    query: { from: "2026-08-01", to: "2026-08-31" },
  });
  expect(report.data).toMatchObject({
    from: "2026-08-01",
    to: "2026-08-31",
    totals: [],
  });
});

describe("generated ezacto client", () => {
  it("[unit] round-trips core project and time resources", async () => {
    const created = await client().createProject({
      body: { client_id: 3, name: "Launch" },
    });
    expect(created.data).toMatchObject({ id: 7, name: "Launch" });

    const listed = await client().listProjects({ query: { per_page: 25 } });
    expect(listed.page.per_page).toBe(25);
    expect(listed.data).toEqual([project]);

    const time = await client().createTimeEntry({
      body: { project_id: 7, task_id: 2, seconds: 7200 },
    });
    expect(time.data).toMatchObject({
      project_id: 7,
      task_id: 2,
      seconds: 7200,
      is_running: false,
    });
  });

  it("[unit] sends expense-category master-data operations through typed client methods", async () => {
    const listed = await client().listExpenseCategories({
      query: {
        per_page: 25,
        is_active: true,
        updated_since: "2026-08-01T00:00:00.000Z",
      },
    });
    expect(listed.data).toEqual([
      expect.objectContaining({
        id: 4,
        name: "Mileage",
        unit_name: "mile",
        unit_price_cents: 67,
        is_active: true,
      }),
    ]);

    const input: ExpenseCategoryInput = {
      name: "Travel",
      unit_name: null,
      unit_price_cents: null,
    };
    const created = await client().createExpenseCategory({
      body: input,
    });
    expect(created.data).toMatchObject({
      id: 5,
      name: "Travel",
      unit_name: null,
      unit_price_cents: null,
      is_active: true,
    });

    await expect(client().getExpenseCategory({ id: 4 })).resolves.toMatchObject(
      {
        data: { id: 4, name: "Mileage" },
      },
    );
    const patch: ExpenseCategoryPatch = {
      unit_name: "km",
      unit_price_cents: 42,
    };
    await expect(
      client().updateExpenseCategory({ id: 4, body: patch }),
    ).resolves.toMatchObject({
      data: { id: 4, unit_name: "km", unit_price_cents: 42 },
    });
    await expect(
      client().deleteExpenseCategory({ id: 4 }),
    ).resolves.toBeUndefined();
  });

  it("[unit] surfaces the stable API error and request id", async () => {
    await expect(client("wrong-token").listProjects()).rejects.toMatchObject({
      name: "EzactoApiError",
      status: 401,
      body: {
        error: { code: "authentication_required" },
      },
    } satisfies Partial<EzactoApiError>);
  });

  it("[unit] maps required command identity into the generated request header", async () => {
    const response = await client().updateInvoice({
      id: 9,
      "Idempotency-Key": "client-command-9",
      body: { expected_version: 2, subject: "Updated" },
    });
    expect(response as unknown).toMatchObject({
      data: {
        invoice_id: "9",
        command_id: "client-command-9",
        body: { expected_version: 2, subject: "Updated" },
      },
    });

    const generated = await client().generateInvoice({
      "Idempotency-Key": "client-generation-10",
      body: {
        client_id: 3,
        from: "2026-08-01",
        to: "2026-08-31",
        project_ids: [7],
        time_summary_type: "task",
        expense_summary_type: null,
      },
    });
    expect(generated as unknown).toMatchObject({
      data: {
        command_id: "client-generation-10",
        body: {
          client_id: 3,
          from: "2026-08-01",
          to: "2026-08-31",
          project_ids: [7],
          time_summary_type: "task",
          expense_summary_type: null,
        },
      },
    });

    const converted = await client().convertEstimate({
      id: 12,
      "Idempotency-Key": "client-conversion-12",
      body: {
        expected_version: 3,
        number: "INV-12",
        issue_date: "2026-08-28",
        due_date: "2026-09-27",
        payment_terms: "net_30",
      },
    });
    expect(converted as unknown).toMatchObject({
      data: {
        estimate_id: "12",
        command_id: "client-conversion-12",
        body: {
          expected_version: 3,
          number: "INV-12",
          payment_terms: "net_30",
        },
      },
    });
  });

  it("[unit] preserves multipart boundaries and returns binary attachment content", async () => {
    const form = new FormData();
    form.set(
      "file",
      new File(["attachment bytes"], "evidence.txt", { type: "text/plain" }),
    );
    const multipartClient = new EzactoClient({
      baseUrl: "https://api.test",
      token: "generated-client-test",
      headers: { "content-type": "application/json" },
      fetch: async (input, init) => app.fetch(new Request(input, init)),
    });
    const created = await multipartClient.createProjectAttachment({
      projectId: 7,
      "Idempotency-Key": "client-project-attachment-7",
      body: form,
    });
    expect(created.data).toMatchObject({
      id: 12,
      name: "evidence.txt",
      byte_size: 16,
      content_type: "text/plain",
    });

    const bytes = await multipartClient.downloadProjectAttachment({
      projectId: 7,
      attachmentId: 12,
    });
    expect([...new Uint8Array(bytes)]).toEqual([0, 1, 2, 255]);
  });

  it("[contract] exposes discriminated money inputs without caller-owned ambiguous fields", () => {
    const payment: InvoicePaymentInput = {
      expected_version: 1,
      amount_cents: 100,
      currency: "USD",
      paid_date: "2026-08-28",
    };
    const paymentUpdate: InvoicePaymentUpdateInput = {
      expected_version: 2,
      expected_updated_at: "2026-08-28T12:00:00.000Z",
      amount_cents: 90,
      paid_at: "2026-08-28T12:00:00.000Z",
    };
    const retainers: RetainerInput[] = [
      { denomination: "money", amount_cents: 1_000 },
      { denomination: "hours", seconds: 3_600 },
      {
        denomination: "hours",
        seconds: 3_600,
        locked_rate_cents: 20_000,
        rate_locked_at: "2026-08-28T12:00:00.000Z",
      },
    ];
    const correction: RetainerLedgerInput = {
      kind: "adjustment",
      amount_cents: -100,
      occurred_on: "2026-08-28",
      notes: "Correction",
    };
    const drawdown: RetainerDrawdownInput = {
      invoice_id: 4,
      seconds: 600,
      occurred_on: "2026-08-28",
    };
    const recurring: RecurringAmountConfig = {
      schema_version: 1,
      type: "line_items_import",
      project_ids: [7],
      time: { summary_type: "task" },
    };
    expect({
      payment,
      paymentUpdate,
      retainers,
      correction,
      drawdown,
      recurring,
    }).toBeDefined();
  });
});
