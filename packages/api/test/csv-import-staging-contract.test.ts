import { createHash } from "node:crypto";
import { apiContractOperations } from "../src/contract.js";
import { describe, expect, it } from "vitest";
import {
  CSV_RAW_RETENTION_MS,
  CSV_STAGING_LIMITS,
  CsvByteBudget,
  CsvStagingError,
  authorizeCsvStaging,
  canTransition,
  csvImportStagingOperations,
  csvImportStagingSchemas,
  csvPreviewId,
  csvRunStatuses,
  csvStagingErrorStatus,
  isCsvPreviewCurrent,
  rawRetentionDeadline,
  type CsvPreviewBinding,
  type CsvStagingCaller,
  type CsvStagingStore,
} from "../src/csv-import-staging-contract.js";

const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** Fake private store: the reference any real StagingStore must match. */
const fakeStore = (): CsvStagingStore & { keys: () => string[] } => {
  const objects = new Map<string, Uint8Array>();
  let n = 0;
  return {
    keys: () => [...objects.keys()],
    async put(_runId, body, expected) {
      const budget = new CsvByteBudget();
      const chunks: Uint8Array[] = [];
      for await (const chunk of body) {
        budget.take(chunk);
        chunks.push(chunk);
      }
      const all = Buffer.concat(chunks);
      if (all.byteLength !== expected.bytes)
        throw new CsvStagingError("length_mismatch");
      if (digest(all) !== expected.sha256)
        throw new CsvStagingError("hash_mismatch");
      n += 1;
      const objectKey = `stg_${n}_${hash(String(n)).slice(0, 16)}`;
      objects.set(objectKey, new Uint8Array(all));
      return { objectKey };
    },
    async read(key) {
      return objects.get(key) ?? null;
    },
    async delete(key) {
      objects.delete(key);
    },
  };
};

const stream = async function* (...parts: Uint8Array[]) {
  for (const part of parts) yield part;
};

const admin: CsvStagingCaller = {
  kind: "session",
  administrator: true,
  profileId: "p1",
  sameOrigin: true,
};
const run = { id: "r1", target: "org", createdByProfileId: "p1" };

describe("staging store contract", () => {
  it("stores under a generated key, verifies hash and length, and has no URL method", async () => {
    const store = fakeStore();
    const bytes = new TextEncoder().encode("Email,Client\na@example.test,C\n");
    const { objectKey } = await store.put(
      "r1",
      stream(bytes.slice(0, 5), bytes.slice(5)),
      { sha256: digest(bytes), bytes: bytes.length },
    );
    expect(objectKey).not.toContain("a@example");
    expect(Object.keys(store)).not.toContain("url");
    expect(await store.read(objectKey)).toEqual(bytes);
    await store.delete(objectKey);
    expect(await store.read(objectKey)).toBeNull();
  });
  it("refuses a wrong hash or length and keeps nothing", async () => {
    const store = fakeStore();
    const bytes = new TextEncoder().encode("abc");
    await expect(
      store.put("r", stream(bytes), { sha256: "x", bytes: 3 }),
    ).rejects.toMatchObject({ code: "hash_mismatch" });
    await expect(
      store.put("r", stream(bytes), { sha256: digest(bytes), bytes: 4 }),
    ).rejects.toMatchObject({ code: "length_mismatch" });
    expect(store.keys()).toEqual([]);
  });
  it("enforces the byte limit while streaming, before retaining the overflowing chunk", async () => {
    const store = fakeStore();
    const big = new Uint8Array(CSV_STAGING_LIMITS.maxBytes);
    await expect(
      store.put("r", stream(big, new Uint8Array(1)), {
        sha256: "x",
        bytes: big.length + 1,
      }),
    ).rejects.toMatchObject({ code: "file_too_large" });
    expect(store.keys()).toEqual([]);
  });
});

describe("authorization order", () => {
  const load = () => run;
  it("denies before any run is loaded", () => {
    let loaded = false;
    const spy = () => {
      loaded = true;
      return run;
    };
    expect(
      authorizeCsvStaging(
        "container",
        { ...admin, kind: "token" },
        false,
        "org",
        spy,
      ),
    ).toBe("token_denied");
    expect(
      authorizeCsvStaging(
        "container",
        { ...admin, kind: "anonymous" },
        false,
        "org",
        spy,
      ),
    ).toBe("session_required");
    expect(
      authorizeCsvStaging(
        "container",
        { ...admin, administrator: false },
        false,
        "org",
        spy,
      ),
    ).toBe("administrator_required");
    expect(
      authorizeCsvStaging(
        "container",
        { ...admin, sameOrigin: false },
        true,
        "org",
        spy,
      ),
    ).toBe("csrf_failed");
    expect(loaded).toBe(false);
  });
  it("allows an administrator on a same-origin mutation of their own run", () => {
    expect(
      authorizeCsvStaging("container", admin, true, "org", load),
    ).toBeNull();
    expect(
      authorizeCsvStaging(
        "container",
        { ...admin, sameOrigin: false },
        false,
        "org",
        load,
      ),
    ).toBeNull();
  });
  it("makes cross-run, cross-profile and missing runs indistinguishable", () => {
    expect(
      authorizeCsvStaging(
        "container",
        { ...admin, profileId: "p2" },
        false,
        "org",
        load,
      ),
    ).toBe("run_not_found");
    expect(authorizeCsvStaging("container", admin, false, "other", load)).toBe(
      "run_not_found",
    );
    expect(
      authorizeCsvStaging("container", admin, false, "org", () => null),
    ).toBe("run_not_found");
  });
  it("reports the worker runtime unsupported to everyone", () => {
    expect(authorizeCsvStaging("worker", admin, false, "org", null)).toBe(
      "capability_unsupported",
    );
  });
});

