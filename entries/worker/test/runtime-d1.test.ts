import { createApiTokenStore, createD1Database } from "@ezacto/db/d1";
import { EzactoClient } from "@ezacto/client";
import {
  buildWeekGrid,
  createShellApi,
  loadShellSnapshot,
  quickAdd,
  saveWeekCellWithRetry,
} from "@ezacto/web";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseCursorSigningKey } from "../src/runtime.js";

const timestamp = "2026-08-28T08:00:00.000Z";
const cursorSecret = encodeBase64Url(new Uint8Array(32).fill(0x41));

let miniflare: Miniflare;
let database: D1Database;
let bootstrapResponse: Response;
let bearer: string;
let moneyBearer: string;
let projectBearer: string;

const request = (path: string, init?: RequestInit): Promise<Response> =>
  miniflare.dispatchFetch(
    new URL(path, "https://worker.test").toString(),
    init as never,
  ) as unknown as Promise<Response>;

const run = async (
  statement: string,
  ...bindings: unknown[]
): Promise<void> => {
  await database
    .prepare(statement)
    .bind(...bindings)
    .run();
};

beforeAll(async () => {
  const bundled = await build({
    entryPoints: [new URL("../src/index.ts", import.meta.url).pathname],
    bundle: true,
    conditions: ["development"],
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
  });
  miniflare = new Miniflare({
    bindings: {
      API_CURSOR_SIGNING_KEY: cursorSecret,
      ENVIRONMENT: "test",
      RELEASE: "runtime-d1-test",
    },
    // Latest compatibility date accepted by the pinned stable workerd.
    compatibilityDate: "2026-08-06",
    d1Databases: ["DB"],
    r2Buckets: ["ATTACHMENTS"],
    modules: true,
    script: bundled.outputFiles[0]!.text,
  });

  // The first fetch, not test setup, must install the complete schema before
  // authentication performs its first query.
  bootstrapResponse = await request("/api/v1/time-entries");
  database = await miniflare.getD1Database("DB");

  await run(
    `INSERT INTO organizations (
      id, name, time_entry_mode, time_rounding, modules, created_at, updated_at
    ) VALUES (1, 'Runtime Organization', 'duration', 'none', ?, ?, ?)`,
    JSON.stringify({ expenses: true, invoices: true, approval: false }),
    timestamp,
    timestamp,
  );
  await run(
    `INSERT INTO users (
      id, first_name, last_name, profile, manager_grants,
      has_access_to_all_future_projects, created_at, updated_at
    ) VALUES
      (1, 'Runtime', 'Owner', 'administrator', '[]', 1, ?, ?),
      (2, 'Runtime', 'Member', 'member', '[]', 0, ?, ?)`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  );
  await run(
    `INSERT INTO clients (id, name, currency, created_at, updated_at)
     VALUES (1, 'Runtime Client', 'USD', ?, ?)`,
    timestamp,
    timestamp,
  );
  await run(
    `INSERT INTO projects (
      id, client_id, name, code, hourly_rate_cents, budget_by, budget_seconds,
      created_at, updated_at
    ) VALUES
      (1, 1, 'Runtime Project', 'RUN', 10000, 'project', 3600, ?, ?),
      (2, 1, 'Unassigned Project', 'PRIVATE', 10000, 'none', NULL, ?, ?)`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  );
  await run(
    `INSERT INTO tasks (id, name, created_at, updated_at)
     VALUES (1, 'Runtime Task', ?, ?)`,
    timestamp,
    timestamp,
  );
  await run(
    `INSERT INTO user_assignments (
      id, project_id, user_id, created_at, updated_at
    ) VALUES (1, 1, 2, ?, ?)`,
    timestamp,
    timestamp,
  );
  await run(
    `INSERT INTO task_assignments (
      id, project_id, task_id, billable, created_at, updated_at
    ) VALUES (1, 1, 1, 1, ?, ?)`,
    timestamp,
    timestamp,
  );
  await run(
    `INSERT INTO time_entries (
      id, user_id, project_id, task_id, user_assignment_id, task_assignment_id,
      spent_date, seconds, seconds_without_timer, rounded_seconds, billable,
      billable_rate_cents, cost_rate_cents, budgeted, created_at, updated_at
    ) VALUES
      (1, 2, 1, 1, 1, 1, '2026-08-27', 600, 600, 600, 1, 10000, 5000, 1, ?, ?),
      (2, 2, 1, 1, 1, 1, '2026-08-28', 900, 900, 900, 1, 10000, 5000, 1, ?, ?)`,
    timestamp,
    timestamp,
    timestamp,
    timestamp,
  );
  await run(
    `INSERT INTO invoices (
      id, client_id, created_by_user_id, number, currency, issue_date, due_date,
      created_at, updated_at
    ) VALUES (1, 1, 1, 'RUN-001', 'USD', '2026-08-28', '2026-09-27', ?, ?)`,
    timestamp,
    timestamp,
  );
  await run(
    `INSERT INTO expense_categories (
      id, name, unit_price_cents, created_at, updated_at
    ) VALUES (1, 'Runtime Expense', NULL, ?, ?)`,
    timestamp,
    timestamp,
  );
  await run(
    `INSERT INTO expenses (
      id, user_id, project_id, expense_category_id, spent_date, total_cost_cents,
      created_at, updated_at
    ) VALUES (1, 1, 1, 1, '2026-08-28', 100, ?, ?)`,
    timestamp,
    timestamp,
  );

  const store = createApiTokenStore(createD1Database(database), {
    now: () => timestamp,
  });
  bearer = (
    await store.issue({
      userId: 2,
      name: "Runtime fetch test",
      scopes: [
        "projects:read",
        "time_entries:read",
        "time_entries:write",
        "expenses:read",
        "expenses:write",
      ],
    })
  ).token;
  moneyBearer = (
    await store.issue({
      userId: 1,
      name: "Runtime money fetch test",
      scopes: ["invoices:read", "invoices:write"],
    })
  ).token;
  projectBearer = (
    await store.issue({
      userId: 1,
      name: "Runtime project lifecycle test",
      scopes: [
        "clients:read",
        "clients:write",
        "projects:read",
        "projects:write",
        "time_entries:read",
        "time_entries:write",
        "reports:read",
        "expenses:read",
        "expenses:write",
      ],
    })
  ).token;
  expect(await store.authenticate(bearer)).toMatchObject({ profile: "member" });
  expect(await store.authenticate(moneyBearer)).toMatchObject({
    profile: "administrator",
  });
  expect(await store.authenticate(projectBearer)).toMatchObject({
    profile: "administrator",
  });
}, 20_000);

