import BetterSqlite3 from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  lstatSync,
  realpathSync,
  mkdtempSync,
  copyFileSync,
  chmodSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { migrateContainer } from "@ezacto/db";
type Row = Record<string, unknown>;
const guardSql = `CREATE TABLE IF NOT EXISTS account_restore_quarantine(id INTEGER PRIMARY KEY CHECK(id=1),quarantined INTEGER NOT NULL CHECK(quarantined IN (0,1)),source_digest TEXT,evidence TEXT,updated_at TEXT NOT NULL) STRICT`;
const now = () => new Date().toISOString();
const columns = (db: BetterSqlite3.Database, table: string) =>
  db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
const records = (
  db: BetterSqlite3.Database,
  table: string,
  where: string,
  bindings: unknown[],
) =>
  db.prepare(`SELECT * FROM ${table} WHERE ${where}`).all(...bindings) as Row[];
const insert = (db: BetterSqlite3.Database, table: string, row: Row) => {
  const names = columns(db, table)
    .map((item) => item.name)
    .filter((name) => name in row);
  db.prepare(
    `INSERT INTO ${table}(${names.join(",")}) VALUES(${names.map(() => "?").join(",")})`,
  ).run(...names.map((name) => row[name]));
};
const sourceState = (source: BetterSqlite3.Database) => {
  const closures = source
    .prepare("SELECT * FROM account_closures ORDER BY request_id")
    .all() as Row[];
  const requests = source
    .prepare("SELECT * FROM account_deletion_requests ORDER BY id")
    .all() as Row[];
  const reviews = source
    .prepare(
      "SELECT * FROM account_retention_obligations ORDER BY request_id,area",
    )
    .all() as Row[];
  const guards = source
    .prepare(
      "SELECT * FROM closed_account_sign_in_guards ORDER BY request_id,digest",
    )
    .all() as Row[];
  const profiles = source
    .prepare(
      "SELECT id,first_name,last_name FROM users WHERE id IN (SELECT user_id FROM account_closures) ORDER BY id",
    )
    .all() as Row[];
  return { closures, requests, reviews, guards, profiles };
};
const digest = (state: ReturnType<typeof sourceState>) =>
  createHash("sha256").update(JSON.stringify(state)).digest("hex");
