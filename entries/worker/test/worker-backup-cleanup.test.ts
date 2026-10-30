import { discardWorkerSnapshot } from "../../../packages/db/src/worker-backup-snapshot.js";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";
import { exportBundle } from "../../../packages/db/src/backup.js";
import { workerBackupCaptureMigration } from "../../../packages/db/src/migrations/0176_worker_backup_capture.js";
import { cleanupAbandonedWorkerBackups } from "../src/nightly-export.js";

it("requeues a late R2 write after privacy cleanup and preserves unrelated backup prefixes", async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    d1Databases: ["DB"],
    r2Buckets: ["BUCKET"],
  });
  try {
    const native = await mf.getD1Database("DB"),
      db = native as unknown as D1Database,
      bucket = (await mf.getR2Bucket("BUCKET")) as unknown as R2Bucket;
    await native.exec(
      "CREATE TABLE account_closures(id INTEGER); CREATE TABLE account_retention_review_events(decision TEXT); CREATE TABLE organizations(id INTEGER); CREATE TABLE users(id INTEGER); CREATE TABLE sample(id INTEGER,value TEXT); CREATE TABLE backup_runs(id INTEGER,status TEXT,r2_prefix TEXT);",
    );
    await native.batch(
      workerBackupCaptureMigration.map((sql) => native.prepare(sql)),
    );
    await native.prepare("INSERT INTO sample VALUES(1,'synthetic')").run();
    const prefix = "backups/2026-10-26/11111111-1111-4111-8111-111111111111/",
      other =
        "backups/2026-10-25/22222222-2222-4222-8222-222222222222/manifest.json";
    await bucket.put(other, "unrelated");
    let delayed = false,
      lateKey = "";
    await expect(
      exportBundle(
        db,
        {
          async put(key, body) {
            if (!delayed && key.includes("rows/sample/")) {
              delayed = true;
              lateKey = key;
              await native
                .prepare("INSERT INTO account_closures VALUES(1)")
                .run();
              await native
                .prepare(
                  "UPDATE worker_backup_cleanup SET available_at='2000-01-01T00:00:00.000Z'",
                )
                .run();
              await cleanupAbandonedWorkerBackups(db, bucket);
              expect(
                await native
                  .prepare("SELECT count(*) AS n FROM worker_backup_cleanup")
                  .first(),
              ).toEqual({ n: 0 });
            }
            await bucket.put(key, body);
          },
        },
        prefix,
      ),
    ).rejects.toThrow(/invalidated/);
    expect(await bucket.get(lateKey)).not.toBeNull();
    expect(
      await native
        .prepare("SELECT count(*) AS n FROM worker_backup_cleanup")
        .first(),
    ).toEqual({ n: 1 });
    await native
      .prepare(
        "UPDATE worker_backup_cleanup SET available_at='2000-01-01T00:00:00.000Z'",
      )
      .run();
    await cleanupAbandonedWorkerBackups(db, bucket);
    expect(await bucket.get(lateKey)).toBeNull();
    expect(await bucket.get(other)).not.toBeNull();
    expect(
      await native
        .prepare("SELECT count(*) AS n FROM worker_backup_rows")
        .first(),
    ).toEqual({ n: 0 });
  } finally {
    await mf.dispose();
  }
}, 60000);

it("keeps a newer cleanup generation when a late writer requeues after an empty listing", async () => {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    d1Databases: ["DB"],
    r2Buckets: ["BUCKET"],
  });
  try {
    const native = await mf.getD1Database("DB"),
      db = native as unknown as D1Database,
      bucket = (await mf.getR2Bucket("BUCKET")) as unknown as R2Bucket;
    await native.exec(
      "CREATE TABLE account_closures(id INTEGER); CREATE TABLE account_retention_review_events(decision TEXT); CREATE TABLE organizations(id INTEGER); CREATE TABLE users(id INTEGER); CREATE TABLE backup_runs(id INTEGER,status TEXT,r2_prefix TEXT);",
    );
    await native.batch(
      workerBackupCaptureMigration.map((sql) => native.prepare(sql)),
    );
    const prefix = "backups/2026-10-26/33333333-3333-4333-8333-333333333333/";
    await native
      .prepare(
        "INSERT INTO worker_backup_cleanup(prefix,available_at) VALUES(?,'2000-01-01T00:00:00.000Z')",
      )
      .bind(prefix)
      .run();
    let raced = false;
    const proxy = new Proxy(bucket, {
      get(target, key) {
        if (key === "list")
          return async (options: R2ListOptions) => {
            const result = await target.list(options);
            if (!raced) {
              raced = true;
              await target.put(prefix + "late", "late");
              await discardWorkerSnapshot(db, "", prefix);
            }
            return result;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await cleanupAbandonedWorkerBackups(db, proxy);
    expect(
      await native
        .prepare("SELECT generation FROM worker_backup_cleanup WHERE prefix=?")
        .bind(prefix)
        .first(),
    ).toEqual({ generation: 1 });
    expect(await bucket.get(prefix + "late")).not.toBeNull();
    await native
      .prepare(
        "UPDATE worker_backup_cleanup SET available_at='2000-01-01T00:00:00.000Z'",
      )
      .run();
    await cleanupAbandonedWorkerBackups(db, bucket);
    expect(await bucket.get(prefix + "late")).toBeNull();
  } finally {
    await mf.dispose();
  }
}, 60000);