afterAll(async () => miniflare.dispose());

describe("Worker D1 runtime composition", () => {
  it("[api] migrates the real D1 binding before its first DB-backed fetch", async () => {
    expect(bootstrapResponse.status).toBe(401);
    expect(bootstrapResponse.headers.get("www-authenticate")).toBe(
      'Bearer realm="ezacto"',
    );
    const migrations = await database
      .prepare("SELECT id FROM _ezacto_migrations ORDER BY id")
      .all<{ id: string }>();
    expect(migrations.results.at(-1)?.id).toBe(
      "0035_backup_runs",
    );
    expect(migrations.results).toHaveLength(34);
  });

  it("[security] keeps unverified session-like cookies fail-closed", async () => {
    const response = await request("/api/v1/time-entries", {
      headers: {
        cookie: "__Host-ezacto_session=attacker; CF_Authorization=unverified",
      },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "authentication_required", fields: [] },
    });
  });

  it("[api] authenticates a real stored bearer and pages real D1 resources over fetch", async () => {
    const firstResponse = await request("/api/v1/time-entries?per_page=1", {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(firstResponse.status).toBe(200);
    const first = (await firstResponse.json()) as {
      data: Record<string, unknown>[];
      links: { next: string | null };
    };
    expect(first.data).toEqual([
      expect.objectContaining({ id: 1, user_id: 2, seconds: 600 }),
    ]);
    expect(first.data[0]).not.toHaveProperty("billable_rate_cents");
    expect(first.data[0]).not.toHaveProperty("cost_rate_cents");
    expect(first.links.next).not.toBeNull();

    const secondResponse = await request(first.links.next!, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(secondResponse.status).toBe(200);
    expect(await secondResponse.json()).toMatchObject({
      data: [expect.objectContaining({ id: 2, user_id: 2, seconds: 900 })],
      links: { next: null },
    });

    const used = await database
      .prepare("SELECT last_used_at AS lastUsedAt FROM api_tokens")
      .first<{ lastUsedAt: string | null }>();
    expect(used?.lastUsedAt).not.toBeNull();

    const projectResponse = await request("/api/v1/projects/1", {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(projectResponse.status).toBe(200);
    const project = (await projectResponse.json()) as {
      data: Record<string, unknown>;
    };
    expect(project.data).toMatchObject({ id: 1, name: "Runtime Project" });
    expect(project.data).not.toHaveProperty("hourly_rate_cents");
  });

  it("[e2e:reports] reads exact operational reports through generated client and real D1", async () => {
    const client = new EzactoClient({
      baseUrl: "https://worker.test",
      token: projectBearer,
      fetch: workerFetch,
    });
    const range = { from: "2026-08-27", to: "2026-08-28" };

    const [uninvoiced, rollup, budget] = await Promise.all([
      client.getUninvoicedReport({ query: range }),
      client.getClientRollupReport({ clientId: 1, query: range }),
      client.getProjectBudgetReport({ projectId: 1, query: range }),
    ]);

    expect(uninvoiced.data.totals).toEqual([
      {
        currency: "USD",
        rounded_seconds: 1500,
        time_entry_count: 2,
        unpriced_time_entry_count: 0,
        expense_count: 1,
        time_cents: 4167,
        expense_cents: 100,
        total_cents: 4267,
      },
    ]);
    expect(rollup.data).toMatchObject({
      root_client_id: 1,
      nodes: [
        {
          client_id: 1,
          depth: 0,
          direct: {
            rounded_seconds: 1500,
            expense_count: 1,
            currencies: [
              expect.objectContaining({
                currency: "USD",
                uninvoiced_total_cents: 4267,
              }),
            ],
          },
          rollup: { rounded_seconds: 1500 },
        },
      ],
    });
    expect(budget.data).toMatchObject({
      project_id: 1,
      budget_by: "project",
      grains: [
        {
          source: "project",
          source_id: 1,
          unit: "seconds",
          calculation: "time",
          budget_seconds: 3600,
          spent_seconds: 1500,
          remaining_seconds: 2100,
        },
      ],
    });
  });

  it("[security] enforces the expenses module at every Worker expense route and attachment boundary", async () => {
    await run(
      `UPDATE organizations
       SET modules = json_set(modules, '$.expenses', json('false'))
       WHERE id = 1`,
    );
    try {
      const requests: Array<Promise<Response>> = [
        request("/api/v1/expenses", {
          headers: { authorization: `Bearer ${projectBearer}` },
        }),
        request("/api/v1/expenses/1", {
          headers: { authorization: `Bearer ${projectBearer}` },
        }),
        request("/api/v1/expenses", {
          method: "POST",
          headers: {
            authorization: `Bearer ${projectBearer}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            project_id: 1,
            expense_category_id: 1,
            spent_date: "2026-08-28",
            total_cost_cents: 125,
          }),
        }),
        request("/api/v1/expenses/1", {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${projectBearer}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ notes: "must not write" }),
        }),
        request("/api/v1/expenses/1", {
          method: "DELETE",
          headers: { authorization: `Bearer ${projectBearer}` },
        }),
        request("/api/v1/expense-categories", {
          headers: { authorization: `Bearer ${projectBearer}` },
        }),
        request("/api/v1/expense-categories/1", {
          headers: { authorization: `Bearer ${projectBearer}` },
        }),
      ];
      for (const response of await Promise.all(requests)) {
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({
          error: { code: "module_disabled", fields: [] },
        });
      }
      const receipt = new FormData();
      receipt.set("file", new File(["denied"], "denied.txt"));
      const attachmentAttempts = await Promise.all([
        request("/api/v1/expenses/1/attachments", {
          headers: { authorization: `Bearer ${projectBearer}` },
        }),
        request("/api/v1/expenses/1/attachments/1", {
          headers: { authorization: `Bearer ${projectBearer}` },
        }),
        request("/api/v1/expenses/1/attachments/1/content", {
          headers: { authorization: `Bearer ${projectBearer}` },
        }),
        request("/api/v1/expenses/1/attachments", {
          method: "POST",
          headers: {
            authorization: `Bearer ${projectBearer}`,
            "idempotency-key": "module-disabled-receipt",
          },
          body: receipt,
        }),
      ]);
      expect(attachmentAttempts.map((response) => response.status)).toEqual([
        404, 404, 404, 404,
      ]);
    } finally {
      await run(
        `UPDATE organizations
         SET modules = json_set(modules, '$.expenses', json('true'))
         WHERE id = 1`,
      );
    }
  });

  it("[api] executes and replays a generated-client money command through the real D1 binding", async () => {
    const client = new EzactoClient({
      baseUrl: "https://worker.test",
      token: moneyBearer,
      fetch: workerFetch,
    });
    const command = {
      id: 1,
      "Idempotency-Key": "runtime-money-line-1",
      body: {
        expected_version: 0,
        position: 0,
        kind: "Service",
        description: "Fractional runtime work",
        quantity: 1.5,
        unit_price_cents: 101,
      },
    } as const;

    const created = await client.createInvoiceLine(command);
    const replayed = await client.createInvoiceLine(command);

    expect(created.data.invoice).toMatchObject({
      id: 1,
      version: 1,
      amount_cents: 152,
      due_amount_cents: 152,
    });
    expect(replayed.data.command.event_ids).toEqual(
      created.data.command.event_ids,
    );
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS lineCount, SUM(amount_cents) AS amountCents
           FROM invoice_line_items WHERE invoice_id = ?`,
        )
        .bind(1)
        .first(),
    ).toEqual({ lineCount: 1, amountCents: 152 });
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS eventCount
           FROM event_outbox WHERE aggregate_type = 'invoice' AND aggregate_id = ?`,
        )
        .bind(1)
        .first(),
    ).toEqual({ eventCount: 1 });
  });

  it("[e2e:projects] creates client → project → task assignment → selectable time through real D1 and R2", async () => {
    const client = new EzactoClient({
      baseUrl: "https://worker.test",
      token: projectBearer,
      fetch: workerFetch,
    });
    const createdClient = await client.createClient({
      body: { name: "Native project client", currency: "USD" },
    });
    const task = await client.createTask({
      body: { name: "Native project task", billable_by_default: true },
    });
    const project = await client.createProject({
      body: {
        client_id: createdClient.data.id,
        name: "Native project",
        code: "",
        billing_method: "time_materials",
        bill_by: "tasks",
        budget_by: "project",
        budget_seconds: 36_000,
        time_entry_notes_minimum_length: 3,
      },
    });

    expect(project.data).toMatchObject({
      client_id: createdClient.data.id,
      name: "Native project",
      code: "",
      budget_seconds: 36_000,
    });
    expect(
      await database
        .prepare(
          `SELECT project_id AS projectId, user_id AS userId
           FROM user_assignments WHERE project_id = ? AND user_id = ?`,
        )
        .bind(project.data.id, 1)
        .first(),
    ).toEqual({ projectId: project.data.id, userId: 1 });

    const assignment = await client.createTaskAssignment({
      body: {
        project_id: project.data.id,
        task_id: task.data.id,
        billable: true,
        budget_seconds: 18_000,
      },
    });
    expect((await client.listTimeEntryOptions()).data).toContainEqual({
      project_id: project.data.id,
      task_id: task.data.id,
      minimum_note_length: 3,
    });
    const entry = await client.createTimeEntry({
      body: {
        project_id: project.data.id,
        task_id: task.data.id,
        spent_date: "2026-08-28",
        seconds: 1_800,
        notes: "Built",
      },
    });
    expect(entry.data).toMatchObject({
      project_id: project.data.id,
      task_id: task.data.id,
      seconds: 1_800,
      notes: "Built",
    });

    const form = new FormData();
    form.set(
      "file",
      new File(["project brief"], "brief.txt", { type: "text/plain" }),
    );
    const attachment = await client.createProjectAttachment({
      projectId: project.data.id,
      "Idempotency-Key": "runtime-project-attachment",
      body: form,
    });
    expect(
      new TextDecoder().decode(
        await client.downloadProjectAttachment({
          projectId: project.data.id,
          attachmentId: attachment.data.id,
        }),
      ),
    ).toBe("project brief");

    await client.deleteTaskAssignment({ id: assignment.data.id });
    expect((await client.listTimeEntryOptions()).data).not.toContainEqual(
      expect.objectContaining({
        project_id: project.data.id,
        task_id: task.data.id,
      }),
    );
  });

  it("[api] [inv-06] concurrently generates one invoice through the deployed Worker binding", async () => {
    const client = new EzactoClient({
      baseUrl: "https://worker.test",
      token: moneyBearer,
      fetch: workerFetch,
    });
    const generation = {
      "Idempotency-Key": "runtime-invoice-cycle",
      body: {
        client_id: 1,
        from: "2026-08-27",
        to: "2026-08-28",
        project_ids: [1],
        time_summary_type: "project" as const,
        expense_summary_type: "project" as const,
      },
    };

    const [created, replay] = await Promise.all([
      client.generateInvoice(generation),
      client.generateInvoice(generation),
    ]);

    expect(replay).toEqual(created);
    expect(created.data).toMatchObject({
      client_id: 1,
      state: "draft",
      amount_cents: 4_267,
      due_amount_cents: 4_267,
      line_items: [
        expect.objectContaining({ kind: "Service", amount_cents: 4_167 }),
        expect.objectContaining({ kind: "Expense", amount_cents: 100 }),
      ],
    });
    expect(
      await database
        .prepare(
          `SELECT
             (SELECT count(*) FROM time_entries WHERE invoice_id = ?) AS timeEntries,
             (SELECT count(*) FROM expenses WHERE invoice_id = ?) AS expenses,
             (SELECT count(*) FROM event_outbox
               WHERE aggregate_id = ? AND event_type = 'invoice.created') AS createdEvents,
             (SELECT count(*) FROM event_outbox
               WHERE aggregate_id = ? AND event_type = 'invoice.updated') AS updatedEvents`,
        )
        .bind(created.data.id, created.data.id, created.data.id, created.data.id)
        .first(),
    ).toEqual({ timeEntries: 2, expenses: 1, createdEvents: 1, updatedEvents: 0 });
  });

  it("[api] uploads and downloads an owner-scoped attachment through real D1 and R2 bindings", async () => {
    const client = new EzactoClient({
      baseUrl: "https://worker.test",
      token: moneyBearer,
      fetch: workerFetch,
    });
    const form = new FormData();
    form.set(
      "file",
      new File(["runtime attachment"], "runtime.txt", { type: "text/plain" }),
    );
    const created = await client.createInvoiceAttachment({
      invoiceId: 1,
      "Idempotency-Key": "runtime-attachment",
      body: form,
    });
    expect(created.data).toMatchObject({
      name: "runtime.txt",
      byte_size: 18,
      content_type: "text/plain",
      uploaded_by_user_id: 1,
    });
    const retryForm = new FormData();
    retryForm.set(
      "file",
      new File(["runtime attachment"], "runtime.txt", { type: "text/plain" }),
    );
    expect(
      await client.createInvoiceAttachment({
        invoiceId: 1,
        "Idempotency-Key": "runtime-attachment",
        body: retryForm,
      }),
    ).toEqual(created);
    const changedRetry = new FormData();
    changedRetry.set(
      "file",
      new File(["runtime attachment"], "renamed.txt", { type: "text/plain" }),
    );
    const changedRetryResponse = await workerFetch(
      "https://worker.test/api/v1/invoices/1/attachments",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${moneyBearer}`,
          "idempotency-key": "runtime-attachment",
        },
        body: changedRetry,
      },
    );
    expect(changedRetryResponse.status).toBe(409);

    const bytes = await client.downloadInvoiceAttachment({
      invoiceId: 1,
      attachmentId: created.data.id,
    });
    expect(new TextDecoder().decode(bytes)).toBe("runtime attachment");
    expect(
      await database
        .prepare(
          `SELECT attachment.name, file.content_hash AS contentHash
           FROM attachments attachment
           JOIN file_objects file ON file.id = attachment.file_object_id
           JOIN invoice_attachments owner ON owner.attachment_id = attachment.id
           WHERE owner.invoice_id = ?`,
        )
        .bind(1)
        .first(),
    ).toMatchObject({
      name: "runtime.txt",
      contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    const contentHash = (await database
      .prepare(
        `SELECT file.content_hash AS contentHash FROM file_objects file
           JOIN attachments attachment ON attachment.file_object_id = file.id
           WHERE attachment.id = ?`,
      )
      .bind(created.data.id)
      .first<{ contentHash: string }>())!.contentHash;
    const fileKey = `sha256/${contentHash.slice(0, 2)}/${contentHash}`;
    const bucket = await miniflare.getR2Bucket("ATTACHMENTS");
    expect((await bucket.head(fileKey))?.httpMetadata?.contentType).toBe(
      "text/plain",
    );
    const conflicting = new FormData();
    conflicting.set(
      "file",
      new File(["runtime attachment"], "runtime.json", {
        type: "application/json",
      }),
    );
    const conflict = await workerFetch(
      "https://worker.test/api/v1/invoices/1/attachments",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${moneyBearer}`,
          "idempotency-key": "runtime-attachment-conflicting-mime",
        },
        body: conflicting,
      },
    );
    expect(conflict.status).toBe(409);
    expect((await bucket.head(fileKey))?.httpMetadata?.contentType).toBe(
      "text/plain",
    );
    const authoritativeDownload = await workerFetch(
      `https://worker.test/api/v1/invoices/1/attachments/${created.data.id}/content`,
      { headers: { authorization: `Bearer ${moneyBearer}` } },
    );
    expect(authoritativeDownload.headers.get("content-type")).toBe(
      "text/plain",
    );

    const concurrentBytes = "concurrent mime identity";
    const concurrentForm = (name: string, type: string) => {
      const value = new FormData();
      value.set("file", new File([concurrentBytes], name, { type }));
      return value;
    };
    const [plain, json] = await Promise.all([
      workerFetch("https://worker.test/api/v1/invoices/1/attachments", {
        method: "POST",
        headers: {
          authorization: `Bearer ${moneyBearer}`,
          "idempotency-key": "concurrent-mime-plain",
        },
        body: concurrentForm("concurrent.txt", "text/plain"),
      }),
      workerFetch("https://worker.test/api/v1/invoices/1/attachments", {
        method: "POST",
        headers: {
          authorization: `Bearer ${moneyBearer}`,
          "idempotency-key": "concurrent-mime-json",
        },
        body: concurrentForm("concurrent.json", "application/json"),
      }),
    ]);
    expect([plain.status, json.status].sort()).toEqual([201, 409]);
    const accepted = plain.status === 201 ? plain : json;
    const acceptedData = (await accepted.json()) as {
      data: { id: number; content_type: string };
    };
    const acceptedDownload = await workerFetch(
      `https://worker.test/api/v1/invoices/1/attachments/${acceptedData.data.id}/content`,
      { headers: { authorization: `Bearer ${moneyBearer}` } },
    );
    expect(acceptedDownload.headers.get("content-type")).toBe(
      acceptedData.data.content_type,
    );
    expect(await acceptedDownload.text()).toBe(concurrentBytes);
  });

  it("[security] denies foreign expenses and unassigned projects before D1 or R2 attachment access", async () => {
    const foreignExpense = await request("/api/v1/expenses/1/attachments", {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(foreignExpense.status).toBe(404);

    const unassignedProject = await request("/api/v1/projects/2/attachments", {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(unassignedProject.status).toBe(404);

    const bytes = "foreign expense bytes";
    const form = new FormData();
    form.set("file", new File([bytes], "foreign.txt", { type: "text/plain" }));
    const deniedUpload = await request("/api/v1/expenses/1/attachments", {
      method: "POST",
      headers: { authorization: `Bearer ${bearer}` },
      body: form,
    });
    expect(deniedUpload.status).toBe(404);
    expect(
      await database
        .prepare("SELECT COUNT(*) AS count FROM expense_attachments")
        .first(),
    ).toEqual({ count: 0 });
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(bytes),
    );
    const contentHash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const bucket = await miniflare.getR2Bucket("ATTACHMENTS");
    expect(
      await bucket.get(`sha256/${contentHash.slice(0, 2)}/${contentHash}`),
    ).toBeNull();
  });

  it("[e2e:quick-add] sends the shell command through the generated client and refreshes D1 state", async () => {
    const client = new EzactoClient({
      baseUrl: "https://worker.test",
      token: bearer,
      fetch: workerFetch,
    });
    const api = createShellApi(client);

    const created = await quickAdd(
      api,
      "log 2h run runtimetask shell acceptance",
      new Date("2026-08-28T12:00:00.000Z"),
    );
    const snapshot = await loadShellSnapshot(
      api,
      new Date("2026-08-28T12:00:00.000Z"),
    );

    expect(created).toMatchObject({
      user_id: 2,
      project_id: 1,
      task_id: 1,
      spent_date: "2026-08-28",
      seconds: 7_200,
      notes: "shell acceptance",
    });
    expect(snapshot.entries).toContainEqual(
      expect.objectContaining({
        id: created.id,
        project_label: "Runtime Project",
        task_label: "Runtime Task",
        seconds: 7_200,
      }),
    );
    expect(
      await database
        .prepare("SELECT seconds, notes FROM time_entries WHERE id = ?")
        .bind(created.id)
        .first(),
    ).toEqual({ seconds: 7_200, notes: "shell acceptance" });
  });

  it("[e2e:track-week] saves all seven grid cells through the generated client and survives refresh", async () => {
    const client = new EzactoClient({
      baseUrl: "https://worker.test",
      token: bearer,
      fetch: workerFetch,
    });
    const api = createShellApi(client);
    const within = new Date("2026-09-09T12:00:00.000Z");
    const empty = await loadShellSnapshot(api, within);
    const editable = buildWeekGrid(empty, "2026-09-09", [
      { projectId: 1, taskId: 1 },
    ]);

    for (const [index, cell] of editable.rows[0]!.cells.entries()) {
      await expect(
        saveWeekCellWithRetry(api, cell, String(index + 1), `day ${index + 1}`),
      ).resolves.toMatchObject({ state: "saved" });
    }

    const refreshed = buildWeekGrid(
      await loadShellSnapshot(api, within),
      "2026-09-09",
    );
    expect(refreshed.rows[0]!.cells.map((cell) => cell.totalSeconds)).toEqual([
      3_600, 7_200, 10_800, 14_400, 18_000, 21_600, 25_200,
    ]);
    expect(refreshed.totalSeconds).toBe(100_800);
    expect(refreshed.rows[0]!.cells.map((cell) => cell.notes)).toEqual([
      "day 1",
      "day 2",
      "day 3",
      "day 4",
      "day 5",
      "day 6",
      "day 7",
    ]);
    expect(
      await database
        .prepare(
          `SELECT COUNT(*) AS count, SUM(seconds) AS seconds
           FROM time_entries WHERE spent_date BETWEEN ? AND ?`,
        )
        .bind("2026-09-07", "2026-09-13")
        .first(),
    ).toEqual({ count: 7, seconds: 100_800 });
  }, 20_000);

  it("[e2e:track-week] round-trips canonical start/end times through the generated client and D1", async () => {
    const client = new EzactoClient({
      baseUrl: "https://worker.test",
      token: bearer,
      fetch: workerFetch,
    });
    await run(
      `UPDATE organizations
       SET time_entry_mode = 'start_end', time_format = 'hours_minutes', clock = '12h'
       WHERE id = 1`,
    );

    try {
      await expect(client.getTimeEntrySettings()).resolves.toMatchObject({
        data: {
          time_entry_mode: "start_end",
          time_format: "hours_minutes",
          clock: "12h",
        },
      });
      const created = await client.createTimeEntry({
        body: {
          project_id: 1,
          task_id: 1,
          spent_date: "2026-09-14",
          started_time: "23:45",
          ended_time: "00:15",
          notes: "canonical start/end create",
        },
      });
      expect(created.data).toMatchObject({
        started_time: "23:45",
        ended_time: "00:15",
        seconds: 1_800,
      });

      await expect(client.getTimeEntry({ id: created.data.id })).resolves.toMatchObject({
        data: {
          started_time: "23:45",
          ended_time: "00:15",
          seconds: 1_800,
        },
      });
      const updated = await client.updateTimeEntry({
        id: created.data.id,
        body: { started_time: "22:30", ended_time: "01:00" },
      });
      expect(updated.data).toMatchObject({
        started_time: "22:30",
        ended_time: "01:00",
        seconds: 9_000,
      });
      expect(
        await database
          .prepare(
            `SELECT started_time, ended_time, seconds
             FROM time_entries WHERE id = ?`,
          )
          .bind(created.data.id)
          .first(),
      ).toEqual({ started_time: "22:30", ended_time: "01:00", seconds: 9_000 });
    } finally {
      await run(
        `UPDATE organizations
         SET time_entry_mode = 'duration', time_format = 'decimal', clock = '12h'
         WHERE id = 1`,
      );
    }
  }, 20_000);
});

describe("cursor signing binding", () => {
  it("[security] accepts only canonical base64url for exactly 32 stable bytes", () => {
    expect(parseCursorSigningKey(cursorSecret)).toEqual(
      new Uint8Array(32).fill(0x41),
    );
    expect(() => parseCursorSigningKey("A".repeat(42))).toThrow(
      /exactly 32 bytes/,
    );
    expect(() => parseCursorSigningKey(`${cursorSecret}=`)).toThrow(
      /canonical base64url/,
    );
    expect(() => parseCursorSigningKey(` ${cursorSecret}`)).toThrow(
      /canonical base64url/,
    );
    expect(() => parseCursorSigningKey("")).toThrow(/canonical base64url/);
  });
});

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

const workerFetch: typeof globalThis.fetch = async (input, init) => {
  const outbound = new Request(input, init);
  const body =
    outbound.method === "GET" || outbound.method === "HEAD"
      ? undefined
      : await outbound.arrayBuffer();
  return request(outbound.url, {
    method: outbound.method,
    headers: outbound.headers,
    ...(body === undefined ? {} : { body }),
  });
};
