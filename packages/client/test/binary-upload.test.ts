import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EzactoClient, EzactoApiError } from "../src/index.js";
import type { CsvImportUploadBytes } from "../src/generated.js";

const bytes = new Uint8Array([0, 255, 34, 10]);
const hash = createHash("sha256").update(bytes).digest("hex");
const fields = { "X-CSV-SHA256": hash, "X-CSV-Bytes": bytes.byteLength };
const success = () =>
  Response.json({ data: { id: "owned-upload" } }, { status: 201 });

describe("generated binary request transport", () => {
  it("sends only the selected byte view, snapshots it before async fetch, and forwards required headers", async () => {
    const backing = new Uint8Array([17, ...bytes, 19]),
      view = backing.subarray(1, 5);
    const controller = new AbortController();
    const client = new EzactoClient({
      baseUrl: "https://api.test",
      headers: { "content-type": "application/json" },
      fetch: async (input, init) => {
        await Promise.resolve();
        expect(init?.signal).toBe(controller.signal);
        const request = new Request(input, init);
        expect(request.url).toBe("https://api.test/api/v1/csv-imports");
        expect(request.headers.get("content-type")).toBe(
          "application/octet-stream",
        );
        expect(request.headers.get("X-CSV-SHA256")).toBe(hash);
        expect(request.headers.get("X-CSV-Bytes")).toBe("4");
        expect(request.headers.get("x-client-trace")).toBe("owned-request");
        expect(request.headers.has("authorization")).toBe(false);
        expect([...new Uint8Array(await request.arrayBuffer())]).toEqual([
          ...bytes,
        ]);
        return success();
      },
    });
    const result = client.uploadCsvImport({
      ...fields,
      body: view,
      signal: controller.signal,
      headers: { "x-client-trace": "owned-request" },
    });
    view.fill(99);
    expect((await result).data.id).toBe("owned-upload");
  });

  it("sends an immutable Blob as raw bytes and still decodes the JSON response", async () => {
    const body: CsvImportUploadBytes = new Blob([bytes], { type: "text/csv" });
    const client = new EzactoClient({
      baseUrl: "https://api.test",
      fetch: async (input, init) => {
        expect(init?.body).toBe(body);
        const request = new Request(input, init);
        expect(request.headers.get("content-type")).toBe(
          "application/octet-stream",
        );
        expect([...new Uint8Array(await request.arrayBuffer())]).toEqual([
          ...bytes,
        ]);
        return success();
      },
    });
    expect((await client.uploadCsvImport({ ...fields, body })).data.id).toBe(
      "owned-upload",
    );
  });

  it("refuses a JSON-shaped binary body before fetching any content", async () => {
    let fetched = false;
    const client = new EzactoClient({
      baseUrl: "https://api.test",
      fetch: async () => {
        fetched = true;
        return success();
      },
    });
    await expect(
      client.uploadCsvImport({
        ...fields,
        body: { cells: "private" } as unknown as CsvImportUploadBytes,
      }),
    ).rejects.toThrow("Binary request body must be a Blob or Uint8Array.");
    expect(fetched).toBe(false);
  });

  it("preserves native aborts and structured upload refusals", async () => {
    const controller = new AbortController(),
      reason = new DOMException("Cancelled", "AbortError");
    controller.abort(reason);
    const aborted = new EzactoClient({
      baseUrl: "https://api.test",
      fetch: async (_input, init) => {
        expect(init?.signal).toBe(controller.signal);
        throw init!.signal!.reason;
      },
    });
    await expect(
      aborted.uploadCsvImport({
        ...fields,
        body: bytes,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
    const denied = new EzactoClient({
      baseUrl: "https://api.test",
      fetch: async () =>
        Response.json(
          { error: { code: "payload_too_large" } },
          { status: 413, headers: { "x-request-id": "owned-refusal" } },
        ),
    });
    const error = await denied
      .uploadCsvImport({ ...fields, body: bytes })
      .catch((error) => error as unknown);
    expect(error).toBeInstanceOf(EzactoApiError);
    expect(error).toMatchObject({
      status: 413,
      requestId: "owned-refusal",
      body: { error: { code: "payload_too_large" } },
    });
  });
});
