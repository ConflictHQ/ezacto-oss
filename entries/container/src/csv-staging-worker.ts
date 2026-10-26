/** Private bounded work item. It never writes the destination, sends mail or applies a plan. */
import { parentPort, workerData } from "node:worker_threads";
import BetterSqlite3 from "better-sqlite3";
import { parseCsv } from "../../../packages/migrate/src/csv-contract.js";
import { createClockifyBrowserAdapter } from "../../../packages/migrate/src/csv-clockify.js";
import { createSqliteCsvBrowserService } from "../../../packages/migrate/src/csv-browser-sqlite.js";
import { parseBrowserMapping } from "../../../packages/migrate/src/csv-browser-mapping.js";
import { CsvBrowserPlannerError } from "../../../packages/migrate/src/csv-browser-errors.js";

try {
  const input = workerData as {
    kind: "admit" | "preview";
    bytes: Uint8Array;
    databasePath: string;
    target: string;
    actor: { kind: "administrator"; userId: string };
    sourceId: string;
    mappingJson: string;
    zone: string;
    excludedLines: number[];
    now: string;
  };
  if (input.kind === "admit") {
    const parsed = parseCsv(
      input.bytes,
      createClockifyBrowserAdapter({ exporterZone: "UTC" }),
    );
    parentPort!.postMessage({
      ok: true,
      parsed: {
        fileErrors: parsed.fileErrors,
        invalid: parsed.invalid,
        dataRows: parsed.dataRows,
      },
    });
  } else {
    const db = new BetterSqlite3(input.databasePath, {
      readonly: true,
      fileMustExist: true,
      timeout: 1000,
    });
    try {
      db.pragma("query_only=ON");
      const result = db
        .transaction(() => {
          const target = db
            .prepare("SELECT nonce FROM csv_staging_instance WHERE singleton=1")
            .get() as { nonce: string } | undefined;
          if (target?.nonce !== input.target)
            throw new CsvBrowserPlannerError("snapshot_input_mismatch");
          const service = createSqliteCsvBrowserService(db, {
            now: () => new Date(input.now),
          });
          const mapping = parseBrowserMapping(input.mappingJson);
          const result = service.preview(
            input.actor,
            input.sourceId,
            input.bytes,
            {
              exporterZone: input.zone,
              mapping,
              excludedLines: input.excludedLines,
            },
          );
          const people = db
            .prepare(
              "SELECT id,first_name,last_name,is_active FROM users WHERE NOT EXISTS(SELECT 1 FROM account_closures WHERE user_id=users.id) ORDER BY id",
            )
            .all();
          const projectCurrencies = db
            .prepare("SELECT id,billing_currency FROM projects ORDER BY id")
            .all();
          return {
            projectCurrencies,
            ...result,
            people,
            organizationName: (
              db
                .prepare("SELECT name FROM organizations ORDER BY id LIMIT 1")
                .get() as { name: string }
            ).name,
            sourceRows: parseCsv(
              input.bytes,
              createClockifyBrowserAdapter({ exporterZone: input.zone }),
            ).rows,
          };
        })
        .deferred();
      parentPort!.postMessage({ ok: true, ...result });
    } finally {
      db.close();
    }
  }
} catch (error) {
  parentPort!.postMessage({
    ok: false,
    code:
      error instanceof CsvBrowserPlannerError
        ? error.code
        : "storage_unavailable",
    error:
      error instanceof Error ? error : new Error("CSV private work failed"),
  });
}
