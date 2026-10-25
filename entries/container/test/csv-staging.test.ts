import BetterSqlite3 from "better-sqlite3";
import { build } from "esbuild";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  realpath,
  rm,
  stat,
  readdir,
  readFile,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import {
  beforeAll,
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { migrateContainer, createContainerSessionStore } from "@ezacto/db";
import { createApiApp, createApiSessionService } from "@ezacto/api";
import { createCsvImportStaging } from "../src/csv-staging-service.js";
import { createCsvStagingDisk } from "../src/csv-staging-disk.js";
import { runCsvStagingWork } from "../src/csv-staging-work.js";
import type {
  CsvStagingPreview,
  CsvStagingPage,
  CsvStagingSourceEntity,
  CsvStagingCandidate,
} from "@ezacto/api";
import { createSqliteCsvBrowserService } from "../../../packages/migrate/src/csv-browser-sqlite.js";
import { csvStagingSessionFence } from "@ezacto/db";
import { createWorker } from "../../worker/src/index.js";
import { quarantineRestoredDatabase } from "../src/privacy-restore.js";
import { createContainerHandler } from "../src/handler.js";

const dirs: string[] = [];
let workerUrl: URL;
beforeAll(async () => {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "csv-owned-worker-")),
  );
  dirs.push(dir);
  const output = join(dir, "worker.mjs");
  await build({
    entryPoints: ["src/csv-staging-worker.ts"],
    absWorkingDir: process.cwd(),
    outfile: output,
    bundle: true,
    conditions: ["development"],
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["better-sqlite3", "nodemailer"],
  });
  // External native dependency resolves from the fixture's own package tree.
  await symlink(
    join(process.cwd(), "../../node_modules"),
    join(dir, "node_modules"),
    "dir",
  );
  workerUrl = pathToFileURL(output);
}, 60000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});
const bytes = (csv: string) => new TextEncoder().encode(csv);
const csv =
  "Email,Client,Project,Task,Description,Billable,Start Date,Start Time,End Date,End Time,Duration (h)\nann@example.test,C,P,T,owned private note,Yes,2026-09-01,09:00:00,2026-09-01,09:01:00,00:01:00\n";
