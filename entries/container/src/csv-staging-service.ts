import BetterSqlite3 from "better-sqlite3";
import {
  createHash,
  randomUUID,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { join } from "node:path";
import { chmod, lstat } from "node:fs/promises";
import {
  csvStagingSessionFence,
  registerCsvImportSqliteFunctions,
  csvImportDestinationFence,
} from "@ezacto/db";
import {
  CsvBrowserLedgerRefusal,
  csvPlanId,
  type CsvStagingAuthority,
} from "@ezacto/core";
import {
  CsvStagingError,
  CSV_RAW_RETENTION_MS,
  type CsvImportStagingPort,
  type CsvStagingRunData,
  type CsvStagingChoices,
  type CsvStagingTallies,
  type CsvStagingDiagnostic,
  type CsvStagingSourceEntity,
  type CsvStagingCandidate,
  type CsvStagingPage,
} from "@ezacto/api";
import { csvBrowserSealInput } from "../../../packages/migrate/src/csv-planner.js";
import { createSqliteCsvBrowserService } from "../../../packages/migrate/src/csv-browser-sqlite.js";
import {
  parseBrowserMapping,
  csvSourceEntityKeys,
} from "../../../packages/migrate/src/csv-browser-mapping.js";
import { assertCsvExporterZone } from "../../../packages/migrate/src/csv-browser-errors.js";
import { CLOCKIFY_ADAPTERS } from "../../../packages/migrate/src/csv-clockify.js";
import type {
  CsvBrowserPlan,
  CsvBrowserDestinationSnapshot,
} from "../../../packages/migrate/src/csv-planner.js";
import type {
  CsvIssue,
  CsvRow,
} from "../../../packages/migrate/src/csv-contract.js";
import type {
  CsvStagingApplyPort,
  CsvStagingApplyBinding,
} from "../../../packages/migrate/src/csv-staging-private.js";
import { createCsvStagingDisk } from "./csv-staging-disk.js";
import { runCsvStagingWork } from "./csv-staging-work.js";

const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const sha = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
function fail(code: ConstructorParameters<typeof CsvStagingError>[0]): never {
  throw new CsvStagingError(code);
}
interface Stage {
  id: string;
  target: string;
  owner: number;
  version: number;
  status: CsvStagingRunData["status"];
  sha: string;
  bytes: number;
  object_key: string | null;
  created_at: string;
  expires_at: string;
  retention_deadline: string | null;
  choices: string | null;
  source_id: string | null;
  preview_id: string | null;
  summary: string | null;
  confirmed_preview_id: string | null;
  request_json: string | null;
  cancellation_command_id: string | null;
  cancellation_request_json: string | null;
  command_id: string | null;
  native_run_id: number | null;
  lease_generation: number | null;
}
interface SavedPreview {
  id: string;
  stage_id: string;
  stage_version: number;
  binding: string;
  private_json: string;
  tallies: string;
  diagnostics: string;
  catalog: string;
}
interface WorkResult {
  organizationName: string;
  sourceRows: CsvRow[];
  projectCurrencies: { id: number; billing_currency: string | null }[];
  plan: CsvBrowserPlan;
  snapshot: CsvBrowserDestinationSnapshot;
  people: {
    id: number;
    first_name: string;
    last_name: string;
    is_active: number;
  }[];
}
const messages: Record<string, string> = {
  invalid_utf8: "Use a UTF-8 CSV file.",
  clockify_money_ignored:
    "Source rates and amounts are ignored; destination rates apply.",
  clockify_attachment_ignored: "Source attachments are not imported.",
  clockify_column_ignored: "An extra source column is ignored.",
  unknown_column: "An extra source column is ignored.",
  billable_not_applied:
    "The destination assignment billable setting takes precedence over the source value.",
  currency_differs:
    "Source currency differs; destination rates and currency apply.",
  rate_not_applied: "Source rates are ignored; destination rates apply.",
  clockify_dst_gap:
    "Timing falls in a daylight-saving gap; duration is retained without clock times.",
  clockify_dst_repeated_hour:
    "Timing falls in a repeated daylight-saving hour; duration is retained without clock times.",
  clockify_duration_differs_from_clock:
    "Source duration differs from wall-clock timing; duration is retained.",
  clockify_timing_dropped:
    "Source clock timing is omitted; duration is retained.",
  missing_column: "A required column is missing.",
  duplicate_column: "A source column is repeated.",
  too_many_rows: "The file exceeds the row limit.",
  too_many_columns: "The file exceeds the column limit.",
  field_too_long: "A field exceeds the length limit.",
  name_too_long: "A name exceeds the length limit.",
  invalid_date: "The date is invalid.",
  invalid_duration: "The duration is invalid.",
  notes_required: "The destination requires a longer time entry note.",
  time_locked: "This date is locked.",
};
const diagnostic = (
  issue: CsvIssue,
  scope: "file" | "row",
  kind: "invalid" | "unsupported" | "warning",
): CsvStagingDiagnostic => ({
  line: Number.isSafeInteger(issue.line) && issue.line > 0 ? issue.line : 0,
  scope,
  excludable: scope === "row",
  kind,
  code: /^[a-z][a-z0-9_]{0,63}$/.test(issue.code) ? issue.code : "invalid_row",
  message:
    messages[issue.code] ??
    (scope === "file"
      ? "The CSV file is not supported."
      : "This row cannot be imported with the current choices."),
});
const tallies = (p: CsvBrowserPlan): CsvStagingTallies => ({
  file_rows: p.fileRows,
  selected_rows: p.selectedRows,
  new_rows: p.plan.report.entries.new,
  already_imported_rows: p.plan.report.entries.alreadyImported,
  rejected_row_count: p.rejectedRows,
  diagnostic_count:
    p.diagnosticCount +
    p.plan.report.fileErrors.length +
    p.plan.report.warnings.length,
  file_error_count: p.plan.report.fileErrors.length,
  invalid_rows: new Set(
    p.plan.report.rejected
      .filter((x) => x.category === "invalid")
      .map((x) => x.line),
  ).size,
  unsupported_rows: new Set(
    p.plan.report.rejected
      .filter((x) => x.category === "unsupported")
      .map((x) => x.line),
  ).size,
  source_seconds: p.sourceSeconds,
  destination_seconds: p.destinationSeconds,
  destination_delta_seconds: p.destinationDeltaSeconds,
  deleted_imported_rows: p.deletedImportedRows,
  organization_currency: p.organizationCurrency,
  unpriced: true,
  ignored_columns: [
    ...new Set(
      p.plan.report.warnings
        .filter((x) =>
          /^(clockify_(money|attachment|column)_ignored|unknown_column)$/.test(
            x.code,
          ),
        )
        .map((x) => x.code),
    ),
  ],
  ignored_column_count: p.plan.report.warnings.filter(
    (x) => x.code === "unknown_column",
  ).length,
  warning_count: p.plan.report.warnings.length,
  people: p.plan.report.people,
  clients: p.plan.report.clients,
  projects: p.plan.report.projects,
  tasks: p.plan.report.tasks,
  assignments: {
    user_project: p.plan.report.assignments.userProject,
    project_task: p.plan.report.assignments.projectTask,
  },
});

const canonicalClaimRequest = (source: string | undefined): string | null => {
  if (source === undefined) return null;
  if (new TextEncoder().encode(source).byteLength > 2048)
    fail("mapping_invalid");
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(source) as Record<string, unknown>;
  } catch {
    fail("mapping_invalid");
  }
  const keys = [
    "preview_id",
    "command_id",
    "version",
    "expected_selected_rows",
    "expected_source_seconds",
    "expected_destination_seconds",
    "acknowledge_exclusions",
    "acknowledge_destination_difference",
    "acknowledge_new_people",
  ];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    fail("mapping_invalid");
  if (
    typeof value.preview_id !== "string" ||
    !/^preview_[a-f0-9]{64}$/.test(value.preview_id) ||
    typeof value.command_id !== "string" ||
    !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.command_id)
  )
    fail("mapping_invalid");
  for (const k of [
    "version",
    "expected_selected_rows",
    "expected_source_seconds",
    "expected_destination_seconds",
  ])
    if (
      typeof value[k] !== "number" ||
      !Number.isSafeInteger(value[k]) ||
      value[k] < 0
    )
      fail("mapping_invalid");
  if (
    (value.version as number) < 1 ||
    (value.expected_selected_rows as number) > 50000 ||
    (value.expected_source_seconds as number) > 4320000000
  )
    fail("mapping_invalid");
  for (const k of keys.filter((k) => k.startsWith("acknowledge_")))
    if (typeof value[k] !== "boolean") fail("mapping_invalid");
  return JSON.stringify(Object.fromEntries(keys.map((k) => [k, value[k]])));
};

