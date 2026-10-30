import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterEach, expect, it } from "vitest";

const workers: Miniflare[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.dispose()));
});

// Faults execute inside workerd around real runtime construction/migration and
// a real payment service. The outbox and every other service remain unmodified.
const createWorker = async () => {
  const bundled = await build({
    entryPoints: [new URL("../src/index.ts", import.meta.url).pathname],
    bundle: true,
    conditions: ["development"],
    format: "esm",
    platform: "browser",
    external: ["node:async_hooks"],
    target: "es2022",
    write: false,
    plugins: [
      {
        name: "scheduled-runtime-faults",
        setup(builder) {
          builder.onLoad({ filter: /worker\/src\/runtime\.ts$/ }, (args) => {
            let source = readFileSync(args.path, "utf8");
            source = source.replace(
              "  await migrateD1(database);",
              `
          const before = await database.prepare("UPDATE scheduled_test_faults SET attempts=attempts+1 WHERE stage='setup' RETURNING failures,attempts").first();
          if (before && before.attempts <= before.failures) throw new Error('D1_ERROR: Network connection lost');
          await migrateD1(database);
          const after = await database.prepare("UPDATE scheduled_test_faults SET attempts=attempts+1 WHERE stage='after_migration' RETURNING failures,attempts").first();
          if (after && after.attempts <= after.failures) throw new Error('D1_ERROR: Network connection lost');
        `,
            );
            source = source.replace(
              "    paymentRuns,",
              `paymentRuns: { ...paymentRuns, async processDue(now) {
          const fault = await database.prepare("UPDATE scheduled_test_faults SET attempts=attempts+1 WHERE stage='payment' RETURNING failures,attempts").first();
          if (fault && fault.attempts <= fault.failures) throw new Error('D1_ERROR: Network connection lost');
          return paymentRuns.processDue(now);
        } },`,
            );
            return { contents: source, loader: "ts" };
          });
        },
      },
    ],
  });
  const worker = new Miniflare({
    bindings: {
      API_CURSOR_SIGNING_KEY: "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE",
      ENVIRONMENT: "test",
      RELEASE: "scheduled-isolation",
    },
    compatibilityDate: "2026-08-06",
    compatibilityFlags: ["nodejs_als"],
    d1Databases: ["DB"],
    modules: true,
    script: bundled.outputFiles[0]!.text,
    unsafeTriggerHandlers: true,
  });
  workers.push(worker);
  const db = await worker.getD1Database("DB");
  await db
    .prepare(
      "CREATE TABLE scheduled_test_faults(stage TEXT PRIMARY KEY,failures INTEGER,attempts INTEGER DEFAULT 0)",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO scheduled_test_faults(stage,failures) VALUES('setup',0),('after_migration',0),('payment',0)",
    )
    .run();
  return { worker, db };
};
const tick = (worker: Miniflare) =>
  worker.dispatchFetch(
    "https://worker.test/cdn-cgi/handler/scheduled?time=1788350400000&cron=*+*+*+*+*",
  );
const enqueue = async (db: D1Database) => {
  await db
    .prepare(
      `INSERT INTO event_outbox(id,aggregate_type,aggregate_id,aggregate_sequence,event_type,payload_json,occurred_at,available_at)
    VALUES('isolation-event','fixture',91,1,'fixture.committed',?, '2026-01-02T00:00:00Z','2026-01-02T00:00:00Z')`,
    )
    .bind(
      JSON.stringify({ schema_version: 1, event_type: "fixture.committed" }),
    )
    .run();
};

it("[native] retries a transient migration fault", async () => {
  const { worker, db } = await createWorker();
  await db
    .prepare("UPDATE scheduled_test_faults SET failures=1 WHERE stage='setup'")
    .run();
  expect((await tick(worker)).status).toBe(200);
  expect(
    await db
      .prepare("SELECT attempts FROM scheduled_test_faults WHERE stage='setup'")
      .first("attempts"),
  ).toBe(2);
}, 40_000);

it("[native] isolates and never retries an ambiguous payment failure while later jobs drain", async () => {
  const { worker, db } = await createWorker();
  expect((await tick(worker)).status).toBe(200);
  await enqueue(db);
  await db
    .prepare(
      "UPDATE scheduled_test_faults SET failures=100 WHERE stage='payment'",
    )
    .run();
  const before = await db
    .prepare("SELECT attempts FROM scheduled_test_faults WHERE stage='payment'")
    .first<number>("attempts");
  expect((await tick(worker)).status).toBe(200);
  expect(
    await db
      .prepare(
        "SELECT attempts FROM scheduled_test_faults WHERE stage='payment'",
      )
      .first("attempts"),
  ).toBe(before! + 1);
  expect(
    await db
      .prepare(
        "SELECT published_at FROM event_outbox WHERE id='isolation-event'",
      )
      .first("published_at"),
  ).toEqual(expect.any(String));
  // A later real subscriber still runs, not merely a fabricated success flag.
  expect(
    await db
      .prepare(
        "SELECT status FROM outbox_delivery_receipts WHERE event_id='isolation-event' AND subscriber_id='activity_log'",
      )
      .first("status"),
  ).toBe("delivered");
}, 40_000);

it("[native] exhausts setup retries as a failed tick, then recovers after an ambiguously completed migration on the next tick", async () => {
  const { worker, db } = await createWorker();
  await db
    .prepare(
      "UPDATE scheduled_test_faults SET failures=3 WHERE stage='after_migration'",
    )
    .run();
  expect((await tick(worker)).status).toBe(500);
  expect(
    await db
      .prepare(
        "SELECT attempts FROM scheduled_test_faults WHERE stage='after_migration'",
      )
      .first("attempts"),
  ).toBe(3);
  expect(
    await db
      .prepare(
        "SELECT attempts FROM scheduled_test_faults WHERE stage='payment'",
      )
      .first("attempts"),
  ).toBe(0);
  const migrations = await db
    .prepare("SELECT COUNT(*) AS count FROM _ezacto_migrations")
    .first("count");
  await enqueue(db);
  expect((await tick(worker)).status).toBe(200);
  expect(
    await db
      .prepare(
        "SELECT attempts FROM scheduled_test_faults WHERE stage='after_migration'",
      )
      .first("attempts"),
  ).toBe(4);
  expect(
    await db
      .prepare("SELECT COUNT(*) AS count FROM _ezacto_migrations")
      .first("count"),
  ).toBe(migrations);
  expect(
    await db
      .prepare(
        "SELECT published_at FROM event_outbox WHERE id='isolation-event'",
      )
      .first("published_at"),
  ).toEqual(expect.any(String));
}, 40_000);