const sameInstance = (
  target: BetterSqlite3.Database,
  source: BetterSqlite3.Database,
) => {
  const read = (db: BetterSqlite3.Database) =>
    (
      db
        .prepare("SELECT secret FROM account_closure_security WHERE id=1")
        .get() as { secret: string } | undefined
    )?.secret;
  if (!read(target) || read(target) !== read(source))
    throw new Error(
      "Restore requires current privacy evidence from the same instance; pre-closure-era or unrelated snapshots require manual reconciliation.",
    );
};
export function quarantineRestoredDatabase(
  target: BetterSqlite3.Database,
): void {
  target.exec(guardSql);
  target
    .prepare(
      "INSERT INTO account_restore_quarantine(id,quarantined,source_digest,evidence,updated_at) VALUES(1,1,NULL,NULL,?) ON CONFLICT(id) DO UPDATE SET quarantined=1,source_digest=NULL,evidence=NULL,updated_at=excluded.updated_at",
    )
    .run(now());
}
/** Offline only. No HTTP server or restored email/integration worker may run. */
export function replayClosureHistory(
  target: BetterSqlite3.Database,
  source: BetterSqlite3.Database,
): { replayed: number; sourceDigest: string } {
  quarantineRestoredDatabase(target);
  migrateContainer(target);
  sameInstance(target, source);
  const state = sourceState(source),
    sourceDigest = digest(state);
  let replayed = 0;
  target.pragma("foreign_keys=ON");
  target
    .transaction(() => {
      for (const closure of state.closures) {
        const existing = target
          .prepare("SELECT user_id FROM account_closures WHERE request_id=?")
          .get(closure.request_id) as { user_id: number } | undefined;
        if (existing) {
          if (existing.user_id !== closure.user_id)
            throw new Error(
              "Restored closure identity differs from current evidence.",
            );
          continue;
        }
        const policy = source
          .prepare("SELECT * FROM account_retention_policies WHERE version=?")
          .get(closure.policy_version) as Row;
        const prior = target
          .prepare(
            "SELECT policy_json FROM account_retention_policies WHERE version=?",
          )
          .get(closure.policy_version) as { policy_json: string } | undefined;
        if (prior && prior.policy_json !== policy.policy_json)
          throw new Error("Restored policy differs from current evidence.");
        if (!prior) insert(target, "account_retention_policies", policy);
        const request = state.requests.find(
          (row) => row.id === closure.request_id,
        );
        if (!request)
          throw new Error("Current closure request evidence is missing.");
        const old = target
          .prepare("SELECT * FROM account_deletion_requests WHERE id=?")
          .get(closure.request_id) as Row | undefined;
        if (old && old.user_id !== closure.user_id)
          throw new Error(
            "Restored request identity differs from current evidence.",
          );
        if (!old)
          insert(target, "account_deletion_requests", {
            ...request,
            status: "pending",
            version: 1,
            completed_at: null,
            completion_confirmation: null,
            notification: "unavailable",
            notification_delivery_id: null,
          });
        const replayKeys = state.guards
          .filter((row) => row.request_id === closure.request_id)
          .map((row) => ({ digest: row.digest, kind: row.kind }));
        insert(target, "account_closures", {
          ...closure,
          replay_keys: JSON.stringify(replayKeys),
        });
        replayed++;
      }
      for (const profile of state.profiles) {
        if (profile.first_name === "Closed" && profile.last_name === "account")
          target
            .prepare(
              "UPDATE users SET first_name='Closed',last_name='account' WHERE id=?",
            )
            .run(profile.id);
      }
      // The credential guards now refuse late resurrection; inspect exact current
      // evidence too instead of assuming a copied closure row proves erasure.
      for (const closure of state.closures) {
        if (closure.apple_cleanup === "pending")
          target
            .prepare(
              "INSERT INTO apple_deletion_unknown(request_id) VALUES(?) ON CONFLICT DO NOTHING",
            )
            .run(closure.request_id);
        const id = closure.user_id;
        const user = target
          .prepare(
            "SELECT is_active,telephone,employee_id,avatar_url,harvest_id,team_write_token FROM users WHERE id=?",
          )
          .get(id) as Row | undefined;
        if (
          !user ||
          user.is_active !== 0 ||
          Object.entries(user).some(
            ([key, value]) => key !== "is_active" && value !== null,
          )
        )
          throw new Error(
            "Restored profile does not satisfy closure minimization.",
          );
        for (const table of [
          "user_passwords",
          "sessions",
          "api_tokens",
          "staff_magic_links",
          "oidc_app_codes",
          "two_factor_challenges",
          "user_totp_enrolments",
          "user_recovery_codes",
          "user_identities",
          "user_emails",
        ])
          if (records(target, table, "user_id=?", [id]).length)
            throw new Error(
              "Restored sign-in credentials remain; keep this restore quarantined.",
            );
      }
      target
        .prepare(
          "UPDATE account_restore_quarantine SET source_digest=?,updated_at=? WHERE id=1",
        )
        .run(sourceDigest, now());
    })
    .exclusive();
  return { replayed, sourceDigest };
}
export function releasePrivacyQuarantine(
  target: BetterSqlite3.Database,
  source: BetterSqlite3.Database,
  evidence: string,
): void {
  sameInstance(target, source);
  if (
    evidence.trim().length < 20 ||
    evidence.length > 2000 ||
    /[\u0000-\u001f\u007f]/u.test(evidence)
  )
    throw new Error(
      "Supply a concise protected review reference confirming downstream cleanup, attachments, exports and backups were reconciled; do not copy personal records.",
    );
  const expected = digest(sourceState(source));
  const reviewed = target
    .prepare(
      "SELECT source_digest FROM account_restore_quarantine WHERE id=1 AND quarantined=1",
    )
    .get() as { source_digest: string } | undefined;
  if (reviewed?.source_digest !== expected)
    throw new Error(
      "Current privacy evidence changed; replay and review before release.",
    );
  replayClosureHistory(target, source);
  const result = target
    .prepare(
      "UPDATE account_restore_quarantine SET quarantined=0,evidence=?,updated_at=? WHERE id=1 AND quarantined=1 AND source_digest=?",
    )
    .run(evidence.trim(), now(), expected);
  if (result.changes !== 1)
    throw new Error(
      "Current privacy evidence changed or was not replayed. Keep this restore quarantined and replay again.",
    );
}
const open = (path: string, readonly: boolean) => {
  if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path)
    throw new Error(
      "Use a canonical existing database file, never a symbolic link.",
    );
  return new BetterSqlite3(path, { readonly, fileMustExist: true });
};
export function privacyRestoreCommand(args: string[]): void {
  const [action, ...rest] = args,
    values: Record<string, string> = {};
  if (
    !["quarantine", "replay", "release"].includes(action ?? "") ||
    rest.length % 2
  )
    throw new Error(
      "Use quarantine --database PATH; replay --database PATH --current-database PATH; release additionally requires --evidence TEXT.",
    );
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!.replace(/^--/, "");
    if (
      values[key] ||
      !["database", "current-database", "evidence"].includes(key)
    )
      throw new Error("Unknown or duplicate restore option.");
    values[key] = rest[i + 1]!;
  }
  if (!values.database) throw new Error("A restored database is required.");
  const target = open(values.database, false);
  let source: BetterSqlite3.Database | undefined;
  let temporarySource: string | undefined;
  try {
    if (action === "quarantine") {
      quarantineRestoredDatabase(target);
      return;
    }
    if (
      !values["current-database"] ||
      values["current-database"] === values.database
    )
      throw new Error(
        "A separate current protected database snapshot is required.",
      );
    const sourcePath = values["current-database"];
    if (
      lstatSync(sourcePath).isSymbolicLink() ||
      realpathSync(sourcePath) !== sourcePath ||
      existsSync(sourcePath + "-wal")
    )
      throw new Error("Use a protected stopped/checkpointed current snapshot.");
    temporarySource = mkdtempSync(join(tmpdir(), "ezacto-privacy-evidence-"));
    chmodSync(temporarySource, 0o700);
    const copy = join(temporarySource, "evidence.sqlite");
    copyFileSync(sourcePath, copy);
    chmodSync(copy, 0o600);
    source = open(realpathSync(copy), true);
    source.exec("BEGIN");
    if (action === "replay") replayClosureHistory(target, source);
    else releasePrivacyQuarantine(target, source, values.evidence ?? "");
  } finally {
    source?.close();
    target.close();
    if (temporarySource)
      rmSync(temporarySource, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    privacyRestoreCommand(process.argv.slice(2));
    process.stdout.write(
      "Privacy restore operation completed. Verify quarantine status before starting service.\n",
    );
  } catch {
    process.stderr.write(
      "Privacy restore operation failed. Keep the restored instance offline and review its protected evidence.\n",
    );
    process.exitCode = 1;
  }
}
