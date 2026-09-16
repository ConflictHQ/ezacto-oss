import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createApiApp,
  installAttachmentRoutes,
  type AttachmentMetadataInput,
  type AttachmentMetadataPort,
  type AttachmentOwnerAccessInput,
  type AttachmentRecord,
} from "../src/index.js";

type Owner =
  "invoice" | "recurringInvoice" | "estimate" | "expense" | "project";

const ownerRoutes = [
  { owner: "invoice", route: "invoices", scope: "invoices" },
  { owner: "recurringInvoice", route: "recurring-invoices", scope: "invoices" },
  { owner: "estimate", route: "estimates", scope: "invoices" },
  { owner: "expense", route: "expenses", scope: "expenses" },
  { owner: "project", route: "projects", scope: "projects" },
] as const;

const fakeMetadata = () => {
  let nextId = 1;
  let calls = 0;
  const records = new Map<string, AttachmentRecord[]>();
  let failCreate = false;
  const key = (owner: Owner, parentId: number) => `${owner}:${parentId}`;
  const create = async (
    owner: Owner,
    parentId: number,
    input: AttachmentMetadataInput,
  ): Promise<AttachmentRecord> => {
    calls += 1;
    if (failCreate) throw new Error("forced metadata failure");
    const record: AttachmentRecord = {
      id: nextId++,
      fileObjectId: 100,
      contentHash: input.contentHash,
      fileKey: input.fileKey,
      byteSize: input.byteSize,
      contentType: input.contentType,
      name: input.name,
      uploadedByUserId: input.uploadedByUserId ?? null,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    };
    const values = records.get(key(owner, parentId)) ?? [];
    values.push(record);
    records.set(key(owner, parentId), values);
    return record;
  };
  const list = async (owner: Owner, parentId: number) => {
    calls += 1;
    return records.get(key(owner, parentId)) ?? [];
  };
  const get = async (owner: Owner, parentId: number, attachmentId: number) =>
    (await list(owner, parentId)).find(
      (record) => record.id === attachmentId,
    ) ?? null;

  const port: AttachmentMetadataPort = {
    createInvoiceAttachment: (input) =>
      create("invoice", input.invoiceId, input),
    createRecurringInvoiceAttachment: (input) =>
      create("recurringInvoice", input.recurringInvoiceId, input),
    createEstimateAttachment: (input) =>
      create("estimate", input.estimateId, input),
    createExpenseAttachment: (input) =>
      create("expense", input.expenseId, input),
    createProjectAttachment: (input) =>
      create("project", input.projectId, input),
    listInvoiceAttachments: (id) => list("invoice", id),
    listRecurringInvoiceAttachments: (id) => list("recurringInvoice", id),
    listEstimateAttachments: (id) => list("estimate", id),
    listExpenseAttachments: (id) => list("expense", id),
    listProjectAttachments: (id) => list("project", id),
    getInvoiceAttachment: (id, attachmentId) =>
      get("invoice", id, attachmentId),
    getRecurringInvoiceAttachment: (id, attachmentId) =>
      get("recurringInvoice", id, attachmentId),
    getEstimateAttachment: (id, attachmentId) =>
      get("estimate", id, attachmentId),
    getExpenseAttachment: (id, attachmentId) =>
      get("expense", id, attachmentId),
    getProjectAttachment: (id, attachmentId) =>
      get("project", id, attachmentId),
  };
  return {
    port,
    records,
    calls: () => calls,
    setFailCreate: (value: boolean) => (failCreate = value),
  };
};

