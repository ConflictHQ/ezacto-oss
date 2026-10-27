import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import BetterSqlite3 from "better-sqlite3";
import { Miniflare } from "miniflare";
import { describe, it, expect } from "vitest";
import { workerBackupCaptureMigration } from "../../db/src/migrations/0176_worker_backup_capture.js";
import { createD1SessionStore } from "../../db/src/sessions.js";
import { migrateD1 } from "../../db/src/migrate.js";
import { exportBundle } from "../../db/src/backup.js";
import { restoreBackup } from "../src/backup.js";

const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
describe("actual Worker bundle restore", () => {
  it("reconstructs the current complete migrated schema and migration ledger", async () => {
    const mf = new Miniflare({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: ["DB"],
    });
    const root = await mkdtemp(join(tmpdir(), "worker-schema-"));
    try {
      const database = await mf.getD1Database("DB");
      await migrateD1(database as unknown as D1Database);
      const stamp = new Date().toISOString();
      await database
        .prepare(
          "INSERT INTO organizations(id,name,modules,created_at,updated_at) VALUES(1,'Owned restore fixture','{}',?,?)",
        )
        .bind(stamp, stamp)
        .run();
      await database
        .prepare(
          "INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES(1,'Owned','Operator','administrator','[]',?,?)",
        )
        .bind(stamp, stamp)
        .run();
      const session = await createD1SessionStore(
        database as unknown as D1Database,
      ).issue(1);
      const instance = await database
        .prepare("SELECT nonce FROM calendar_sync_instance WHERE singleton=1")
        .first<{ nonce: string }>();
      await database
        .prepare(
          "INSERT INTO calendar_oauth_attempts(state_hash,requester_hash,user_id,session_id,provider,instance_nonce,expected_generation,expires_at) VALUES(?,?,1,?,'google',?,0,?)",
        )
        .bind(
          "a".repeat(64),
          "b".repeat(64),
          session.session.id,
          instance!.nonce,
          new Date(Date.now() + 600000).toISOString(),
        )
        .run();
      await database
        .prepare(
          "INSERT INTO calendar_connections(user_id,provider,instance_nonce,generation,credential_revision,status,key_id,sealed_grant,updated_at) VALUES(1,'google',?,1,1,'connected','owned-key','owned-encrypted-grant',?)",
        )
        .bind(instance!.nonce, stamp)
        .run();
      await database
        .prepare(
          "INSERT INTO calendar_cleanup_obligations(id,user_id,provider,instance_nonce,generation,credential_revision,key_id,reason,status,created_at,completed_at,sealed_receipt) VALUES('owned-manual',1,'microsoft',?,1,1,'owned-key','disconnect','revoked',?,?,?)",
        )
        .bind(
          instance!.nonce,
          stamp,
          stamp,
          JSON.stringify({ kind: "user_attestation" }),
        )
        .run();
      await database
        .prepare(
          "INSERT INTO calendar_manual_cleanup_receipts(obligation_id,user_id,session_id,provider,instance_nonce,generation,credential_revision,reason,attested_at,assertion) VALUES('owned-manual',1,?,'microsoft',?,1,1,'disconnect',?,'owner_confirmed_provider_permission_removal')",
        )
        .bind(session.session.id, instance!.nonce, stamp)
        .run();

      const store = {
        async put(key: string, body: string) {
          const path = join(root, key);
          await mkdir(join(path, ".."), { recursive: true });
          await writeFile(path, body);
        },
      };
      const manifest = await exportBundle(
        database as unknown as D1Database,
        store,
        "bundle/",
      );
      const target = join(root, "restored.sqlite");
      await restoreBackup({
        bundleDirectory: join(root, "bundle"),
        targetDatabasePath: target,
      });
      const restored = new BetterSqlite3(target);
      try {
        expect(
          (
            restored
              .prepare("SELECT count(*) AS n FROM _ezacto_migrations")
              .get() as { n: number }
          ).n,
        ).toBeGreaterThan(170);
        expect(restored.pragma("foreign_key_check")).toEqual([]);
        expect(
          restored.prepare("SELECT count(*) AS n FROM sessions").get(),
        ).toEqual({ n: 0 });
        expect(
          restored
            .prepare("SELECT count(*) AS n FROM calendar_oauth_attempts")
            .get(),
        ).toEqual({ n: 0 });
        expect(
          restored
            .prepare(
              "SELECT status,sealed_grant,instance_nonce FROM calendar_connections",
            )
            .get(),
        ).toEqual({
          status: "needs_reauth",
          sealed_grant: null,
          instance_nonce: instance!.nonce,
        });
        expect(
          restored.prepare("SELECT nonce FROM calendar_sync_instance").get(),
        ).not.toEqual(instance);
        expect(
          restored
            .prepare(
              "SELECT reason,status,sealed_grant FROM calendar_cleanup_obligations WHERE provider='google'",
            )
            .get(),
        ).toEqual({
          reason: "restore",
          status: "manual_required",
          sealed_grant: "owned-encrypted-grant",
        });
        expect(
          restored
            .prepare("SELECT assertion FROM calendar_manual_cleanup_receipts")
            .get(),
        ).toEqual({ assertion: "owner_confirmed_provider_permission_removal" });

        expect(
          restored
            .prepare("SELECT quarantined FROM account_restore_quarantine")
            .get(),
        ).toEqual({ quarantined: 1 });
        expect(manifest.table_count).toBeGreaterThanOrEqual(250);
        expect(
          restored
            .prepare(
              "SELECT id FROM _ezacto_migrations ORDER BY id DESC LIMIT 1",
            )
            .get(),
        ).toEqual({ id: "0177_calendar_oauth" });
        for (const table of [
          "worker_backup_rows",
          "worker_backup_snapshots",
          "worker_backup_cleanup",
        ])
          expect(
            restored.prepare(`SELECT count(*) AS n FROM ${table}`).get(),
          ).toEqual({ n: 0 });
      } finally {
        restored.close();
      }
    } finally {
      await mf.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
  it("restores generated typed rows and verified R2 bytes with quarantine; rejects legacy/corruption", async () => {
    const mf = new Miniflare({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: ["DB"],
      r2Buckets: ["BUCKET"],
    });
    const root = await mkdtemp(join(tmpdir(), "worker-restore-"));
    try {
      const db = await mf.getD1Database("DB"),
        bucket = await mf.getR2Bucket("BUCKET");
      await db.exec(
        "CREATE TABLE account_closures(id INTEGER); CREATE TABLE account_retention_review_events(decision TEXT); CREATE TABLE organizations(id INTEGER); CREATE TABLE users(id INTEGER); CREATE TABLE backup_runs(id INTEGER PRIMARY KEY,status TEXT,trigger TEXT,started_at TEXT,completed_at TEXT,r2_prefix TEXT,manifest_json TEXT,table_count INTEGER,total_rows INTEGER,error_message TEXT,created_at TEXT,updated_at TEXT);",
      );
      await db.batch(
        workerBackupCaptureMigration.map((sql) => db.prepare(sql)),
      );
      await db.exec(
        `CREATE TABLE sample(id INTEGER PRIMARY KEY AUTOINCREMENT, nullable TEXT, empty TEXT, text_value TEXT, binary BLOB, int_value INTEGER, real_value REAL); CREATE TABLE file_objects(id INTEGER PRIMARY KEY,content_hash TEXT,file_key TEXT,byte_size INTEGER); CREATE TABLE sessions(id TEXT); CREATE TABLE auth_first_run(id TEXT); INSERT INTO auth_first_run VALUES('spent'); CREATE TABLE api_tokens(id TEXT); INSERT INTO api_tokens VALUES('old-token');`,
      );
      await db
        .prepare(
          `INSERT INTO sample(nullable,empty,text_value,binary,int_value,real_value) VALUES(NULL,'',?,X'00FF0100',9223372036854775807,1.2345678901234567)`,
        )
        .bind('hello\u0000"\n世界')
        .run();
      await db.prepare("INSERT INTO sessions VALUES ('old-session')").run();
      const attachment = new Uint8Array([0, 255, 3, 0, 19]),
        contentHash = hash(attachment),
        key = `sha256/${contentHash.slice(0, 2)}/${contentHash}`;
      await bucket.put(key, attachment);
      await db
        .prepare("INSERT INTO file_objects VALUES (1,?,?,?)")
        .bind(contentHash, key, attachment.length)
        .run();
      const bundle = join(root, "bundle");
      await mkdir(bundle);
      const store = {
        async put(key: string, body: string) {
          await bucket.put(key, body);
        },
        async putBytes(key: string, body: Uint8Array) {
          await bucket.put(key, body);
        },
        async get(key: string) {
          const object = await bucket.get(key);
          return object ? new Uint8Array(await object.arrayBuffer()) : null;
        },
      };
      const manifest = await exportBundle(
        db as unknown as D1Database,
        store,
        "bundle/",
      );
      const listing = await bucket.list({ prefix: "bundle/" });
      for (const object of listing.objects) {
        const name = object.key.slice(7);
        await mkdir(join(bundle, name, ".."), { recursive: true });
        await writeFile(
          join(bundle, name),
          new Uint8Array(await (await bucket.get(object.key))!.arrayBuffer()),
        );
      }
      expect(manifest.bundle_version).toBe("0038");
      const target = join(root, "restored.sqlite"),
        attachments = join(root, "restored-attachments");
      const instruction = (await readFile(join(bundle, "RESTORE.md"), "utf8"))
        .split("\n")
        .find((line) => line.startsWith("ez restore "))!;
      const args = instruction
        .split(/\s+/u)
        .slice(1)
        .map((value) =>
          value === "<path-to-this-directory>"
            ? bundle
            : value === "<target.sqlite>"
              ? target
              : value === "<new-attachments-directory>"
                ? attachments
                : value,
        );
      const completed = await promisify(execFile)(
        process.execPath,
        [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), ...args],
        { env: { ...process.env, EZACTO_CONFIG: join(root, "config.json") } },
      );
      expect(completed.stdout).toContain("QUARANTINED");
      const restored = new BetterSqlite3(target);
      restored.defaultSafeIntegers();
      try {
        expect(
          restored
            .prepare(
              "SELECT nullable,empty,text_value,hex(binary) AS binary,int_value,real_value FROM sample",
            )
            .get(),
        ).toEqual({
          nullable: null,
          empty: "",
          text_value: 'hello\u0000"\n世界',
          binary: "00FF0100",
          int_value: 9223372036854775807n,
          real_value: 1.2345678901234567,
        });
        expect(
          restored.prepare("SELECT count(*) AS n FROM sessions").get(),
        ).toEqual({ n: 0n });
        expect(
          restored.prepare("SELECT count(*) AS n FROM auth_first_run").get(),
        ).toEqual({ n: 0n });
        expect(
          restored.prepare("SELECT count(*) AS n FROM api_tokens").get(),
        ).toEqual({ n: 0n });
        expect(
          restored
            .prepare("SELECT quarantined FROM account_restore_quarantine")
            .get(),
        ).toEqual({ quarantined: 1n });
        expect(
          restored
            .prepare("SELECT seq FROM sqlite_sequence WHERE name=?")
            .get("sample"),
        ).toEqual({ seq: 1n });
      } finally {
        restored.close();
      }
      expect(new Uint8Array(await readFile(join(attachments, key)))).toEqual(
        attachment,
      );
      await expect(
        restoreBackup({
          bundleDirectory: bundle,
          targetDatabasePath: target,
          targetAttachmentDirectory: join(root, "other"),
        }),
      ).rejects.toThrow();
      const chunk = "rows/sample/000000.json";
      await writeFile(join(bundle, chunk), "[]");
      await expect(
        restoreBackup({
          bundleDirectory: bundle,
          targetDatabasePath: join(root, "corrupt.sqlite"),
        }),
      ).rejects.toThrow(/checksum/);
      await writeFile(
        join(bundle, "manifest.json"),
        JSON.stringify({ bundle_version: "0037" }),
      );
      await expect(
        restoreBackup({
          bundleDirectory: bundle,
          targetDatabasePath: join(root, "legacy.sqlite"),
        }),
      ).rejects.toThrow(/Legacy/);
    } finally {
      await mf.dispose();
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});