const proof = (value: Uint8Array) => ({
  sha256: createHash("sha256").update(value).digest("hex"),
  bytes: value.length,
});
const chunk = async function* (value: Uint8Array) {
  yield value;
};
const fixture = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "csv-stage-")));
  dirs.push(root);
  const path = join(root, "db.sqlite"),
    db = new BetterSqlite3(path);
  migrateContainer(db);
  const t = "2026-09-02T00:00:00.000Z";
  db.prepare(
    "INSERT INTO organizations(name,modules,created_at,updated_at) VALUES('Fictional','{}',?,?)",
  ).run(t, t);
  for (const [n, profile] of [
    [1, "member"],
    [2, "administrator"],
    [3, "administrator"],
    [4, "member"],
  ] as const)
    db.prepare(
      "INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(?,'Owned','Fixture',?,'[]',?,?)",
    ).run(n, profile, t, t);
  db.prepare(
    "INSERT INTO user_emails(user_id,address,is_primary,verified_at,created_at,updated_at) VALUES(1,'ann@example.test',1,?,?,?)",
  ).run(t, t, t);
  db.prepare(
    "INSERT INTO clients(id,name,currency,created_at,updated_at) VALUES(1,'C','EUR',?,?)",
  ).run(t, t);
  db.prepare(
    "INSERT INTO projects(id,client_id,name,created_at,updated_at) VALUES(1,1,'P',?,?)",
  ).run(t, t);
  db.prepare(
    "INSERT INTO tasks(id,name,created_at,updated_at) VALUES(1,'T',?,?)",
  ).run(t, t);
  db.prepare(
    "INSERT INTO user_assignments(project_id,user_id,created_at,updated_at) VALUES(1,1,?,?)",
  ).run(t, t);
  db.prepare(
    "INSERT INTO task_assignments(project_id,task_id,billable,created_at,updated_at) VALUES(1,1,1,?,?)",
  ).run(t, t);
  const store = createContainerSessionStore(db),
    session = await store.issue(2),
    other = await store.issue(3),
    member = await store.issue(4);
  let clock = new Date();
  let injectedError: Error | null = null;
  let afterWork: (() => Promise<void>) | null = null;
  const reported: Error[] = [];
  const service = await createCsvImportStaging({
    database: db,
    databasePath: path,
    directory: join(root, "private"),
    now: () => clock,
    work: async (input, signal) => {
      if (injectedError) throw injectedError;
      const result = await runCsvStagingWork(input, signal, {
        url: workerUrl,
        budgetMs: 15000,
      });
      await afterWork?.();
      return result as never;
    },
  });
  const a = { userId: 2, sessionRowId: session.session.id },
    o = { userId: 3, sessionRowId: other.session.id };
  const app = createApiApp({
    csvImportStaging: service.port,
    authentication: { sessions: createApiSessionService(store) },
    reportError: (error) => {
      reported.push(error);
    },
  });
  const request = (
    route: string,
    init: RequestInit = {},
    token = session.token,
  ) =>
    app.request(`https://owned.test/api/v1${route}`, {
      ...init,
      headers: {
        cookie: `__Host-ezacto_session=${token}`,
        origin: "https://owned.test",
        ...init.headers,
      },
    });
  return {
    root,
    db,
    path,
    service,
    a,
    o,
    store,
    session,
    other,
    member,
    request,
    reported,
    setWorkError: (e: Error) => {
      injectedError = e;
    },
    setAfterWork: (callback: () => Promise<void>) => {
      afterWork = callback;
    },
    setClock: (n: Date) => {
      clock = n;
    },
    close: () => {
      service.close();
      db.close();
    },
  };
};
const choices = (version: number) => ({
  workspace_identity: "owned-clockify",
  exporter_zone: "UTC",
  date_format: "iso" as const,
  destination_interpretation: "source_wall_time" as const,
  currency_policy: "destination_rates" as const,
  mapping: {},
  excluded_lines: [],
  version,
});
const fingerprint = (db: BetterSqlite3.Database) =>
  JSON.stringify(
    (
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((x) => [x.name, db.prepare(`SELECT * FROM "${x.name}"`).all()]),
  );

describe("private native CSV admission", () => {
  it("streams exact bytes, maps explicitly, previews with zero destination writes and returns static diagnostics/catalog", async () => {
    const f = await fixture();
    try {
      const value = bytes(csv),
        uploaded = await f.request("/csv-imports", {
          method: "POST",
          headers: {
            "content-type": "application/octet-stream",
            "x-csv-sha256": proof(value).sha256,
            "x-csv-bytes": String(value.length),
          },
          body: value,
        });
      expect(uploaded.status).toBe(201);
      const run = (
        (await uploaded.json()) as { data: { id: string; version: number } }
      ).data;
      const mapped = await f.request(`/csv-imports/${run.id}/mapping`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(choices(run.version)),
      });
      expect(mapped.status).toBe(200);
      const before = fingerprint(f.db);
      const preview = await f.request(`/csv-imports/${run.id}/preview`, {
        method: "POST",
      });
      expect(preview.status).toBe(200);
      const data = ((await preview.json()) as { data: CsvStagingPreview }).data;
      expect(data.tallies).toMatchObject({
        file_rows: 1,
        selected_rows: 1,
        new_rows: 1,
        source_seconds: 60,
        destination_seconds: 60,
        unpriced: true,
      });
      expect(fingerprint(f.db)).toBe(before);
      const catalog = await f.request(
        `/csv-imports/${run.id}/catalog?preview_id=${data.preview_id}&kind=projects`,
      );
      const source = (
        (await catalog.json()) as {
          data: CsvStagingPage<CsvStagingSourceEntity>;
        }
      ).data.items[0]!;
      expect(source).toMatchObject({ label: "P", selected_id: 1 });
      const candidates = await f.request(
        `/csv-imports/${run.id}/catalog?preview_id=${data.preview_id}&kind=projects&source_key=${source.source_key}`,
      );
      expect(
        (
          (await candidates.json()) as {
            data: CsvStagingPage<CsvStagingCandidate>;
          }
        ).data.items,
      ).toEqual([
        expect.objectContaining({ id: 1, name: "P", currency: "EUR" }),
      ]);
      const diagnostics = await f.request(`/csv-imports/${run.id}/diagnostics`);
      expect(await diagnostics.text()).not.toContain("owned private note");
      expect(
        f.db.prepare("SELECT count(*) AS n FROM time_entries").get(),
      ).toEqual({ n: 0 });
      expect(
        f.db.prepare("SELECT count(*) AS n FROM csv_import_runs").get(),
      ).toEqual({ n: 0 });
      const paths = await readdir(join(f.root, "private", "objects"));
      expect(paths).toHaveLength(1);
      expect(
        (await stat(join(f.root, "private", "objects", paths[0]!))).mode &
          0o777,
      ).toBe(0o600);
      expect(
        (
          await f.service.port.upload(
            f.a,
            chunk(value),
            proof(value),
            new AbortController().signal,
          )
        ).id,
      ).toBe(run.id);
    } finally {
      f.close();
    }
  }, 60000);
  it("checks real session/admin/origin/owner before reading bodies or private input", async () => {
    const f = await fixture();
    try {
      const value = bytes(csv),
        run = await f.service.port.upload(
          f.a,
          chunk(value),
          proof(value),
          new AbortController().signal,
        );
      let reads = 0;
      const deniedBody = new ReadableStream(
        {
          pull(controller) {
            reads++;
            controller.enqueue(new Uint8Array([1]));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      const denied = await f.request(
        `/csv-imports/${run.id}/mapping`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: deniedBody,
          duplex: "half",
        } as RequestInit,
        f.other.token,
      );
      expect(denied.status).toBe(404);
      expect(reads).toBe(0);
      const member = await f.request(
        "/csv-imports",
        {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: bytes("private"),
        },
        f.member.token,
      );
      expect(member.status).toBe(403);
      const foreign = await f.request("/csv-imports", {
        method: "POST",
        headers: { origin: "https://foreign.test" },
        body: bytes("private"),
      });
      expect(foreign.status).toBe(403);
      await f.store.revoke(2, f.session.session.id);
      await expect(f.service.port.read(f.a, run.id)).rejects.toMatchObject({
        code: "administrator_required",
      });
      expect((await f.request(`/csv-imports/${run.id}`)).status).toBe(401);
    } finally {
      f.close();
    }
  }, 60000);
  it("enforces streaming/hash/length/abort limits, removes partial objects, and purges metadata without changing imported time", async () => {
    const f = await fixture();
    try {
      const value = bytes(csv),
        disk = await createCsvStagingDisk(join(f.root, "limits"));
      await expect(
        disk.put("x", chunk(new Uint8Array(5 * 1024 * 1024 + 1)), {
          sha256: "a".repeat(64),
          bytes: 1,
        }),
      ).rejects.toMatchObject({ code: "file_too_large" });
      await expect(
        disk.put("x", chunk(value), {
          ...proof(value),
          sha256: "a".repeat(64),
        }),
      ).rejects.toMatchObject({ code: "hash_mismatch" });
      await expect(
        disk.put("x", chunk(value), { ...proof(value), bytes: 1 }),
      ).rejects.toMatchObject({ code: "length_mismatch" });
      expect(await readdir(join(f.root, "limits"))).toEqual([]);
      const run = await f.service.port.upload(
        f.a,
        chunk(value),
        proof(value),
        new AbortController().signal,
      );
      await f.service.port.map(f.a, run.id, choices(0));
      await f.service.port.preview(
        f.a,
        run.id,
        undefined,
        new AbortController().signal,
      );
      const privateBytes = async () =>
        Buffer.concat(
          await Promise.all(
            (await readdir(join(f.root, "private")))
              .filter((name) => name.startsWith("metadata.sqlite"))
              .map((name) => readFile(join(f.root, "private", name))),
          ),
        );
      expect(
        (await privateBytes()).includes(Buffer.from("owned private note")),
      ).toBe(true);
      const before = fingerprint(f.db);
      await f.service.port.purge(f.a, run.id);
      expect(await f.service.port.read(f.a, run.id)).toMatchObject({
        status: "purged",
        tallies: expect.objectContaining({ file_rows: 1, source_seconds: 60 }),
      });
      expect(await readdir(join(f.root, "private", "objects"))).toEqual([]);
      expect(fingerprint(f.db)).toBe(before);
      const raw = await privateBytes();
      // SQLite can retain freed cells until vacuum: secure_delete is required.
      expect(raw.includes(Buffer.from("owned private note"))).toBe(false);
      expect(
        (await readdir(join(f.root, "private"))).filter(
          (name) => name.endsWith("-wal") || name.endsWith("-journal"),
        ),
      ).toEqual([]);
    } finally {
      f.close();
    }
  }, 60000);
  it("does not let outer idempotency consume CSV content before route authority", async () => {
    let read = 0;
    const handle = createContainerHandler(
      {
        idempotency: { store: {}, secret: "unused" },
        tokens: {},
        sessions: {},
        isOwnMoneyVisible: async () => false,
      } as never,
      { fetch: () => new Response(null, { status: 401 }) },
      { RELEASE: "owned" } as never,
    );
    const stream = new ReadableStream(
      {
        pull() {
          read++;
        },
      },
      { highWaterMark: 0 },
    );
    expect(
      (
        await handle(
          new Request("https://owned.test/api/v1/csv-imports", {
            method: "POST",
            headers: { "idempotency-key": "owned" },
            body: stream,
            duplex: "half",
          } as RequestInit),
        )
      ).status,
    ).toBe(401);
    expect(read).toBe(0);
  });
  it("binds static warnings and excluded source ancestors, refuses stale receipts, and enforces expiry", async () => {
    const f = await fixture();
    try {
      const value = bytes(
        csv.replace(",Yes,", ",No,").replace("T,owned", "T,owned") +
          "ann@example.test,C,P,Excluded,second private note,Yes,2026-09-02,09:00:00,2026-09-02,09:01:00,00:01:00\n",
      );
      const run = await f.service.port.upload(
        f.a,
        chunk(value),
        proof(value),
        new AbortController().signal,
      );
      const mapped = await f.service.port.map(f.a, run.id, {
        ...choices(0),
        excluded_lines: [3],
      });
      const preview = await f.service.port.preview(
        f.a,
        run.id,
        undefined,
        new AbortController().signal,
      );
      expect(preview.organization_name).toBe("Fictional");
      const warnings = await f.service.port.errors(f.a, run.id, {
        previewId: preview.preview_id,
        kind: "warning",
        limit: 1,
      });
      expect(warnings.items).toEqual([
        expect.objectContaining({
          code: "billable_not_applied",
          kind: "warning",
          line: 2,
        }),
      ]);
      const catalog = await f.service.port.catalog(f.a, run.id, {
        previewId: preview.preview_id,
        kind: "tasks",
        limit: 100,
      });
      expect(catalog.items).toContainEqual(
        expect.objectContaining({
          label: "Excluded",
          state: "excluded",
          parents: [
            expect.objectContaining({ label: "C" }),
            expect.objectContaining({ label: "P" }),
          ],
        }),
      );
      f.db
        .prepare(
          "UPDATE organizations SET time_rounding_mode='up',time_rounding_minutes=6",
        )
        .run();
      await expect(
        f.service.apply.loadOwnedPreview(f.a, run.id, preview.preview_id),
      ).rejects.toMatchObject({ code: "preview_stale" });
      const current = await f.service.port.read(f.a, run.id);
      expect(current.preview_stale).toBe(true);
      await expect(
        f.service.apply.claimConfirmation(f.a, {
          stageId: run.id,
          previewId: preview.preview_id,
          expectedVersion: current.version,
          commandId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "preview_stale" });
      await f.service.port.map(f.a, run.id, {
        ...choices(current.version),
        excluded_lines: [3],
      });
      await expect(
        f.service.port.errors(f.a, run.id, {
          previewId: preview.preview_id,
          limit: 1,
        }),
      ).rejects.toMatchObject({ code: "preview_stale" });
      f.setClock(new Date(Date.parse(mapped.staging_expires_at) + 1));
      await expect(f.service.port.mapping(f.a, run.id)).rejects.toMatchObject({
        code: "preview_stale",
      });
      expect(await f.service.port.read(f.a, run.id)).toMatchObject({
        id: run.id,
        purge_allowed: true,
      });
      await f.service.sweep();
      expect(await f.service.port.read(f.a, run.id)).toMatchObject({
        status: "purged",
      });
      expect(await readdir(join(f.root, "private", "objects"))).toEqual([]);
    } finally {
      f.close();
    }
  }, 60000);
  it("reports the original private work fault without exposing cells in logs, and rechecks authority after work", async () => {
    const f = await fixture();
    try {
      const value = bytes(csv),
        run = await f.service.port.upload(
          f.a,
          chunk(value),
          proof(value),
          new AbortController().signal,
        );
      await f.service.port.map(f.a, run.id, choices(0));
      const secret = "owned-private-cell-sentinel";
      const original = new Error(secret),
        logged: unknown[][] = [];
      vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
        logged.push(args);
      });
      f.setWorkError(original);
      const result = await f.request(`/csv-imports/${run.id}/preview`, {
        method: "POST",
      });
      expect(result.status).toBe(503);
      expect(await result.text()).not.toContain(secret);
      expect(f.reported).toEqual([original]);
      expect(JSON.stringify(logged)).not.toContain(secret);
    } finally {
      f.close();
    }
    const g = await fixture();
    try {
      const value = bytes(csv),
        run = await g.service.port.upload(
          g.a,
          chunk(value),
          proof(value),
          new AbortController().signal,
        );
      await g.service.port.map(g.a, run.id, choices(0));
      g.setAfterWork(async () => {
        await g.store.revoke(2, g.session.session.id);
      });
      await expect(
        g.service.port.preview(
          g.a,
          run.id,
          undefined,
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "administrator_required" });
    } finally {
      g.close();
    }
  }, 60000);
  it("refuses unsupported Worker CSV without reading body or constructing database services", async () => {
    let reads = 0,
      databases = 0;
    const env = Object.defineProperty(
      { RELEASE: "owned", ENVIRONMENT: "test" },
      "DB",
      {
        get() {
          databases++;
          throw new Error("DB must not be constructed");
        },
      },
    );
    const stream = new ReadableStream(
      {
        pull() {
          reads++;
        },
      },
      { highWaterMark: 0 },
    );
    const worker = createWorker();
    const response = await worker.fetch!(
      new Request("https://owned.test/api/v1/csv-imports", {
        method: "POST",
        headers: { "idempotency-key": "owned" },
        body: stream,
        duplex: "half",
      } as RequestInit) as never,
      env as never,
      { waitUntil: () => {} } as never,
    );
    expect(response.status).toBe(404);
    expect(reads).toBe(0);
    expect(databases).toBe(0);
    const discovery = await worker.fetch!(
      new Request("https://owned.test/api/v1/csv-import-capabilities") as never,
      env as never,
      { waitUntil: () => {} } as never,
    );
    expect(await discovery.json()).toMatchObject({
      data: {
        runtime: "worker",
        staging_supported: false,
        browser_ready: false,
        apply_supported: false,
      },
    });
  });
  it("rotates destination scope during supported offline restore quarantine", async () => {
    const f = await fixture();
    try {
      const value = bytes(csv),
        run = await f.service.port.upload(
          f.a,
          chunk(value),
          proof(value),
          new AbortController().signal,
        );
      const before = f.db
        .prepare("SELECT nonce FROM csv_staging_instance")
        .get();
      quarantineRestoredDatabase(f.db);
      expect(
        f.db.prepare("SELECT nonce FROM csv_staging_instance").get(),
      ).not.toEqual(before);
      await expect(f.service.port.read(f.a, run.id)).rejects.toMatchObject({
        code: "run_not_found",
      });
    } finally {
      f.close();
    }
  }, 60000);
  it("recovers immutable confirmation receipts and recreates a writer plan only for proven native progress", async () => {
    const f = await fixture();
    try {
      const value = bytes(csv),
        run = await f.service.port.upload(
          f.a,
          chunk(value),
          proof(value),
          new AbortController().signal,
        );
      await f.service.port.map(f.a, run.id, choices(0));
      const preview = await f.service.port.preview(
        f.a,
        run.id,
        undefined,
        new AbortController().signal,
      );
      const commandId = randomUUID(),
        request = {
          preview_id: preview.preview_id,
          command_id: commandId,
          version: preview.run.version,
          expected_selected_rows: 1,
          expected_source_seconds: 60,
          expected_destination_seconds: 60,
          acknowledge_exclusions: false,
          acknowledge_destination_difference: false,
          acknowledge_new_people: false,
        };
      const claim = {
        stageId: run.id,
        previewId: preview.preview_id,
        expectedVersion: preview.run.version,
        commandId,
        requestJson: JSON.stringify(request),
      };
      const original = await f.service.apply.loadOwnedPreview(
        f.a,
        run.id,
        preview.preview_id,
      );
      const claimed = await f.service.apply.claimConfirmation(f.a, claim);
      expect(await f.service.apply.claimConfirmation(f.a, claim)).toEqual(
        claimed,
      );
      const storedPreview = await f.service.port.preview(
        f.a,
        run.id,
        preview.preview_id,
        new AbortController().signal,
      );
      expect(storedPreview.preview_id).toBe(preview.preview_id);
      expect(storedPreview.tallies).toEqual(preview.tallies);
      expect(storedPreview.run.version).toBe(claimed.stageVersion);

      const second = await f.service.port.upload(
        f.a,
        chunk(value),
        proof(value),
        new AbortController().signal,
      );
      expect(second.id).not.toBe(run.id);
      await f.service.port.map(f.a, second.id, choices(0));
      const secondPreview = await f.service.port.preview(
        f.a,
        second.id,
        undefined,
        new AbortController().signal,
      );
      expect(secondPreview.preview_id).not.toBe(preview.preview_id);

      expect(
        await f.service.apply.readOwnedConfirmation(f.a, run.id),
      ).toMatchObject({
        commandId,
        previewId: preview.preview_id,
        stageVersion: claimed.stageVersion,
        requestJson: JSON.stringify(request),
      });
      await expect(
        f.service.apply.claimConfirmation(f.a, {
          ...claim,
          requestJson: JSON.stringify({
            ...request,
            acknowledge_new_people: true,
          }),
        }),
      ).rejects.toMatchObject({ code: "preview_stale" });
      await expect(f.service.port.purge(f.a, run.id)).rejects.toMatchObject({
        code: "run_busy",
      });
      const actor = { kind: "administrator" as const, userId: "2" };
      const native = createSqliteCsvBrowserService(f.db, {
        authorityFence: (a) =>
          csvStagingSessionFence(f.a, original.targetNonce, Number(a.userId)),
      });
      const seal = await native.confirm(actor, original.plan);
      if (seal.outcome === "blocked")
        throw new Error("Owned seal unexpectedly blocked");
      const lease = await native.ledger.claimLease(actor, {
        runId: seal.run.runId,
        holder: "owned",
        ttlMs: 60000,
      });
      if (lease.outcome !== "claimed")
        throw new Error("Owned lease unexpectedly blocked");
      const binding = {
        stageId: run.id,
        stageVersion: claimed.stageVersion,
        targetNonce: claimed.targetNonce,
        previewId: preview.preview_id,
        nativeRunId: Number(seal.run.runId),
        leaseGeneration: lease.lease.generation,
        commandId,
      };
      const bound = await f.service.apply.bindConfirmedRun(f.a, binding);
      expect(await f.service.apply.bindConfirmedRun(f.a, binding)).toEqual(
        bound,
      );
      const refreshed = native.preview(actor, original.sourceId, value, {
        exporterZone: "UTC",
      });
      await native
        .writer(refreshed.snapshot, refreshed.plan)
        .writeRow(
          actor,
          { ...lease.lease, runId: seal.run.runId },
          seal.run.planId,
          refreshed.plan.plan.items[0]!,
          0,
        );
      const resumed = await f.service.apply.loadOwnedPreview(
        f.a,
        run.id,
        preview.preview_id,
      );
      expect(resumed.plan.plan.items[0]?.state).toBe("existing");
      const historicalPreview = await f.service.port.preview(
        f.a,
        second.id,
        secondPreview.preview_id,
        new AbortController().signal,
      );
      const historicalCommand = randomUUID();
      const historicalClaim = await f.service.apply.claimConfirmation(f.a, {
        stageId: second.id,
        previewId: historicalPreview.preview_id,
        expectedVersion: historicalPreview.run.version,
        commandId: historicalCommand,
      });
      await f.service.apply.bindConfirmedRun(f.a, {
        stageId: second.id,
        stageVersion: historicalClaim.stageVersion,
        targetNonce: historicalClaim.targetNonce,
        previewId: historicalPreview.preview_id,
        nativeRunId: Number(seal.run.runId),
        leaseGeneration: lease.lease.generation,
        commandId: historicalCommand,
      });
      f.db.prepare("UPDATE time_entries SET rounded_seconds=120").run();
      await expect(
        f.service.apply.loadOwnedPreview(
          f.a,
          second.id,
          historicalPreview.preview_id,
        ),
      ).rejects.toMatchObject({ code: "preview_stale" });

      expect(
        f.db.prepare("SELECT count(*) AS n FROM time_entries").get(),
      ).toEqual({ n: 1 });
      f.setClock(new Date(Date.parse(run.staging_expires_at) + 1));
      await f.service.sweep();
      expect(await readdir(join(f.root, "private", "objects"))).toEqual([]);
      expect(await f.service.port.read(f.a, run.id)).toMatchObject({
        status: "purged",
      });
      expect(
        await f.service.apply.readOwnedConfirmation(f.a, run.id),
      ).toMatchObject({ commandId, previewId: preview.preview_id });
      expect(
        await f.service.apply.readOwnedApplyBinding(f.a, run.id),
      ).toMatchObject({ nativeRunId: Number(seal.run.runId), commandId });
      await expect(
        f.service.apply.loadOwnedPreview(f.a, run.id, preview.preview_id),
      ).rejects.toMatchObject({ code: "preview_stale" });
    } finally {
      f.close();
    }
  }, 60000);
  it("bounds raw type and mapping/parse work without retaining overflowing or aborted content", async () => {
    const f = await fixture();
    try {
      for (const text of ["%PDF-1.7\nowned", "PK\u0003\u0004owned"]) {
        const value = bytes(text);
        await expect(
          f.service.port.upload(
            f.a,
            chunk(value),
            proof(value),
            new AbortController().signal,
          ),
        ).rejects.toMatchObject({ code: "not_csv" });
      }
      const value = new Uint8Array([255]);
      await expect(
        f.service.port.upload(
          f.a,
          chunk(value),
          proof(value),
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "invalid_utf8" });
      const actual = bytes(csv),
        run = await f.service.port.upload(
          f.a,
          chunk(actual),
          proof(actual),
          new AbortController().signal,
        );
      const oversized = await f.request(`/csv-imports/${run.id}/mapping`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: " ".repeat(1024 * 1024 + 1),
      });
      expect(oversized.status).toBe(413);
      expect((await f.service.port.read(f.a, run.id)).version).toBe(0);
      const abort = new AbortController();
      abort.abort();
      await expect(
        runCsvStagingWork({}, abort.signal, { url: workerUrl }),
      ).rejects.toMatchObject({ code: "upload_aborted" });
      await expect(
        runCsvStagingWork(
          { kind: "admit", bytes: actual },
          new AbortController().signal,
          { url: workerUrl, budgetMs: 1 },
        ),
      ).rejects.toMatchObject({ code: "parse_budget_exceeded" });
      expect(await readdir(join(f.root, "private", "objects"))).toHaveLength(1);
    } finally {
      f.close();
    }
  }, 60000);
  it("persists pending-claim cancellation before any native run, rejects delayed work and preserves raw-free replay after expiry", async () => {
    const f = await fixture();
    try {
      const value = bytes(csv),
        run = await f.service.port.upload(
          f.a,
          chunk(value),
          proof(value),
          new AbortController().signal,
        );
      await f.service.port.map(f.a, run.id, choices(0));
      const preview = await f.service.port.preview(
        f.a,
        run.id,
        undefined,
        new AbortController().signal,
      );
      const commandId = randomUUID();
      const claimed = await f.service.apply.claimConfirmation(f.a, {
        stageId: run.id,
        previewId: preview.preview_id,
        expectedVersion: preview.run.version,
        commandId,
      });
      const input = {
        stageId: run.id,
        previewId: preview.preview_id,
        confirmationCommandId: commandId,
        cancellationCommandId: randomUUID(),
        expectedVersion: claimed.stageVersion,
      };
      const cancelled = await f.service.apply.requestOwnedCancellation(
        f.a,
        input,
      );
      expect(
        await f.service.apply.requestOwnedCancellation(f.a, {
          ...input,
          expectedVersion: cancelled.stageVersion,
        }),
      ).toEqual(cancelled);
      await expect(
        f.service.apply.requestOwnedCancellation(f.a, {
          ...input,
          cancellationCommandId: randomUUID(),
          expectedVersion: cancelled.stageVersion,
        }),
      ).rejects.toMatchObject({ code: "preview_stale" });
      await expect(
        f.service.apply.loadOwnedPreview(f.a, run.id, preview.preview_id),
      ).rejects.toMatchObject({ code: "preview_stale" });
      await expect(
        f.service.apply.bindConfirmedRun(f.a, {
          stageId: run.id,
          stageVersion: cancelled.stageVersion,
          targetNonce: cancelled.targetNonce,
          previewId: preview.preview_id,
          nativeRunId: 1,
          leaseGeneration: 0,
          commandId,
        }),
      ).rejects.toMatchObject({ code: "preview_stale" });
      expect(
        f.db.prepare("SELECT count(*) AS n FROM csv_import_runs").get(),
      ).toEqual({ n: 0 });
      expect(
        f.db.prepare("SELECT count(*) AS n FROM time_entries").get(),
      ).toEqual({ n: 0 });
      f.setClock(new Date(Date.parse(run.staging_expires_at) + 1));
      await f.service.sweep();
      expect(await readdir(join(f.root, "private", "objects"))).toEqual([]);
      expect(
        await f.service.apply.readOwnedConfirmation(f.a, run.id),
      ).toMatchObject({
        commandId,
        cancellationCommandId: input.cancellationCommandId,
      });
      expect(
        await f.service.apply.requestOwnedCancellation(f.a, {
          ...input,
          expectedVersion: 99,
        }),
      ).toMatchObject({ cancellationCommandId: input.cancellationCommandId });
    } finally {
      f.close();
    }
    const g = await fixture();
    try {
      const value = bytes(csv),
        run = await g.service.port.upload(
          g.a,
          chunk(value),
          proof(value),
          new AbortController().signal,
        );
      await g.service.port.map(g.a, run.id, choices(0));
      const preview = await g.service.port.preview(
          g.a,
          run.id,
          undefined,
          new AbortController().signal,
        ),
        commandId = randomUUID();
      const claim = await g.service.apply.claimConfirmation(g.a, {
        stageId: run.id,
        previewId: preview.preview_id,
        expectedVersion: preview.run.version,
        commandId,
      });
      g.setAfterWork(async () => {
        await g.service.apply.requestOwnedCancellation(g.a, {
          stageId: run.id,
          previewId: preview.preview_id,
          confirmationCommandId: commandId,
          cancellationCommandId: randomUUID(),
          expectedVersion: claim.stageVersion,
        });
      });
      await expect(
        g.service.apply.loadOwnedPreview(g.a, run.id, preview.preview_id),
      ).rejects.toMatchObject({ code: "preview_stale" });
      expect(
        g.db.prepare("SELECT count(*) AS n FROM time_entries").get(),
      ).toEqual({ n: 0 });
    } finally {
      g.close();
    }
  }, 60000);
});