describe("retention and state machine", () => {
  it("sets a 24 hour deadline only once terminal", () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    expect(rawRetentionDeadline("previewed", at)).toBeNull();
    expect(rawRetentionDeadline("failed", null)).toBeNull();
    for (const status of [
      "completed",
      "failed",
      "cancelled",
      "expired",
    ] as const)
      expect(rawRetentionDeadline(status, at)).toBe(
        new Date(at.getTime() + CSV_RAW_RETENTION_MS).toISOString(),
      );
    expect(CSV_RAW_RETENTION_MS).toBe(86_400_000);
  });
  it("only reaches confirmed from previewed, and purged is final", () => {
    for (const from of csvRunStatuses)
      expect(canTransition(from, "confirmed")).toBe(from === "previewed");
    for (const to of csvRunStatuses)
      expect(canTransition("purged", to)).toBe(false);
    expect(canTransition("previewed", "staged")).toBe(true);
  });
});

describe("preview identity", () => {
  const binding: CsvPreviewBinding = {
    target: "org",
    fileSha256: "f",
    adapter: "clockify@1",
    identityVersion: "v1",
    sourceId: "s",
    mappingSha256: "m",
    dateFormat: "iso",
    exportTimeZone: "UTC",
    destinationInterpretation: "wall-clock",
    currency: "USD",
    excludedLines: [9, 3],
    destinationVersions: { rates: "1", locks: "2" },
  };
  const id = csvPreviewId(binding, hash);
  it("is deterministic and order-insensitive for exclusions and version keys", () => {
    expect(
      csvPreviewId(
        {
          ...binding,
          excludedLines: [3, 9],
          destinationVersions: { locks: "2", rates: "1" },
        },
        hash,
      ),
    ).toBe(id);
    expect(id).toMatch(/^prv_[0-9a-f]{64}$/);
  });
  it("changes with every bound input, so a stale preview cannot confirm", () => {
    const changes: Partial<CsvPreviewBinding>[] = [
      { target: "x" },
      { fileSha256: "x" },
      { adapter: "x" },
      { identityVersion: "x" },
      { sourceId: "x" },
      { mappingSha256: "x" },
      { exportTimeZone: "x" },
      { destinationInterpretation: "x" },
      { currency: "x" },
      { excludedLines: [3] },
      { destinationVersions: { rates: "2", locks: "2" } },
    ];
    for (const change of changes)
      expect(isCsvPreviewCurrent(id, { ...binding, ...change }, hash)).toBe(
        false,
      );
    expect(isCsvPreviewCurrent(id, binding, hash)).toBe(true);
  });
});

describe("operations and schemas", () => {
  const ops = csvImportStagingOperations;
  it("are session-only, expose no apply, and every referenced schema exists", () => {
    expect(
      ops.every(
        (op) =>
          op.sessionOnly === true &&
          op.tokenOnly !== true &&
          op.public !== true,
      ),
    ).toBe(true);
    expect(
      ops.some((op) => /apply|confirm/i.test(op.operationId + op.path)),
    ).toBe(false);
    const names = new Set(Object.keys(csvImportStagingSchemas));
    for (const op of ops)
      for (const schema of [op.responseSchema, op.requestSchema])
        if (schema) expect(names.has(schema)).toBe(true);
  });
  it("are not registered: no runtime advertises browser CSV import", () => {
    const registered = new Set(
      apiContractOperations.map((op) => op.operationId),
    );
    for (const op of ops) expect(registered.has(op.operationId)).toBe(false);
  });
  it("map every error code to a 4xx and limits match the plan", () => {
    for (const status of Object.values(csvStagingErrorStatus))
      expect(status).toBeGreaterThanOrEqual(400);
    expect(CSV_STAGING_LIMITS).toMatchObject({
      maxBytes: 5242880,
      maxRows: 50000,
      maxColumns: 40,
      maxFieldLength: 10000,
      maxNameLength: 255,
      maxMappingBytes: 1048576,
    });
  });
});
