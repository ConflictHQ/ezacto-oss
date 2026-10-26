import {
  WORKER_BACKUP_CLEAR_TABLES,
  workerBackupFiles,
  type WorkerBackupFileReceipt,
} from "@ezacto/core";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import BetterSqlite3 from "better-sqlite3";
import type {
  BackupManifest,
  RestoreOptions,
  RestoreResult,
} from "./backup.js";

type FileReceipt = WorkerBackupFileReceipt;

interface Schema {
  format: string;
  objects: Array<{ type: string; name: string; tbl_name: string; sql: string }>;
  tables: Array<{
    name: string;
    columns: string[];
    chunks: string[];
    row_count: number;
  }>;
  sequences: Array<{ name: string; seq: string }>;
  attachments: Array<{
    file_key: string;
    path: string;
    sha256: string;
    byte_size: number;
  }>;
}
const safeName = /^[A-Za-z0-9_]+$/u;
const fileName =
  /^(?:schema\.json|rows\/[A-Za-z0-9_]+\/[0-9]{6}\.json|attachments\/sha256\/([0-9a-f]{2})\/[0-9a-f]{64})$/u;
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const maxFile = 16 * 1024 * 1024;
const checkedRead = async (root: string, name: string) => {
  if (!fileName.test(name))
    throw new Error("Worker backup contains an unsafe object path.");
  let path = root;
  for (const part of name.split("/")) {
    path = join(path, part);
    if ((await lstat(path)).isSymbolicLink())
      throw new Error("Worker backup must not contain symbolic links.");
  }
  const info = await lstat(path);
  if (!info.isFile() || info.size > maxFile)
    throw new Error("Worker backup object is invalid or exceeds 16 MiB.");
  return readFile(path);
};
const decode = (cell: unknown): null | string | Buffer | bigint | number => {
  if (!Array.isArray(cell) || cell.length !== 2)
    throw new Error("Invalid typed Worker backup cell.");
  const [kind, raw] = cell;
  if (kind === "null" && raw === null) return null;
  if (typeof raw !== "string")
    throw new Error("Invalid typed Worker backup value.");
  if ((kind === "text" || kind === "blob") && /^(?:[0-9A-F]{2})*$/u.test(raw)) {
    const bytes = Buffer.from(raw, "hex");
    return kind === "blob"
      ? bytes
      : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  }
  if (kind === "integer" && /^-?(?:0|[1-9][0-9]*)$/u.test(raw)) {
    const number = BigInt(raw);
    if (number >= -(1n << 63n) && number < 1n << 63n) return number;
  }
  if (
    kind === "real" &&
    /^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/iu.test(raw) &&
    Number.isFinite(Number(raw))
  )
    return Number(raw);
  throw new Error("Unsupported typed Worker backup value.");
};

