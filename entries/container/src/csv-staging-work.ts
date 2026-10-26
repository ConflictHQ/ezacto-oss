import { Worker } from "node:worker_threads";
import { CsvStagingError } from "@ezacto/api";
export const runCsvStagingWork = <Result>(
  input: unknown,
  signal: AbortSignal,
  options: { url?: URL; budgetMs?: number } = {},
): Promise<Result> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new CsvStagingError("upload_aborted"));
      return;
    }
    const worker = new Worker(
      options.url ?? new URL("./csv-staging-worker.js", import.meta.url),
      { workerData: input, resourceLimits: { maxOldGenerationSizeMb: 128 } },
    );
    let finished = false;
    const finish = (error: unknown, value?: Result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      void worker.terminate();
      if (error) reject(error);
      else resolve(value!);
    };
    const abort = () => finish(new CsvStagingError("upload_aborted"));
    const timer = setTimeout(
      () => finish(new CsvStagingError("parse_budget_exceeded")),
      options.budgetMs ?? 10_000,
    );
    signal.addEventListener("abort", abort, { once: true });
    worker.once("error", (error) =>
      finish(
        "code" in error && error.code === "ERR_WORKER_OUT_OF_MEMORY"
          ? new CsvStagingError("parse_budget_exceeded")
          : error,
      ),
    );
    worker.once("exit", () => {
      if (!finished) finish(new Error("CSV private work ended unexpectedly"));
    });
    worker.once(
      "message",
      (value: { ok: boolean; code?: string; error?: Error }) => {
        if (!value.ok) {
          if (value.code === "administrator_required")
            finish(new CsvStagingError("administrator_required"));
          else if (value.code === "snapshot_input_mismatch")
            finish(new CsvStagingError("run_not_found"));
          else if (
            value.code === "exporter_zone_invalid" ||
            value.code === "exporter_zone_required" ||
            value.code === "mapping_invalid" ||
            value.code === "mapping_source_unknown" ||
            value.code === "invalid_exclusion" ||
            value.code === "adapter_unsupported"
          )
            finish(new CsvStagingError("mapping_invalid"));
          else finish(value.error ?? new Error("CSV private work failed"));
        } else finish(null, value as Result);
      },
    );
  });