/** Entry-owned private storage. No raw bytes or paths are returned to an API caller. */
export const createCsvImportStaging = async (options: {
  database: BetterSqlite3.Database;
  databasePath: string;
  directory: string;
  now?: () => Date;
  work?: typeof runCsvStagingWork;
  verifyApplyBinding?: (binding: CsvStagingApplyBinding) => boolean;
}) => {
  const now = options.now ?? (() => new Date()),
    main = options.database;
  const disk = await createCsvStagingDisk(join(options.directory, "objects"));
  const metadataPath = join(options.directory, "metadata.sqlite");
  try {
    const stat = await lstat(metadataPath);
    if (stat.isSymbolicLink() || !stat.isFile())
      throw new Error("CSV metadata is not a regular private file");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw error;
  }
  const sidecar = new BetterSqlite3(metadataPath);
  try {
    await chmod(join(options.directory, "metadata.sqlite"), 0o600);
    sidecar.pragma("journal_mode=DELETE");
    sidecar.pragma("secure_delete=ON");
    sidecar.exec(`CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS stages(id TEXT PRIMARY KEY,target TEXT NOT NULL,owner INTEGER NOT NULL,version INTEGER NOT NULL,
    status TEXT NOT NULL,sha TEXT NOT NULL,bytes INTEGER NOT NULL,object_key TEXT,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,
    retention_deadline TEXT,choices TEXT,source_id TEXT,preview_id TEXT,summary TEXT,confirmed_preview_id TEXT,request_json TEXT,cancellation_command_id TEXT,cancellation_request_json TEXT,command_id TEXT,native_run_id INTEGER,lease_generation INTEGER);
    CREATE TABLE IF NOT EXISTS previews(id TEXT PRIMARY KEY,stage_id TEXT NOT NULL,stage_version INTEGER NOT NULL,binding TEXT NOT NULL,
    private_json TEXT NOT NULL,tallies TEXT NOT NULL,diagnostics TEXT NOT NULL,catalog TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS stages_owner ON stages(target,owner,created_at);`);
    sidecar
      .prepare("INSERT OR IGNORE INTO settings VALUES('cursor_secret',?)")
      .run(sha(randomUUID()));
    const cursorSecret = (
      sidecar
        .prepare("SELECT value FROM settings WHERE key='cursor_secret'")
        .get() as { value: string }
    ).value;
    let working = false;
    const work = async <T>(input: unknown, signal: AbortSignal): Promise<T> => {
      if (working) fail("run_busy");
      working = true;
      try {
        return await (options.work ?? runCsvStagingWork)<T>(input, signal);
      } finally {
        working = false;
      }
    };
    registerCsvImportSqliteFunctions(main);
    const target = () => {
      const row = main
        .prepare("SELECT nonce FROM csv_staging_instance WHERE singleton=1")
        .get() as { nonce: string } | undefined;
      if (!row || !/^[a-f0-9]{64}$/.test(row.nonce))
        fail("storage_unavailable");
      return row.nonce;
    };
    const authorize = (a: CsvStagingAuthority, nonce: string | null = null) => {
      const guard = csvStagingSessionFence(a, nonce);
      const result = main
        .prepare(`SELECT (${guard.sql}) AS allowed`)
        .get(...guard.params) as { allowed: number };
      if (result.allowed !== 1) fail("administrator_required");
    };
    const owned = (a: CsvStagingAuthority, runId: string): Stage => {
      authorize(a);
      if (!/^csv_[a-f0-9]{32}$/.test(runId)) fail("run_not_found");
      const row = sidecar
        .prepare("SELECT * FROM stages WHERE id=? AND owner=? AND target=?")
        .get(runId, a.userId, target()) as Stage | undefined;
      if (!row) fail("run_not_found");
      return row;
    };
    const inputAllowed = (row: Stage) => {
      if (
        !row.object_key ||
        row.status === "purged" ||
        Date.parse(row.expires_at) <= now().getTime()
      )
        fail("preview_stale");
    };
    const cas = (row: Stage, sql: string, params: readonly unknown[]) => {
      const result = sidecar
        .prepare(
          `UPDATE stages SET ${sql},version=version+1 WHERE id=? AND version=?`,
        )
        .run(...params, row.id, row.version);
      if (result.changes !== 1) fail("preview_stale");
    };
    const current = (a: CsvStagingAuthority, row: Stage): Stage => {
      const latest = owned(a, row.id);
      if (latest.version !== row.version) fail("preview_stale");
      return latest;
    };
    const saved = (row: Stage, previewId?: string): SavedPreview => {
      if (!row.preview_id || (previewId && previewId !== row.preview_id))
        fail("preview_stale");
      const preview = sidecar
        .prepare("SELECT * FROM previews WHERE id=? AND stage_id=?")
        .get(row.preview_id, row.id) as SavedPreview | undefined;
      if (!preview) fail("preview_stale");
      return preview;
    };
    const previewCurrent = (row: Stage): boolean => {
      if (!row.preview_id) return true;
      const original = JSON.parse(saved(row).private_json) as WorkResult;
      const predicate = csvImportDestinationFence(
        csvBrowserSealInput(original.plan),
      );
      const matches = main
        .prepare(`SELECT (${predicate.sql}) AS allowed`)
        .get(...predicate.params) as { allowed: number };
      if (matches.allowed !== 1) return false;
      if (row.status === "previewed") {
        const entries = main
          .prepare(
            "SELECT i.source_key AS sourceKey,t.rounded_seconds AS roundedSeconds FROM csv_import_entries i LEFT JOIN time_entries t ON t.id=i.time_entry_id WHERE i.source_id=? ORDER BY i.source_key",
          )
          .all(row.source_id);
        if (
          JSON.stringify(entries) !==
          JSON.stringify(original.snapshot.importedEntries)
        )
          return false;
      }
      return true;
    };
    const representation = (row: Stage): CsvStagingRunData => ({
      id: row.id,
      status: row.status,
      version: row.version,
      file_sha256: row.sha,
      bytes: row.bytes,
      staging_expires_at: row.expires_at,
      retention_deadline: row.retention_deadline,
      purge_allowed: row.status !== "confirmed" && row.status !== "purged",
      allowed_actions:
        row.status === "confirmed" || row.status === "purged"
          ? []
          : Date.parse(row.expires_at) <= now().getTime()
            ? ["purge"]
            : ["map", "preview", "purge"],
      retryable: row.status === "staged" || row.status === "previewed",
      preview_id: row.preview_id,
      preview_stale:
        Date.parse(row.expires_at) <= now().getTime() || !previewCurrent(row),
      source_id: row.source_id,
      tallies: row.summary
        ? (JSON.parse(row.summary) as CsvStagingTallies)
        : null,
    });
    const readBytes = async (row: Stage) => {
      inputAllowed(row);
      const bytes = await disk.read(row.object_key!);
      if (!bytes || bytes.byteLength !== row.bytes || sha(bytes) !== row.sha)
        fail("hash_mismatch");
      return bytes;
    };
    const calculate = async (
      a: CsvStagingAuthority,
      row: Stage,
      signal: AbortSignal,
    ) => {
      const choices = JSON.parse(
        row.choices ?? "null",
      ) as CsvStagingChoices | null;
      if (!choices || !row.source_id) fail("source_choice_required");
      const bytes = await readBytes(row);
      current(a, row);
      const result = await work<WorkResult>(
        {
          kind: "preview",
          bytes,
          databasePath: options.databasePath,
          target: row.target,
          actor: { kind: "administrator", userId: String(a.userId) },
          sourceId: row.source_id,
          mappingJson: JSON.stringify(choices.mapping),
          zone: choices.exporter_zone,
          excludedLines: choices.excluded_lines,
          now: now().toISOString(),
        },
        signal,
      );
      current(a, row);
      return { result, bytes, choices };
    };
    const signature = (value: string) =>
      createHmac("sha256", cursorSecret).update(value).digest("hex");
    const page = <T>(
      items: readonly T[],
      preview: SavedPreview,
      scope: string,
      limit: number,
      cursor?: string,
    ): CsvStagingPage<T> => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        fail("mapping_invalid");
      let offset = 0;
      if (cursor) {
        if (cursor.length > 2048) fail("preview_stale");
        const [raw, mac] = cursor.split(".");
        if (
          !raw ||
          !mac ||
          !/^[a-f0-9]{64}$/.test(mac) ||
          !timingSafeEqual(Buffer.from(signature(raw)), Buffer.from(mac))
        )
          fail("preview_stale");
        try {
          const value = JSON.parse(
            Buffer.from(raw, "base64url").toString(),
          ) as {
            preview: string;
            scope: string;
            limit: number;
            offset: number;
          };
          if (
            value.preview !== preview.id ||
            value.scope !== scope ||
            value.limit !== limit ||
            !Number.isSafeInteger(value.offset) ||
            value.offset < 0
          )
            fail("preview_stale");
          offset = value.offset;
        } catch {
          fail("preview_stale");
        }
      }
      const next =
        offset + limit < items.length
          ? Buffer.from(
              JSON.stringify({
                preview: preview.id,
                scope,
                limit,
                offset: offset + limit,
              }),
            ).toString("base64url")
          : null;
      return {
        items: items.slice(offset, offset + limit),
        total: items.length,
        next_cursor: next ? `${next}.${signature(next)}` : null,
        preview_id: preview.id,
      };
    };
    const buildCatalog = (r: WorkResult, choices: CsvStagingChoices) => {
      const source = new Map<string, CsvStagingSourceEntity>();
      const selectedByLine = new Map(
        r.plan.plan.items.map((item) => [item.row.line, item]),
      );
      const sourceRows = [...r.sourceRows].sort(
        (a, b) =>
          Number(!selectedByLine.has(a.line)) -
          Number(!selectedByLine.has(b.line)),
      );
      for (const row of sourceRows) {
        const selected = selectedByLine.get(row.line);
        const keys = csvSourceEntityKeys(row);
        for (const kind of [
          "people",
          "clients",
          "projects",
          "tasks",
        ] as const) {
          const entity =
            selected?.[
              kind === "people"
                ? "person"
                : kind === "clients"
                  ? "client"
                  : kind === "projects"
                    ? "project"
                    : "task"
            ];
          const key = keys[kind];
          if (source.has(key)) continue;
          source.set(key, {
            kind,
            source_key: key,
            label:
              kind === "people"
                ? row.personEmail
                : kind === "clients"
                  ? row.client
                  : kind === "projects"
                    ? row.project
                    : row.task,
            parents:
              kind === "projects"
                ? [
                    {
                      kind: "clients",
                      source_key: keys.clients,
                      label: row.client,
                    },
                  ]
                : kind === "tasks"
                  ? [
                      {
                        kind: "clients",
                        source_key: keys.clients,
                        label: row.client,
                      },
                      {
                        kind: "projects",
                        source_key: keys.projects,
                        label: row.project,
                      },
                    ]
                  : [],
            parent_source_key:
              kind === "projects"
                ? keys.clients
                : kind === "tasks"
                  ? keys.projects
                  : null,
            state: selected ? (entity?.status ?? "matched") : "excluded",
            selected_id:
              entity?.id ??
              (
                choices.mapping as unknown as import("../../../packages/migrate/src/csv-browser-mapping.js").CsvBrowserMapping
              ).destinationIds?.[kind][key] ??
              null,
            selected_destination: null,
            ambiguous: entity?.status === "rejected",
          });
        }
      }
      const candidates: Record<string, CsvStagingCandidate[]> = {
        people: r.people.map((x) => ({
          id: x.id,
          name: `${x.first_name} ${x.last_name}`.trim(),
          parent_id: null,
          parent_name: null,
          is_active: x.is_active === 1,
          selectable: true,
          currency: null,
        })),
        clients: r.snapshot.clients.map((x) => ({
          id: x.id,
          name: x.name,
          parent_id: null,
          parent_name: null,
          is_active: x.is_active === 1,
          selectable: x.is_active === 1,
          currency: x.currency,
        })),
        projects: r.snapshot.projects.map((x) => ({
          id: x.id,
          name: x.name,
          parent_id: x.client_id,
          parent_name:
            r.snapshot.clients.find((c) => c.id === x.client_id)?.name ?? null,
          is_active: x.is_active === 1,
          selectable: x.is_active === 1,
          currency:
            r.projectCurrencies.find((p) => p.id === x.id)?.billing_currency ??
            r.snapshot.clients.find((c) => c.id === x.client_id)?.currency ??
            null,
        })),
        tasks: r.snapshot.tasks.map((x) => ({
          id: x.id,
          name: x.name,
          parent_id: null,
          parent_name: null,
          is_active: x.is_active === 1,
          selectable: x.is_active === 1,
          currency: null,
        })),
      };
      for (const sourceEntity of source.values())
        sourceEntity.selected_destination =
          candidates[sourceEntity.kind]?.find(
            (candidate) => candidate.id === sourceEntity.selected_id,
          ) ?? null;
      return { sources: [...source.values()], candidates };
    };
    const port: CsvImportStagingPort = {
      runtime: "container",
      async authorize(a) {
        authorize(a);
      },
      async authorizeRun(a, run) {
        owned(a, run);
      },
      async upload(a, body, expected, signal) {
        authorize(a);
        if (signal.aborted) fail("upload_aborted");
        if (
          !/^[a-f0-9]{64}$/.test(expected.sha256) ||
          !Number.isSafeInteger(expected.bytes) ||
          expected.bytes < 1
        )
          fail("length_mismatch");
        if (expected.bytes > 5 * 1024 * 1024) fail("file_too_large");
        const nonce = target(),
          runId = id("csv");
        async function* checked() {
          for await (const chunk of body) {
            if (signal.aborted) fail("upload_aborted");
            yield chunk;
          }
        }
        const object = await disk.put(runId, checked(), expected);
        try {
          authorize(a, nonce);
          const bytes = await disk.read(object.objectKey);
          if (!bytes) fail("storage_unavailable");
          if (
            new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-" ||
            (bytes[0] === 0x50 &&
              bytes[1] === 0x4b &&
              [3, 5, 7].includes(bytes[2] ?? -1)) ||
            (bytes[0] === 0xd0 &&
              bytes[1] === 0xcf &&
              bytes[2] === 0x11 &&
              bytes[3] === 0xe0)
          )
            fail("not_csv");
          const admission = await work<{
            parsed: { fileErrors: CsvIssue[]; dataRows: number };
          }>({ kind: "admit", bytes }, signal);
          if (admission.parsed.fileErrors.some((x) => x.code === "not_utf8"))
            fail("invalid_utf8");
          if (
            admission.parsed.fileErrors.some((x) => x.code === "binary_content")
          )
            fail("not_csv");
          const fatal = admission.parsed.fileErrors.find((x) =>
            [
              "not_csv",
              "invalid_utf8",
              "too_many_rows",
              "too_many_columns",
              "field_too_long",
              "name_too_long",
            ].includes(x.code),
          );
          if (fatal)
            fail(
              fatal.code as
                | "not_csv"
                | "invalid_utf8"
                | "too_many_rows"
                | "too_many_columns"
                | "field_too_long"
                | "name_too_long",
            );
          authorize(a, nonce);
          const existing = sidecar
            .prepare(
              "SELECT * FROM stages WHERE target=? AND owner=? AND sha=? AND bytes=? AND status IN('staged','previewed') AND expires_at>? ORDER BY created_at DESC LIMIT 1",
            )
            .get(
              nonce,
              a.userId,
              expected.sha256,
              expected.bytes,
              now().toISOString(),
            ) as Stage | undefined;
          if (existing) {
            await disk.delete(object.objectKey);
            return representation(existing);
          }
          const created = now().toISOString(),
            expires = new Date(
              now().getTime() + CSV_RAW_RETENTION_MS,
            ).toISOString();
          sidecar
            .prepare(
              `INSERT INTO stages(id,target,owner,version,status,sha,bytes,object_key,created_at,expires_at) VALUES(?,?,?,0,'staged',?,?,?,?,?)`,
            )
            .run(
              runId,
              nonce,
              a.userId,
              expected.sha256,
              expected.bytes,
              object.objectKey,
              created,
              expires,
            );
          return representation(owned(a, runId));
        } catch (error) {
          await disk.delete(object.objectKey);
          throw error;
        }
      },
      async read(a, run) {
        return representation(owned(a, run));
      },
      async mapping(a, run) {
        const row = owned(a, run);
        inputAllowed(row);
        return {
          version: row.version,
          choices: row.choices
            ? (JSON.parse(row.choices) as CsvStagingChoices)
            : null,
          preview_id: row.preview_id,
        };
      },
      async map(a, run, input) {
        const row = owned(a, run);
        inputAllowed(row);
        if (
          Object.keys(input).some(
            (key) =>
              ![
                "workspace_identity",
                "exporter_zone",
                "date_format",
                "destination_interpretation",
                "currency_policy",
                "mapping",
                "excluded_lines",
                "version",
              ].includes(key),
          )
        )
          fail("mapping_invalid");
        if (
          !["staged", "previewed"].includes(row.status) ||
          input.version !== row.version
        )
          fail("preview_stale");
        if (
          typeof input.workspace_identity !== "string" ||
          !input.workspace_identity.trim() ||
          input.workspace_identity.length > 255 ||
          input.date_format !== "iso" ||
          input.destination_interpretation !== "source_wall_time" ||
          input.currency_policy !== "destination_rates" ||
          !Array.isArray(input.excluded_lines) ||
          input.excluded_lines.length > 50_000
        )
          fail("mapping_invalid");
        try {
          assertCsvExporterZone(input.exporter_zone);
        } catch {
          fail("mapping_invalid");
        }
        let mapping;
        try {
          mapping = parseBrowserMapping(JSON.stringify(input.mapping));
        } catch {
          fail("mapping_invalid");
        }
        const exclusions = [...new Set(input.excluded_lines)].sort(
          (x, y) => x - y,
        );
        if (exclusions.some((x) => !Number.isSafeInteger(x) || x < 2))
          fail("mapping_invalid");
        const service = createSqliteCsvBrowserService(main, {
          now,
          authorityFence: (actor) =>
            csvStagingSessionFence(a, row.target, Number(actor.userId)),
        });
        let dataset: string;
        try {
          dataset = await service.ledger.registerDataset(
            { kind: "administrator", userId: String(a.userId) },
            { workspaceIdentity: input.workspace_identity },
          );
        } catch (error) {
          if (error instanceof CsvBrowserLedgerRefusal) {
            if (error.code === "actor_required") fail("administrator_required");
            if (error.code === "dataset_conflict")
              fail("source_choice_required");
          }
          throw error;
        }
        current(a, row);
        const choices: CsvStagingChoices = {
          workspace_identity: input.workspace_identity,
          source_id: dataset,
          adapter_id: CLOCKIFY_ADAPTERS.browser,
          date_format: "iso",
          exporter_zone: input.exporter_zone,
          destination_interpretation: "source_wall_time",
          currency_policy: "destination_rates",
          excluded_lines: exclusions,
          mapping: mapping as unknown as Record<string, unknown>,
        };
        cas(
          row,
          "choices=?,source_id=?,status='staged',preview_id=NULL,summary=NULL",
          [JSON.stringify(choices), dataset],
        );
        return representation(owned(a, run));
      },
      async preview(a, run, expectedPreviewId, signal) {
        const row = owned(a, run);
        inputAllowed(row);
        if (!["staged", "previewed"].includes(row.status)) {
          if (!expectedPreviewId || expectedPreviewId !== row.preview_id)
            fail("preview_stale");
          const receipt = saved(row, expectedPreviewId),
            stored = JSON.parse(receipt.private_json) as WorkResult;
          return {
            organization_name: stored.organizationName,
            preview_id: receipt.id,
            run: representation(row),
            choices: JSON.parse(row.choices!) as CsvStagingChoices,
            tallies: JSON.parse(receipt.tallies) as CsvStagingTallies,
          };
        }
        if (
          expectedPreviewId !== undefined &&
          expectedPreviewId !== row.preview_id
        )
          fail("preview_stale");
        const { result, choices } = await calculate(a, row, signal);
        const binding = JSON.stringify([
          row.id,
          row.target,
          row.owner,
          row.sha,
          row.bytes,
          choices,
          result.plan.destinationVersion,
          result.snapshot.importedEntries,
        ]);
        const previewId = `preview_${sha(binding)}`;
        const stats = tallies(result.plan);
        const diagnostics = [
          ...result.plan.plan.report.fileErrors.map((x) =>
            diagnostic(x, "file", "invalid"),
          ),
          ...result.plan.plan.report.rejected.map((x) =>
            diagnostic(x, "row", x.category),
          ),
          ...result.plan.plan.report.warnings.map((x) =>
            diagnostic(x, x.line <= 1 ? "file" : "row", "warning"),
          ),
        ];
        sidecar.transaction(() => {
          current(a, row);
          sidecar
            .prepare("INSERT OR IGNORE INTO previews VALUES(?,?,?,?,?,?,?,?)")
            .run(
              previewId,
              row.id,
              row.version,
              binding,
              JSON.stringify(result),
              JSON.stringify(stats),
              JSON.stringify(diagnostics),
              JSON.stringify(buildCatalog(result, choices)),
            );
          cas(row, "status='previewed',preview_id=?,summary=?", [
            previewId,
            JSON.stringify(stats),
          ]);
        })();
        return {
          organization_name: result.organizationName,
          preview_id: previewId,
          run: representation(owned(a, run)),
          choices,
          tallies: stats,
        };
      },
      async errors(a, run, q) {
        const row = owned(a, run);
        inputAllowed(row);
        const p = saved(row, q.previewId);
        const values = JSON.parse(p.diagnostics) as CsvStagingDiagnostic[];
        return page(
          values.filter((x) => !q.kind || x.kind === q.kind),
          p,
          `errors:${q.kind ?? ""}`,
          q.limit,
          q.cursor,
        );
      },
      async catalog(a, run, q) {
        const row = owned(a, run);
        inputAllowed(row);
        const p = saved(row, q.previewId);
        const data = JSON.parse(p.catalog) as ReturnType<typeof buildCatalog>;
        if (!q.sourceKey)
          return page(
            data.sources.filter((x) => x.kind === q.kind),
            p,
            `sources:${q.kind}`,
            q.limit,
            q.cursor,
          );
        const source = data.sources.find(
          (x) => x.source_key === q.sourceKey && x.kind === q.kind,
        );
        if (!source) fail("mapping_invalid");
        let values = data.candidates[q.kind] ?? [];
        if (q.kind === "projects" && source.parent_source_key) {
          const parent = data.sources.find(
            (x) => x.source_key === source.parent_source_key,
          );
          values = parent?.selected_id
            ? values.filter((x) => x.parent_id === parent.selected_id)
            : [];
        }
        return page(
          values,
          p,
          `candidates:${q.kind}:${q.sourceKey}`,
          q.limit,
          q.cursor,
        );
      },
      async diagnostics(a, run, previewId) {
        const row = owned(a, run);
        inputAllowed(row);
        const p = saved(row, previewId);
        return JSON.stringify({
          preview_id: p.id,
          tallies: JSON.parse(p.tallies) as unknown,
          diagnostics: JSON.parse(p.diagnostics) as unknown,
        });
      },
      async purge(a, run) {
        const row = owned(a, run);
        if (row.status === "confirmed") fail("run_busy");
        if (row.status === "purged") return;
        cas(
          row,
          "status='purged',object_key=NULL,choices=NULL,preview_id=NULL,retention_deadline=?",
          [now().toISOString()],
        );
        sidecar.prepare("DELETE FROM previews WHERE stage_id=?").run(row.id);
        if (row.object_key) await disk.delete(row.object_key);
      },
    };
    const apply: CsvStagingApplyPort = {
      async requestOwnedCancellation(a, input) {
        const row = owned(a, input.stageId);
        if (
          !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(
            input.cancellationCommandId,
          ) ||
          !Number.isSafeInteger(input.expectedVersion) ||
          input.expectedVersion < 0
        )
          fail("mapping_invalid");
        if (
          row.command_id !== input.confirmationCommandId ||
          row.confirmed_preview_id !== input.previewId
        )
          fail("preview_stale");
        const request = JSON.stringify({
          previewId: input.previewId,
          confirmationCommandId: input.confirmationCommandId,
          cancellationCommandId: input.cancellationCommandId,
        });
        const result = () => ({
          stageVersion: row.version,
          targetNonce: row.target,
          confirmationCommandId: input.confirmationCommandId,
          cancellationCommandId: input.cancellationCommandId,
        });
        if (
          row.cancellation_command_id === input.cancellationCommandId &&
          row.cancellation_request_json === request
        )
          return result();
        if (
          row.version !== input.expectedVersion ||
          row.cancellation_command_id !== null
        )
          fail("preview_stale");
        cas(row, "cancellation_command_id=?,cancellation_request_json=?", [
          input.cancellationCommandId,
          request,
        ]);
        return { ...result(), stageVersion: row.version + 1 };
      },
      async readOwnedConfirmation(a, stageId) {
        const row = owned(a, stageId);
        return !row.command_id || !row.confirmed_preview_id
          ? null
          : {
              commandId: row.command_id,
              previewId: row.confirmed_preview_id,
              stageVersion: row.version,
              targetNonce: row.target,
              requestJson: row.request_json,
              cancellationCommandId: row.cancellation_command_id,
            };
      },
      async readOwnedApplyBinding(a, stageId) {
        const row = owned(a, stageId);
        return row.native_run_id === null ||
          row.lease_generation === null ||
          !row.command_id ||
          !row.confirmed_preview_id
          ? null
          : {
              stageId: row.id,
              stageVersion: row.version,
              targetNonce: row.target,
              previewId: row.confirmed_preview_id!,
              nativeRunId: row.native_run_id,
              leaseGeneration: row.lease_generation,
              commandId: row.command_id,
            };
      },
      async claimConfirmation(a, input) {
        const row = owned(a, input.stageId);
        if (row.cancellation_command_id !== null) fail("preview_stale");
        const requestJson = canonicalClaimRequest(input.requestJson);
        if (requestJson) {
          const request = JSON.parse(requestJson) as {
            preview_id: string;
            command_id: string;
            version: number;
          };
          if (
            request.preview_id !== input.previewId ||
            request.command_id !== input.commandId ||
            request.version !== input.expectedVersion
          )
            fail("mapping_invalid");
        }
        inputAllowed(row);
        saved(row, input.previewId);
        if (!previewCurrent(row)) fail("preview_stale");
        if (
          row.status === "confirmed" &&
          row.command_id === input.commandId &&
          row.request_json === requestJson
        )
          return {
            stageVersion: row.version,
            commandId: input.commandId,
            targetNonce: row.target,
          };
        if (
          row.status !== "previewed" ||
          row.version !== input.expectedVersion ||
          !input.commandId ||
          input.commandId.length > 128
        )
          fail("preview_stale");
        cas(
          row,
          "status='confirmed',command_id=?,confirmed_preview_id=?,request_json=?",
          [input.commandId, input.previewId, requestJson],
        );
        return {
          stageVersion: row.version + 1,
          commandId: input.commandId,
          targetNonce: row.target,
        };
      },
      async loadOwnedPreview(a, stageId, previewId) {
        const row = owned(a, stageId);
        if (
          row.cancellation_command_id !== null ||
          !["previewed", "confirmed"].includes(row.status)
        )
          fail("preview_stale");
        const p = saved(row, previewId);
        const { result, bytes, choices } = await calculate(
          a,
          row,
          new AbortController().signal,
        );
        const original = JSON.parse(p.private_json) as WorkResult;
        if (result.plan.destinationVersion !== original.plan.destinationVersion)
          fail("preview_stale");
        const changedHistory =
          JSON.stringify(result.snapshot.importedEntries) !==
          JSON.stringify(original.snapshot.importedEntries);
        if (changedHistory) {
          if (row.status !== "confirmed" || row.native_run_id === null)
            fail("preview_stale");
          const native = main
            .prepare(
              "SELECT browser_plan_id FROM csv_import_runs WHERE id=? AND source_id=?",
            )
            .get(row.native_run_id, row.source_id) as
            { browser_plan_id: string } | undefined;
          if (
            !native ||
            native.browser_plan_id !==
              csvPlanId(csvBrowserSealInput(original.plan)) ||
            native.browser_plan_id !==
              csvPlanId(csvBrowserSealInput(result.plan))
          )
            fail("preview_stale");
          const originalKeys = new Set(
              original.snapshot.importedEntries.map((x) => x.sourceKey),
            ),
            currentKeys = new Set(
              result.snapshot.importedEntries.map((x) => x.sourceKey),
            );
          if ([...originalKeys].some((key) => !currentKeys.has(key)))
            fail("preview_stale");
          const currentByKey = new Map(
            result.snapshot.importedEntries.map((entry) => [
              entry.sourceKey,
              entry,
            ]),
          );
          if (
            original.snapshot.importedEntries.some(
              (entry) =>
                currentByKey.get(entry.sourceKey)?.roundedSeconds !==
                entry.roundedSeconds,
            )
          )
            fail("preview_stale");
          for (const entry of result.snapshot.importedEntries) {
            if (originalKeys.has(entry.sourceKey)) continue;
            if (
              !main
                .prepare(
                  "SELECT 1 FROM csv_import_chunks c JOIN csv_import_entries i ON i.source_key=c.source_key WHERE c.run_id=? AND i.source_id=? AND c.source_key=? AND c.source_line=i.source_line AND c.source_seconds=i.source_seconds",
                )
                .get(row.native_run_id, row.source_id, entry.sourceKey)
            )
              fail("preview_stale");
          }
        }
        return {
          stageId,
          stageVersion: row.version,
          targetNonce: row.target,
          creatorUserId: row.owner,
          authority: a,
          previewId,
          sourceId: row.source_id!,
          fileSha256: row.sha,
          fileBytes: row.bytes,
          mappingSha256: original.plan.plan.mappingSha256,
          stagingExpiresAt: row.expires_at,
          inputExpiresAt: row.expires_at,
          retentionDeadline: row.retention_deadline,
          stale: false,
          choices: {
            workspaceIdentity: choices.workspace_identity,
            exporterZone: choices.exporter_zone,
            mapping: parseBrowserMapping(JSON.stringify(choices.mapping)),
            excludedLines: choices.excluded_lines,
          },
          plan: row.status === "confirmed" ? result.plan : original.plan,
          bytes,
        };
      },
      async bindConfirmedRun(a, binding) {
        const row = owned(a, binding.stageId);
        if (
          row.cancellation_command_id !== null ||
          (row.native_run_id !== null &&
            row.native_run_id !== binding.nativeRunId) ||
          (row.lease_generation !== null &&
            binding.leaseGeneration < row.lease_generation)
        )
          fail("preview_stale");
        if (
          row.status !== "confirmed" ||
          row.target !== binding.targetNonce ||
          row.preview_id !== binding.previewId ||
          row.command_id !== binding.commandId ||
          binding.stageVersion > row.version
        )
          fail("preview_stale");
        if (
          row.native_run_id === binding.nativeRunId &&
          row.lease_generation === binding.leaseGeneration
        )
          return { ...binding, stageVersion: row.version };
        if (row.version !== binding.stageVersion) fail("preview_stale");
        cas(row, "native_run_id=?,lease_generation=?", [
          binding.nativeRunId,
          binding.leaseGeneration,
        ]);
        return { ...binding, stageVersion: row.version + 1 };
      },
      async markSystemProgress(binding, state, _code, terminalAt) {
        if (
          target() !== binding.targetNonce ||
          options.verifyApplyBinding?.(binding) !== true
        )
          return null;
        const row = sidecar
          .prepare("SELECT * FROM stages WHERE id=?")
          .get(binding.stageId) as Stage | undefined;
        if (
          !row ||
          row.version !== binding.stageVersion ||
          row.status !== "confirmed" ||
          row.target !== binding.targetNonce ||
          row.native_run_id !== binding.nativeRunId ||
          (row.lease_generation !== null &&
            row.lease_generation > binding.leaseGeneration) ||
          row.preview_id !== binding.previewId ||
          row.command_id !== binding.commandId
        )
          return null;
        const terminal = ["completed", "cancelled", "failed"].includes(state);
        if (
          terminal &&
          (!terminalAt ||
            !Number.isFinite(Date.parse(terminalAt)) ||
            Date.parse(terminalAt) > now().getTime())
        )
          return null;
        cas(row, "status=?,retention_deadline=?,lease_generation=?", [
          terminal ? state : "confirmed",
          terminal
            ? new Date(
                Date.parse(terminalAt!) + CSV_RAW_RETENTION_MS,
              ).toISOString()
            : null,
          binding.leaseGeneration,
        ]);
        return { ...binding, stageVersion: row.version + 1 };
      },
    };
    return {
      port,
      apply,
      close: () => sidecar.close(),
      async sweep() {
        const incarnation = target();
        const expired = (
          sidecar
            .prepare("SELECT * FROM stages WHERE status<>'purged'")
            .all() as Stage[]
        ).filter(
          (row) =>
            row.target !== incarnation ||
            !!main
              .prepare("SELECT 1 FROM account_closures WHERE user_id=?")
              .get(row.owner) ||
            (row.retention_deadline !== null &&
              Date.parse(row.retention_deadline) <= now().getTime()) ||
            Date.parse(row.expires_at) <= now().getTime(),
        );
        for (const row of expired) {
          sidecar.transaction(() => {
            cas(
              row,
              "status='purged',object_key=NULL,choices=NULL,preview_id=NULL,retention_deadline=?",
              [now().toISOString()],
            );
            sidecar
              .prepare("DELETE FROM previews WHERE stage_id=?")
              .run(row.id);
          })();
          if (row.object_key) await disk.delete(row.object_key);
        }
        const known = new Set(
          (
            sidecar
              .prepare(
                "SELECT object_key FROM stages WHERE object_key IS NOT NULL",
              )
              .all() as { object_key: string }[]
          ).map((x) => x.object_key),
        );
        await disk.sweepOrphans(known, now().getTime() - CSV_RAW_RETENTION_MS);
      },
    };
  } catch (error) {
    sidecar.close();
    throw error;
  }
};