const harness = (
  scopes = ownerRoutes.flatMap(({ scope }) => [
    `${scope}:read`,
    `${scope}:write`,
  ]),
  authorizeOwnerAccess: (
    input: AttachmentOwnerAccessInput,
  ) => Promise<boolean> = async () => true,
  profile: "member" | "administrator" = "administrator",
) => {
  const metadata = fakeMetadata();
  const objects = new Map<
    string,
    { bytes: ArrayBuffer; contentType: string }
  >();
  let puts = 0;
  const app = createApiApp({
    authentication: {
      tokens: {
        authenticate: async (token) =>
          token === "attachment-token"
            ? {
                tokenId: 1,
                userId: 9,
                profile,
                scopes: [...new Set(scopes)],
              }
            : null,
        issue: async () => {
          throw new Error("not used");
        },
        list: async () => [],
        revoke: async () => null,
      },
    },
    installApi: (api) =>
      installAttachmentRoutes(api, {
        metadata: metadata.port,
        authorizeOwnerAccess,
        objects: {
          put: async (key, bytes, contentType) => {
            puts += 1;
            if (!objects.has(key)) objects.set(key, { bytes, contentType });
          },
          get: async (key) => {
            const object = objects.get(key);
            return object === undefined ? null : { body: object.bytes };
          },
        },
        clock: () => "2026-08-28T12:00:00.000Z",
      }),
  });
  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, {
      ...init,
      headers: { authorization: "Bearer attachment-token", ...init.headers },
    });
  return { metadata, objects, request, puts: () => puts };
};

let uploadSequence = 0;
const upload = (
  request: ReturnType<typeof harness>["request"],
  route: string,
  body: FormData,
) =>
  request(`/api/v1/${route}/7/attachments`, {
    method: "POST",
    headers: { "idempotency-key": `attachment-test-${++uploadSequence}` },
    body,
  });