/** A lossless Worker snapshot becomes a quarantined local DB, never a running service. */
export async function restoreWorkerBackup(
  options: RestoreOptions,
  manifest: {
    bundle_version?: string;
    files?: Record<string, FileReceipt>;
    exported_at?: string;
    restore_skips?: string[];
  },
  restoreContainer: (options: RestoreOptions) => Promise<RestoreResult>,
): Promise<RestoreResult> {
  if (manifest.bundle_version !== "0038" || !manifest.files?.["schema.json"])
    throw new Error(
      "Legacy Worker CSV backups cannot be restored losslessly. This command requires Worker bundle 0038 or a Container bundle.",
    );
  const root = resolve(options.bundleDirectory),
    target = resolve(options.targetDatabasePath);
  if ((await lstat(root)).isSymbolicLink())
    throw new Error("Worker backup source must not be a symbolic link.");
  workerBackupFiles(manifest.files);
  const files = manifest.files;
  const verified = new Map<string, Buffer>();
  if (Object.keys(files).length > 65530)
    throw new Error("Worker backup contains too many files.");
  for (const [name, receipt] of Object.entries(files)) {
    if (
      !receipt ||
      !/^[0-9a-f]{64}$/u.test(receipt.sha256) ||
      !Number.isSafeInteger(receipt.byte_size) ||
      receipt.byte_size < 0
    )
      throw new Error("Worker backup has an invalid receipt.");
    const bytes = await checkedRead(root, name);
    if (bytes.length !== receipt.byte_size || sha(bytes) !== receipt.sha256)
      throw new Error("Worker backup checksum or length mismatch.");
    // Row chunks are read again during import; retain only the small schema.
    if (name === "schema.json") verified.set(name, bytes);
  }
  const schema = JSON.parse(
    new TextDecoder().decode(verified.get("schema.json")!),
  ) as Schema;
  if (
    schema.format !== "ezacto-worker-snapshot-1" ||
    !Array.isArray(schema.objects) ||
    !Array.isArray(schema.tables) ||
    !Array.isArray(schema.sequences) ||
    !Array.isArray(schema.attachments)
  )
    throw new Error("Unsupported Worker snapshot schema.");
  const expected = new Set(["schema.json"]);
  const tableNames = new Set<string>();
  for (const table of schema.tables) {
    if (
      !safeName.test(table.name) ||
      tableNames.has(table.name) ||
      !Array.isArray(table.columns) ||
      !table.columns.length ||
      new Set(table.columns).size !== table.columns.length ||
      table.columns.some((c) => !safeName.test(c)) ||
      !Number.isSafeInteger(table.row_count) ||
      table.row_count < 0 ||
      !Array.isArray(table.chunks)
    )
      throw new Error("Invalid Worker snapshot table.");
    tableNames.add(table.name);
    for (const [i, name] of table.chunks.entries()) {
      if (
        name !== `rows/${table.name}/${String(i).padStart(6, "0")}.json` ||
        !files[name]
      )
        throw new Error("Invalid Worker snapshot row chunk.");
      expected.add(name);
    }
  }
  for (const attachment of schema.attachments) {
    if (
      !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+$/u.test(attachment.file_key) ||
      attachment.file_key.split("/").some((p) => p === "." || p === "..") ||
      attachment.path !==
        `attachments/sha256/${attachment.sha256.slice(0, 2)}/${attachment.sha256}` ||
      files[attachment.path]?.sha256 !== attachment.sha256 ||
      files[attachment.path]?.byte_size !== attachment.byte_size
    )
      throw new Error("Invalid Worker attachment mapping.");
    expected.add(attachment.path);
  }
  if (expected.size !== Object.keys(files).length)
    throw new Error("Worker manifest contains undeclared snapshot objects.");
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(dirname(target), ".ezacto-restore-"));
  let attachmentDirectoryOwned = false;
  try {
    const constructed = join(temporary, "db.sqlite");
    const database = new BetterSqlite3(constructed);
    try {
      database.pragma("foreign_keys = OFF");
      database.pragma("trusted_schema = OFF");
      for (const object of schema.objects) {
        if (
          !["table", "index", "trigger", "view"].includes(object.type) ||
          !safeName.test(object.name) ||
          !safeName.test(object.tbl_name) ||
          typeof object.sql !== "string" ||
          !new RegExp(`^CREATE\\s+(?:UNIQUE\\s+)?${object.type}\\s`, "iu").test(
            object.sql,
          )
        )
          throw new Error("Invalid Worker snapshot schema statement.");
        if (object.type === "table") database.prepare(object.sql).run();
      }
      if (
        schema.objects.filter((o) => o.type === "table").length !==
        tableNames.size
      )
        throw new Error("Worker snapshot schema/table mismatch.");
      for (const table of schema.tables) {
        const insert = database.prepare(
          `INSERT INTO ${quote(table.name)} (${table.columns.map(quote).join(",")}) VALUES (${table.columns.map(() => "?").join(",")})`,
        );
        let count = 0;
        for (const name of table.chunks) {
          const bytes = await checkedRead(root, name);
          if (sha(bytes) !== files[name]!.sha256)
            throw new Error("Worker backup changed during restore.");
          const rows: unknown = JSON.parse(new TextDecoder().decode(bytes));
          if (!Array.isArray(rows))
            throw new Error("Invalid Worker snapshot rows.");
          database
            .transaction(() => {
              for (const row of rows) {
                if (!Array.isArray(row) || row.length !== table.columns.length)
                  throw new Error("Invalid Worker snapshot row width.");
                insert.run(...row.map(decode));
                count++;
              }
            })
            .immediate();
        }
        if (count !== table.row_count)
          throw new Error("Worker snapshot row count mismatch.");
      }
      const attachmentMappings = new Map(schema.attachments.map(item => [item.file_key,item]))
      if (attachmentMappings.size !== schema.attachments.length) throw new Error('Duplicate Worker attachment mapping.')
      const referencedKeys = new Set<string>()
      for (const table of ['file_objects','brand_assets']) if (tableNames.has(table)) {
        const referenced = database.prepare(`SELECT file_key,content_hash,byte_size FROM ${quote(table)}`).all() as Array<{file_key:string;content_hash:string;byte_size:number}>
        for (const item of referenced) {
          const mapped=attachmentMappings.get(item.file_key)
          if (!mapped || mapped.sha256!==item.content_hash || mapped.byte_size!==item.byte_size) throw new Error('Worker attachment inventory differs from database references.')
          referencedKeys.add(item.file_key)
        }
      }
      if (referencedKeys.size!==attachmentMappings.size) throw new Error('Worker attachment inventory includes an unreferenced object.')
      // Stateful credentials are evidence in the bundle, never reusable restored sessions.
      for (const table of WORKER_BACKUP_CLEAR_TABLES)
        if (tableNames.has(table))
          database.prepare(`DELETE FROM ${quote(table)}`).run();
      if (
        database
          .prepare("SELECT 1 FROM sqlite_schema WHERE name='sqlite_sequence'")
          .get()
      ) {
        database.prepare("DELETE FROM sqlite_sequence").run();
        const sequence = database.prepare(
          "INSERT INTO sqlite_sequence(name,seq) VALUES (?,?)",
        );
        for (const value of schema.sequences)
          if (tableNames.has(value.name) && /^\d+$/u.test(value.seq))
            sequence.run(value.name, BigInt(value.seq));
      }
      for (const object of schema.objects)
        if (object.type !== "table") database.prepare(object.sql).run();
      database.pragma("foreign_keys = ON");
      if (
        (database.pragma("foreign_key_check") as unknown[]).length ||
        JSON.stringify(database.pragma("integrity_check")) !==
          '[{"integrity_check":"ok"}]'
      )
        throw new Error(
          "Worker snapshot integrity or foreign-key check failed.",
        );
      database.exec(
        "CREATE TABLE IF NOT EXISTS account_restore_quarantine(id INTEGER PRIMARY KEY CHECK(id=1),quarantined INTEGER NOT NULL CHECK(quarantined IN (0,1)),source_digest TEXT,evidence TEXT,updated_at TEXT NOT NULL) STRICT",
      );
      database
        .prepare(
          "INSERT INTO account_restore_quarantine VALUES(1,1,NULL,NULL,?) ON CONFLICT(id) DO UPDATE SET quarantined=1,source_digest=NULL,evidence=NULL,updated_at=excluded.updated_at",
        )
        .run(options.restoredAt ?? new Date().toISOString());
      const tables = schema.tables.map((table) => ({
        name: table.name,
        columns: table.columns,
        csv_sha256: "",
        row_count: (
          database
            .prepare(`SELECT count(*) AS n FROM ${quote(table.name)}`)
            .get() as { n: number }
        ).n,
      }));
      const physical: BackupManifest = {
        format_version: 1,
        created_at: manifest.exported_at ?? "",
        database_sha256: "",
        tables,
        attachments: [],
      };
      database.close();
      await chmod(constructed, 0o600);
      physical.database_sha256 = sha(await readFile(constructed));
      for (const attachment of schema.attachments) {
        const name = "attachments/" + attachment.file_key;
        const path = join(temporary, name);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await copyFile(
          join(root, attachment.path),
          path,
          constants.COPYFILE_EXCL,
        );
        if (sha(await readFile(path)) !== attachment.sha256)
          throw new Error("Worker attachment changed during restore.");
        physical.attachments.push({
          path: name,
          sha256: attachment.sha256,
          byte_size: attachment.byte_size,
        });
      }
      await writeFile(
        join(temporary, "manifest.json"),
        JSON.stringify(physical),
        { mode: 0o600 },
      );
    } finally {
      if (database.open) database.close();
    }
    const finalized = join(temporary, "final.sqlite"),
      attachments = join(temporary, "final-attachments");
    const result = await restoreContainer({
      ...options,
      bundleDirectory: temporary,
      targetDatabasePath: finalized,
      targetAttachmentDirectory: attachments,
    });
    if (
      schema.attachments.length &&
      options.targetAttachmentDirectory === undefined
    )
      throw new Error(
        "Choose a new attachment directory to restore this Worker bundle.",
      );
    if (options.targetAttachmentDirectory !== undefined) {
      await mkdir(options.targetAttachmentDirectory, { mode: 0o700 });
      attachmentDirectoryOwned = true;
      for (const item of schema.attachments) {
        const dest = join(options.targetAttachmentDirectory, item.file_key);
        await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
        await copyFile(
          join(attachments, item.file_key),
          dest,
          constants.COPYFILE_EXCL,
        );
        await chmod(dest, 0o600);
      }
    }
    await chmod(finalized, 0o600);
    await link(finalized, target); // Atomic no-overwrite publication; quarantine already durable.
    return { ...result, quarantined: true };
  } catch (error) {
    if (attachmentDirectoryOwned)
      await rm(options.targetAttachmentDirectory!, {
        recursive: true,
        force: true,
      });
    throw error;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
