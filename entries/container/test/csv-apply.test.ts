import { build } from "esbuild";
import { canonicalCsvApplyCommand } from "@ezacto/core";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  realpath,
  rm,
  symlink,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  createContainerSessionStore,
  createContainerDatabase,
  createApiTokenStore,
  createContainerIdempotencyStore,
  createCsvApplyRunStore,
} from "@ezacto/db";
import { createApiApp, createApiSessionService } from "@ezacto/api";
import type {
  CsvApplyCommand,
  CsvApplyRunData,
} from "../../../packages/api/src/csv-import-apply-port.js";
import type {
  CsvStagingPreview,
  CsvStagingRunData,
} from "../../../packages/api/src/csv-import-staging-port.js";
import { createCsvImportStaging } from "../src/csv-staging-service.js";
import { runCsvStagingWork } from "../src/csv-staging-work.js";
import { createCsvImportApply } from "../src/csv-apply-service.js";
import { createContainerHandler } from "../src/handler.js";
import { createOwnedPlannerDestination } from "../../../packages/migrate/test/support/csv-planner-acceptance.js";

let workerUrl: URL;
let workerDirectory: string;
beforeAll(async () => {
  workerDirectory = await realpath(
    await mkdtemp(join(tmpdir(), "csv-apply-owned-worker-")),
  );
  const output = join(workerDirectory, "worker.mjs");
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
  await symlink(
    join(process.cwd(), "../../node_modules"),
    join(workerDirectory, "node_modules"),
    "dir",
  );
  workerUrl = pathToFileURL(output);
}, 60000);
afterAll(async () => {
  if (workerDirectory)
    await rm(workerDirectory, { recursive: true, force: true });
});
const origin = "https://owned-import.test";
const fixture = async (
  rows = 2,
  transform: (source: string) => string = (source) => source,
) => {
  const destination = await createOwnedPlannerDestination();
  const db = destination.writer;
  const store = createContainerSessionStore(db);
  const administrator = await store.issue(2);
  const member = await store.issue(3);
  const tokens = createApiTokenStore(createContainerDatabase(db));
  const token = await tokens.issue({
    userId: 2,
    name: "Owned CSV denial",
    scopes: ["reports:read"],
  });
  const time = new Date().toISOString();
  // Positive unrelated financial witnesses; no provider operation is involved.
  db.prepare(
    `INSERT INTO invoices(id,client_id,created_by_user_id,number,currency,issue_date,due_date,amount_cents,due_amount_cents,created_at,updated_at)
 VALUES(990,2,2,'OWNED-UNAFFECTED','EUR','2026-09-01','2026-09-30',12345,12345,?,?)`,
  ).run(time, time);
  const money = () =>
    createHash("sha256")
      .update(
        JSON.stringify([
          db.prepare("SELECT * FROM invoices ORDER BY id").all(),
          db.prepare("SELECT * FROM invoice_payments ORDER BY id").all(),
          db.prepare("SELECT * FROM expenses ORDER BY id").all(),
          db.prepare("SELECT * FROM invoice_line_items ORDER BY id").all(),
        ]),
      )
      .digest("hex");
  const moneyBefore = money();
  const runs = createCsvApplyRunStore(db);
  let clock: Date | null = null;
  const staging = await createCsvImportStaging({
    database: db,
    databasePath: destination.path,
    directory: join(dirname(destination.path), "private-csv"),
    now: () => clock ?? new Date(),
    verifyApplyBinding: runs.verifyStageBinding,
    work: (input, signal) =>
      runCsvStagingWork(input, signal, {
        url: workerUrl,
        budgetMs: 15000,
      }) as never,
  });
  let afterInput: (() => Promise<void>) | null = null;
  const privatePort = {
    ...staging.apply,
    async loadOwnedPreview(
      ...args: Parameters<typeof staging.apply.loadOwnedPreview>
    ) {
      const input = await staging.apply.loadOwnedPreview(...args);
      await afterInput?.();
      return input;
    },
  };
  let apply = createCsvImportApply({
    database: db,
    staging: staging.port,
    privateStaging: privatePort,
  });
  const sessions = createApiSessionService(store);
  const app = createApiApp({
    authentication: { sessions, tokens },
    csvImportStaging: staging.port,
    csvImportApply: {
      apply: (...args) => apply.port.apply(...args),
      resume: (...args) => apply.port.resume(...args),
      status: (...args) => apply.port.status(...args),
      cancel: (...args) => apply.port.cancel(...args),
    },
  });
  const handle = createContainerHandler(
    {
      idempotency: {
        store: createContainerIdempotencyStore(db),
        secret: "owned-only-idempotency-secret",
      },
      tokens,
      sessions,
      isOwnMoneyVisible: async () => false,
    } as never,
    { fetch: (request) => app.fetch(request) },
    { RELEASE: "owned-csv-acceptance" } as never,
  );
  let sessionToken = administrator.token;
  const request = (
    path: string,
    init: RequestInit = {},
    cookie = sessionToken,
  ) =>
    handle(
      new Request(origin + "/api/v1" + path, {
        ...init,
        headers: {
          cookie: "__Host-ezacto_session=" + cookie,
          origin,
          ...init.headers,
        },
        ...(init.body instanceof ReadableStream ? { duplex: "half" } : {}),
      } as RequestInit),
    );
  const json = <T>(path: string, body: unknown, commandId?: string) =>
    request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(commandId ? { "idempotency-key": commandId } : {}),
      },
      body: JSON.stringify(body),
    }).then(async (response) => {
      expect(response.status).toBe(200);
      return ((await response.json()) as { data: T }).data;
    });
  const source = transform(
    await readFile(
      new URL(
        "../../../packages/migrate/test/fixtures/csv-browser-planner/preview.csv",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const [header, line] = source.trimEnd().split("\n");
  const bytes = new TextEncoder().encode(
    header + "\n" + Array.from({ length: rows }, () => line).join("\n") + "\n",
  );
  const prepare = async () => {
    const response = await request("/csv-imports", {
      method: "POST",
      headers: {
        "content-type": "text/csv",
        "x-csv-sha256": createHash("sha256").update(bytes).digest("hex"),
        "x-csv-bytes": String(bytes.length),
      },
      body: Buffer.from(bytes),
    });
    expect(response.status).toBe(201);
    const uploaded = ((await response.json()) as { data: CsvStagingRunData })
      .data;
    const mapped = await request(`/csv-imports/${uploaded.id}/mapping`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace_identity: "owned-csv-apply",
        exporter_zone: "UTC",
        date_format: "iso",
        destination_interpretation: "source_wall_time",
        currency_policy: "destination_rates",
        mapping: {},
        excluded_lines: [],
        version: uploaded.version,
      }),
    });
    expect(mapped.status).toBe(200);
    const beforeBusiness = createHash("sha256")
      .update(
        JSON.stringify(
          [
            "users",
            "user_emails",
            "clients",
            "projects",
            "tasks",
            "user_assignments",
            "task_assignments",
            "time_entries",
            "event_outbox",
          ].map((table) =>
            db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
          ),
        ),
      )
      .digest("hex");
    const preview = await json<CsvStagingPreview>(
      `/csv-imports/${uploaded.id}/preview`,
      {},
    );
    const afterBusiness = createHash("sha256")
      .update(
        JSON.stringify(
          [
            "users",
            "user_emails",
            "clients",
            "projects",
            "tasks",
            "user_assignments",
            "task_assignments",
            "time_entries",
            "event_outbox",
          ].map((table) =>
            db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
          ),
        ),
      )
      .digest("hex");
    expect(afterBusiness).toBe(beforeBusiness);
    const command: CsvApplyCommand = {
      preview_id: preview.preview_id,
      command_id: randomUUID(),
      version: preview.run.version,
      expected_selected_rows: preview.tallies.selected_rows,
      expected_source_seconds: preview.tallies.source_seconds,
      expected_destination_seconds: preview.tallies.destination_seconds,
      acknowledge_exclusions: true,
      acknowledge_destination_difference: true,
      acknowledge_new_people: true,
    };
    return { stage: preview.run, preview, command };
  };
  return {
    db,
    runs,
    staging,
    request,
    json,
    prepare,
    token,
    member,
    money,
    moneyBefore,
    objectsDirectory: join(dirname(destination.path), "private-csv", "objects"),
    get apply() {
      return apply;
    },
    async recreate() {
      await apply.close();
      apply = createCsvImportApply({
        database: db,
        staging: staging.port,
        privateStaging: privatePort,
      });
    },
    async reauthenticate() {
      const fresh = await store.issue(2);
      sessionToken = fresh.token;
      return fresh;
    },
    revoke: () => store.revoke(2, administrator.session.id),
    setAfterInput: (callback: (() => Promise<void>) | null) => {
      afterInput = callback;
    },
    setClock: (value: Date) => {
      clock = value;
    },
    async close() {
      await apply.close();
      staging.close();
      await destination.close();
    },
  };
};
const status = async (
  f: Awaited<ReturnType<typeof fixture>>,
  stageId: string,
) => {
  const response = await f.request(`/csv-imports/${stageId}/apply`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { data: CsvApplyRunData }).data;
};
describe("owned Container CSV apply acceptance", () => {
  it("streams, previews without business writes, explicitly applies, recovers a lost reply and retains exact dedup after raw purge", async () => {
    const f = await fixture();
    try {
      const input = await f.prepare();
      const invalidKey = await f.request(`/csv-imports/${input.stage.id}/apply`, {
        method: "POST", headers: { "content-type": "application/json", "idempotency-key": randomUUID() }, body: JSON.stringify(input.command),
      });
      expect(invalidKey.status).toBe(400);
      expect(await invalidKey.json()).toMatchObject({ error: { code: "invalid_command" } });
      // Owned client transport drops the accepted response before reading its
      // body. No server fault hook or extra native write is introduced.
      await expect(
        (async () => {
          const response = await f.request(
            `/csv-imports/${input.stage.id}/apply`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "idempotency-key": input.command.command_id,
              },
              body: JSON.stringify(input.command),
            },
          );
          expect(response.status).toBe(200);
          throw new Error("Owned simulated reply loss");
        })(),
      ).rejects.toThrow("Owned simulated reply loss");
      const queued = await status(f, input.stage.id);
      expect(queued.state).toBe("queued");
      expect(queued.pending_command).toEqual(input.command);
      expect(await f.apply.tick()).toMatchObject({ state: "complete" });
      const complete = await status(f, input.stage.id);
      expect(complete).toMatchObject({
        state: "completed",
        committed_rows: 2,
        inserted_rows: 2,
        source_seconds_committed: 7202,
        destination_seconds: 7200,
        destination_delta_seconds: -2,
      });
      // The client receives no first reply; exact retry must use the durable receipt.
      const replay = await f.json<CsvApplyRunData>(
        `/csv-imports/${input.stage.id}/apply`,
        input.command,
        input.command.command_id,
      );
      expect(replay.state).toBe("completed");
      const conflicting = await f.request(`/csv-imports/${input.stage.id}/apply`, {
        method: "POST", headers: { "content-type": "application/json", "idempotency-key": input.command.command_id },
        body: JSON.stringify({ ...input.command, expected_source_seconds: input.command.expected_source_seconds + 1 }),
      });
      expect(conflicting.status).toBe(409);
      expect(await conflicting.json()).toMatchObject({ error: { code: "command_conflict" } });
      expect(
        f.db.prepare("SELECT count(*) AS n FROM time_entries").get(),
      ).toEqual({ n: 2 });
      expect(f.money()).toBe(f.moneyBefore);
      f.setClock(new Date(Date.now() + 25 * 3600000));
      await f.staging.sweep();
      expect(await readdir(f.objectsDirectory)).toEqual([]);
      const purged = await status(f, input.stage.id);
      expect(purged).toMatchObject({ state: "completed", committed_rows: 2 });
      const retained = await f.json<CsvApplyRunData>(
        `/csv-imports/${input.stage.id}/apply`,
        input.command,
        input.command.command_id,
      );
      expect(retained.state).toBe("completed");
      expect(
        f.db.prepare("SELECT count(*) AS n FROM csv_import_entries").get(),
      ).toEqual({ n: 2 });
      expect(
        f.db.prepare("SELECT count(*) AS n FROM csv_import_chunks").get(),
      ).toEqual({ n: 2 });
      expect(f.money()).toBe(f.moneyBefore);
      await writeFile(
        "/tmp/ezacto-1183-owned-acceptance-artifact.json",
        JSON.stringify(
          {
            scope: "owned-disposable-sqlite-only",
            harness: "entries/container/test/csv-apply.test.ts",
            source_sha256: input.stage.file_sha256,
            adapter_id: input.preview.choices.adapter_id,
            actual_actor_user_id: 2,
            exporter_zone: input.preview.choices.exporter_zone,
            organization_currency: input.preview.tallies.organization_currency,
            file_rows: complete.file_rows,
            selected_rows: complete.selected_rows,
            committed_rows: complete.committed_rows,
            inserted_rows: complete.inserted_rows,
            already_imported_rows: complete.already_imported_rows,
            source_seconds: complete.source_seconds_committed,
            destination_seconds: complete.destination_seconds,
            destination_delta_seconds: complete.destination_delta_seconds,
            raw_objects_after_purge: 0,
            retained_keys: 2,
            retained_chunks: 2,
            unrelated_money_unchanged: true,
          },
          null,
          2,
        ) + "\n",
        { mode: 0o600 },
      );
      // A new owned upload of identical bytes is a second review, not a new import.
      f.setClock(new Date());
      const repeatedInput = await f.prepare();
      expect(repeatedInput.preview.tallies).toMatchObject({ new_rows: 0, already_imported_rows: 2 });
      await f.json<CsvApplyRunData>(`/csv-imports/${repeatedInput.stage.id}/apply`, repeatedInput.command, repeatedInput.command.command_id);
      await f.apply.tick();
      expect((await status(f, repeatedInput.stage.id)).state).toBe("completed");
      expect(f.db.prepare("SELECT count(*) AS n FROM time_entries").get()).toEqual({ n: 2 });
      expect(f.money()).toBe(f.moneyBefore);
      const receiptPath = "/tmp/ezacto-1183-owned-acceptance-artifact.json";
      const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      await writeFile(receiptPath, JSON.stringify({ ...receipt, fresh_same_file_reupload_new_rows: repeatedInput.preview.tallies.new_rows, fresh_same_file_reupload_already_imported_rows: repeatedInput.preview.tallies.already_imported_rows, command_conflict_status: conflicting.status }, null, 2) + "\n", {mode: 0o600});
    } finally {
      await f.close();
    }
  });
  it("retains committed progress across process recreation and pauses an expired/revoked original session until explicit current-session Resume", async () => {
    const f = await fixture(26);
    try {
      const input = await f.prepare();
      await f.json(
        `/csv-imports/${input.stage.id}/apply`,
        input.command,
        input.command.command_id,
      );
      expect(await f.apply.tick()).toMatchObject({ state: "queued" });
      const progress = await status(f, input.stage.id);
      expect(progress.committed_rows).toBeGreaterThan(0);
      expect(progress.committed_rows).toBeLessThan(26);
      await f.revoke();
      await f.recreate();
      expect(await f.apply.tick()).toMatchObject({ state: "paused" });
      const before = f.db
        .prepare("SELECT count(*) AS n FROM time_entries")
        .get();
      await f.reauthenticate();
      const paused = await status(f, input.stage.id);
      expect(paused.code).toBe("authority_revoked");
      const stageResponse = await f.request(`/csv-imports/${input.stage.id}`);
      const stage = (
        (await stageResponse.json()) as { data: CsvStagingRunData }
      ).data;
      const resume = {
        ...input.command,
        command_id: randomUUID(),
        version: stage.version,
      };
      await f.json(
        `/csv-imports/${input.stage.id}/resume`,
        resume,
        resume.command_id,
      );
      expect(
        f.db.prepare("SELECT count(*) AS n FROM time_entries").get(),
      ).toEqual(before);
      for (
        let tick = 0;
        tick < 26 && (await status(f, input.stage.id)).state !== "completed";
        tick++
      )
        await f.apply.tick();
      expect(await status(f, input.stage.id)).toMatchObject({
        state: "completed",
        committed_rows: 26,
        inserted_rows: 26,
      });
      expect(
        f.db.prepare("SELECT count(*) AS n FROM time_entries").get(),
      ).toEqual({ n: 26 });
      expect(f.money()).toBe(f.moneyBefore);
    } finally {
      await f.close();
    }
  });
  it("cancels a durable claim before native binding, refuses delayed recovery and remains metadata-readable after input expiry", async () => {
    const f = await fixture();
    try {
      const input = await f.prepare();
      const issued = f.db
        .prepare("SELECT id FROM sessions WHERE user_id=2 ORDER BY id LIMIT 1")
        .get() as { id: number };
      await f.staging.apply.claimConfirmation(
        { userId: 2, sessionRowId: issued.id },
        {
          stageId: input.stage.id,
          previewId: input.preview.preview_id,
          expectedVersion: input.command.version,
          commandId: input.command.command_id,
          requestJson: canonicalCsvApplyCommand(input.command).json,
        },
      );
      f.setClock(new Date(Date.now() + 25 * 3600000));
      await f.staging.sweep();
      const cancellation = { command_id: randomUUID() };
      const result = await f.json<CsvApplyRunData>(
        `/csv-imports/${input.stage.id}/cancel`,
        cancellation,
        cancellation.command_id,
      );
      expect(result.state).toBe("cancelled");
      const delayed = await f.request(`/csv-imports/${input.stage.id}/apply`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": input.command.command_id,
        },
        body: JSON.stringify(input.command),
      });
      expect(delayed.status).toBe(409);
      expect(await f.apply.tick()).toBeNull();
      expect(
        f.db.prepare("SELECT count(*) AS n FROM time_entries").get(),
      ).toEqual({ n: 0 });
      expect(f.money()).toBe(f.moneyBefore);
    } finally {
      await f.close();
    }
  });
  it("cancels after a committed bounded chunk, preserves prior time and permits raw-input purge without deleting receipts", async () => {
    const f = await fixture(26, (source) =>
      source.replaceAll("Existing project", "Owned newly imported project"),
    );
    try {
      const input = await f.prepare();
      await f.json(
        `/csv-imports/${input.stage.id}/apply`,
        input.command,
        input.command.command_id,
      );
      expect(await f.apply.tick()).toMatchObject({ state: "queued" });
      expect(
        f.db.prepare("SELECT count(*) AS n FROM csv_import_setup").get(),
      ).toMatchObject({ n: expect.any(Number) });
      const setupBefore = f.db
        .prepare("SELECT * FROM csv_import_setup ORDER BY setup_key")
        .all();
      expect(setupBefore.length).toBeGreaterThan(0);
      const committed = f.db
        .prepare("SELECT count(*) AS n FROM time_entries")
        .get() as { n: number };
      expect(committed.n).toBeGreaterThan(0);
      expect(committed.n).toBeLessThan(26);
      const cancellation = { command_id: randomUUID() };
      const cancelled = await f.json<CsvApplyRunData>(
        `/csv-imports/${input.stage.id}/cancel`,
        cancellation,
        cancellation.command_id,
      );
      expect(cancelled).toMatchObject({
        state: "cancelled",
        committed_rows: committed.n,
      });
      expect(await f.apply.tick()).toBeNull();
      const purge = await f.request(`/csv-imports/${input.stage.id}/input`, {
        method: "DELETE",
      });
      expect(purge.status).toBe(204);
      expect(
        f.db.prepare("SELECT count(*) AS n FROM time_entries").get(),
      ).toEqual(committed);
      expect(
        f.db.prepare("SELECT count(*) AS n FROM csv_import_entries").get(),
      ).toEqual(committed);
      expect(await status(f, input.stage.id)).toMatchObject({
        state: "cancelled",
        committed_rows: committed.n,
      });
      expect(
        f.db.prepare("SELECT * FROM csv_import_setup ORDER BY setup_key").all(),
      ).toEqual(setupBefore);
      expect(f.money()).toBe(f.moneyBefore);
    } finally {
      await f.close();
    }
  });
  it("restores authoritative expired-run progress and cancellation before any sweep or runner tick", async () => {
    const f = await fixture();
    try {
      const input = await f.prepare();
      await f.json(
        `/csv-imports/${input.stage.id}/apply`,
        input.command,
        input.command.command_id,
      );
      // Both independent clocks represent an elapsed input deadline; no bytes
      // are revived, and the expiry sweeper has deliberately not run.
      f.setClock(new Date(Date.now() + 25 * 3600000));
      f.db
        .prepare(
          "UPDATE csv_import_runs SET apply_input_expires_at='2000-01-01T00:00:00.000Z' WHERE apply_stage_id=?",
        )
        .run(input.stage.id);
      const expired = await status(f, input.stage.id);
      expect(expired).toMatchObject({
        state: "paused",
        code: "input_expired",
        committed_rows: 0,
      });
      expect(expired.allowed_actions).toContain("cancel");
      expect(expired.allowed_actions).not.toContain("resume");
      const cancellation = { command_id: randomUUID() };
      expect(
        await f.json<CsvApplyRunData>(
          `/csv-imports/${input.stage.id}/cancel`,
          cancellation,
          cancellation.command_id,
        ),
      ).toMatchObject({ state: "cancelled", committed_rows: 0 });
      expect(await f.apply.tick()).toBeNull();
      expect(
        f.db.prepare("SELECT count(*) AS n FROM time_entries").get(),
      ).toEqual({ n: 0 });
      expect(f.money()).toBe(f.moneyBefore);
    } finally {
      await f.close();
    }
  });
  it("waits for an in-flight input read on close, writes no row after shutdown, and resumes the retained queue on recreation", async () => {
    const f = await fixture();
    try {
      const input = await f.prepare();
      await f.json(
        `/csv-imports/${input.stage.id}/apply`,
        input.command,
        input.command.command_id,
      );
      let reached!: () => void, release!: () => void;
      const loading = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.setAfterInput(async () => {
        reached();
        await barrier;
      });
      const tick = f.apply.tick();
      await loading;
      const closing = f.apply.close();
      release();
      await closing;
      await tick;
      expect(
        f.db.prepare("SELECT count(*) AS n FROM time_entries").get(),
      ).toEqual({ n: 0 });
      f.setAfterInput(null);
      await f.recreate();
      expect(await f.apply.tick()).toMatchObject({ state: "complete" });
      expect(
        f.db.prepare("SELECT count(*) AS n FROM time_entries").get(),
      ).toEqual({ n: 2 });
      expect(f.money()).toBe(f.moneyBefore);
    } finally {
      await f.close();
    }
  });
  it("denies anonymous, token, member, cross-origin and cross-owner apply before reading the request body", async () => {
    const f = await fixture();
    try {
      const input = await f.prepare();
      const otherStore = createContainerSessionStore(f.db);
      f.db
        .prepare(
          "INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(8,'Other','Admin','administrator','[]',?,?)",
        )
        .run(new Date().toISOString(), new Date().toISOString());
      const other = await otherStore.issue(8);
      const denied: { headers: Record<string, string>; expected: number }[] = [
        { headers: { cookie: "" }, expected: 401 },
        {
          headers: { cookie: "", authorization: "Bearer " + f.token.token },
          expected: 403,
        },
        {
          headers: { cookie: "__Host-ezacto_session=" + f.member.token },
          expected: 403,
        },
        { headers: { origin: "https://different.invalid" }, expected: 403 },
        {
          headers: { cookie: "__Host-ezacto_session=" + other.token },
          expected: 404,
        },
      ];
      for (const entry of denied) {
        let reads = 0;
        const body = new ReadableStream(
          {
            pull() {
              reads++;
            },
          },
          { highWaterMark: 0 },
        );
        const response = await f.request(
          `/csv-imports/${input.stage.id}/apply`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "idempotency-key": randomUUID(),
              ...entry.headers,
            },
            body,
          },
        );
        expect(response.status).toBe(entry.expected);
        expect(reads).toBe(0);
      }
      expect(
        f.db.prepare("SELECT count(*) AS n FROM time_entries").get(),
      ).toEqual({ n: 0 });
      expect(f.money()).toBe(f.moneyBefore);
    } finally {
      await f.close();
    }
  });
});