describe("owner-scoped attachment routes", () => {
  for (const { owner, route } of ownerRoutes) {
    it(`[unit] uploads, lists, and downloads ${owner} attachments`, async () => {
      const runtime = harness();
      const form = new FormData();
      form.set(
        "file",
        new File(["owner scoped bytes"], `${owner}.txt`, {
          type: "text/plain",
        }),
      );

      const created = await upload(runtime.request, route, form);
      expect(created.status).toBe(201);
      expect(created.headers.get("cache-control")).toBe("no-store");
      const body = await created.json();
      const expectedHash = createHash("sha256")
        .update("owner scoped bytes")
        .digest("hex");
      expect(body).toMatchObject({
        data: {
          id: 1,
          name: `${owner}.txt`,
          content_hash: expectedHash,
          byte_size: 18,
          content_type: "text/plain",
          uploaded_by_user_id: 9,
        },
      });
      expect(JSON.stringify(body)).not.toContain("fileKey");
      expect(JSON.stringify(body)).not.toContain("file_object");
      expect([...runtime.objects.keys()]).toEqual([
        `sha256/${expectedHash.slice(0, 2)}/${expectedHash}`,
      ]);

      const listed = await runtime.request(`/api/v1/${route}/7/attachments`);
      expect(listed.status).toBe(200);
      expect(await listed.json()).toMatchObject({
        data: [{ id: 1, name: `${owner}.txt` }],
      });

      const metadata = await runtime.request(
        `/api/v1/${route}/7/attachments/1`,
      );
      expect(metadata.status).toBe(200);
      expect(await metadata.json()).toMatchObject({
        data: { id: 1, name: `${owner}.txt` },
      });

      const downloaded = await runtime.request(
        `/api/v1/${route}/7/attachments/1/content`,
      );
      expect(downloaded.status).toBe(200);
      expect(downloaded.headers.get("cache-control")).toBe("no-store");
      expect(downloaded.headers.get("content-type")).toBe("text/plain");
      expect(downloaded.headers.get("content-disposition")).toContain(
        "filename*=UTF-8''",
      );
      // #737. The content type is whatever the uploader claimed, and an
      // uploader is any user who can attach a file. Without nosniff a browser
      // may re-type the bytes by looking at them and render markup as HTML on
      // this origin, where a session cookie lives.
      expect(downloaded.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await downloaded.text()).toBe("owner scoped bytes");

      const crossParent = await runtime.request(
        `/api/v1/${route}/8/attachments/1/content`,
      );
      expect(crossParent.status).toBe(404);
      expect(await crossParent.json()).toMatchObject({
        error: { code: "not_found" },
      });
    });
  }

  it("[unit] converges repeated bytes on one content-addressed object key", async () => {
    const runtime = harness();
    for (const name of ["first.txt", "second.txt"]) {
      const form = new FormData();
      form.set("file", new File(["same"], name, { type: "text/plain" }));
      expect((await upload(runtime.request, "invoices", form)).status).toBe(
        201,
      );
    }
    expect(runtime.objects.size).toBe(1);
    expect(runtime.puts()).toBe(2);
  });

  it("[unit] rejects fields beside the one file part without writing storage", async () => {
    const runtime = harness();
    const form = new FormData();
    form.set("file", new File(["bytes"], "receipt.txt"));
    form.set("owner_type", "project");
    const response = await upload(runtime.request, "expenses", form);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: "validation_failed" },
    });
    expect(runtime.objects.size).toBe(0);
  });

  it("[unit] rejects a declared oversized multipart request before parsing or storage", async () => {
    const runtime = harness();
    const response = await runtime.request("/api/v1/invoices/7/attachments", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=limit-test",
        "content-length": String(26 * 1024 * 1024),
      },
      body: "--limit-test--\r\n",
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: "payload_too_large" },
    });
    expect(runtime.objects.size).toBe(0);
  });

  it("[unit] enforces the owner-specific write scope before parsing the file", async () => {
    const runtime = harness(["invoices:read"]);
    const form = new FormData();
    form.set("file", new File(["bytes"], "invoice.txt"));
    const response = await upload(runtime.request, "invoices", form);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "insufficient_scope" },
    });
    expect(runtime.objects.size).toBe(0);
  });

  it("[security] checks expense ownership and project assignment before metadata or objects", async () => {
    const runtime = harness(
      ["expenses:read", "expenses:write", "projects:read"],
      async ({ owner, parentId, principal }) =>
        principal.userId === 9 &&
        ((owner === "expense" && parentId === 7) ||
          (owner === "project" && parentId === 7)),
      "member",
    );
    const foreignExpense = await runtime.request(
      "/api/v1/expenses/8/attachments",
    );
    expect(foreignExpense.status).toBe(404);
    expect(await foreignExpense.json()).toMatchObject({
      error: { code: "not_found" },
    });

    const unassignedProject = await runtime.request(
      "/api/v1/projects/8/attachments",
    );
    expect(unassignedProject.status).toBe(404);
    expect(await unassignedProject.json()).toMatchObject({
      error: { code: "not_found" },
    });

    const form = new FormData();
    form.set("file", new File(["must not persist"], "denied.txt"));
    const deniedExpenseUpload = await runtime.request(
      "/api/v1/expenses/8/attachments",
      {
        method: "POST",
        body: form,
      },
    );
    expect(deniedExpenseUpload.status).toBe(404);
    expect(await deniedExpenseUpload.json()).toMatchObject({
      error: { code: "not_found" },
    });
    expect(runtime.metadata.calls()).toBe(0);
    expect(runtime.objects.size).toBe(0);
  });

  it("[unit] keeps the object when metadata persistence fails", async () => {
    const runtime = harness();
    runtime.metadata.setFailCreate(true);
    const form = new FormData();
    form.set("file", new File(["orphan is safe"], "safe.txt"));
    const response = await upload(runtime.request, "projects", form);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: {
        code: "internal_error",
        message: "The request could not be completed.",
      },
    });
    expect(runtime.objects.size).toBe(1);
  });

  it("[unit] exposes no generic attachment owner route", async () => {
    const response = await harness().request(
      "/api/v1/attachments?owner_type=invoice&owner_id=7",
    );
    expect(response.status).toBe(404);
  });

  it("[unit] fails closed with a redacted 503 when object storage is absent", async () => {
    const app = createApiApp({
      authentication: {
        tokens: {
          authenticate: async () => ({
            tokenId: 1,
            userId: 9,
            profile: "administrator",
            scopes: ["invoices:read"],
          }),
          issue: async () => {
            throw new Error("not used");
          },
          list: async () => [],
          revoke: async () => null,
        },
      },
      installApi: (api) => installAttachmentRoutes(api),
    });
    const response = await app.request("/api/v1/invoices/7/attachments", {
      headers: { authorization: "Bearer token" },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: {
        code: "internal_error",
        message: "The request could not be completed.",
      },
    });
  });
});
