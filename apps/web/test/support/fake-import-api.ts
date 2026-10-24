import type {
  ApplyCommand,
  ApplyOutcome,
  ErrorPage,
  ImportCapability,
  ImportChoices,
  ImportPreview,
  ImportPreviewApi,
  RowError,
} from "../../src/csv-import/contract.js";

/**
 * In-memory stand-in for the routes of issue 1181, for contract tests only. It
 * models the invariants any real implementation must keep: preview and error
 * paging never write, a newer preview supersedes older ones, and apply checks
 * the preview identity and acknowledgements.
 */
export interface FakeOptions {
  errors?: RowError[];
  sourceSeconds?: number;
  roundedSeconds?: number;
  capability?: ImportCapability;
}

export class FakeImportApi implements ImportPreviewApi {
  /** Rows written to the destination. Only an accepted apply moves it. */
  writes = 0;
  private latest: string | null = null;
  private sequence = 0;
  private readonly previews = new Map<string, ImportPreview>();
  private readonly errorList: RowError[];

  constructor(private readonly options: FakeOptions = {}) {
    this.errorList = options.errors ?? [];
  }

  async capability(): Promise<ImportCapability> {
    return this.options.capability ?? { state: "available", guidance: null };
  }

  async upload(
    bytes: Uint8Array,
  ): Promise<{ upload_id: string; sha256: string }> {
    return { upload_id: `up-${bytes.length}`, sha256: "a".repeat(64) };
  }

  async preview(
    uploadId: string,
    choices: ImportChoices,
  ): Promise<ImportPreview> {
    this.sequence += 1;
    const invalid = this.errorList.filter(
      (e) => e.category === "invalid",
    ).length;
    const unsupported = this.errorList.length - invalid;
    const id = `pv-${uploadId}-${this.sequence}`;
    const preview: ImportPreview = {
      preview_id: id,
      destination: { organization_name: "Example Org" },
      file: { sha256: "a".repeat(64), bytes: 1024, data_rows: 10 },
      dataset: {
        source_id: choices.source_id,
        export_from: null,
        export_to: null,
      },
      choices,
      supported_entities: ["time"],
      excluded_entities: ["rates", "attachments"],
      ignored_columns: ["Rate"],
      unknown_columns: [],
      people: { matched: 1, new: 0, rejected: 0 },
      clients: { matched: 1, new: 0, rejected: 0 },
      projects: { matched: 1, new: 0, rejected: 0 },
      tasks: { matched: 1, new: 0, rejected: 0 },
      assignments: { user_project: 1, project_task: 1, billable_overrides: 0 },
      entries: {
        total: 10,
        new: 10 - this.errorList.length,
        already_imported: 0,
        rejected: this.errorList.length,
      },
      seconds: {
        source: this.options.sourceSeconds ?? 3600,
        rounded: this.options.roundedSeconds ?? 3600,
      },
      unpriced_entries: 0,
      destination_estimates: [],
      errors: { invalid, unsupported },
      warnings: 0,
      retention_expires_at: "2026-01-02T00:00:00Z",
    };
    this.previews.set(id, preview);
    this.latest = id;
    return preview;
  }

  async errors(previewId: string, cursor: string | null): Promise<ErrorPage> {
    const preview = this.previews.get(previewId);
    if (preview === undefined) throw new Error("unknown_preview");
    const size = 2;
    const start = cursor === null ? 0 : Number(cursor);
    const end = start + size;
    return {
      items: this.errorList.slice(start, end),
      next_cursor: end < this.errorList.length ? String(end) : null,
      total: preview.errors,
    };
  }

  async apply(command: ApplyCommand): Promise<ApplyOutcome> {
    const preview = this.previews.get(command.preview_id);
    if (preview === undefined || command.preview_id !== this.latest)
      return { status: "stale", reason: "preview_replaced" };
    const ack = command.acknowledgements;
    if (preview.entries.rejected > 0) {
      if (!ack.partial) return { status: "refused", reason: "rejected_rows" };
      if (ack.excluded_count !== preview.entries.rejected)
        return { status: "refused", reason: "acknowledgement_missing" };
    }
    if (preview.seconds.source !== preview.seconds.rounded && !ack.rounding)
      return { status: "refused", reason: "acknowledgement_missing" };
    this.writes += preview.entries.new;
    return { status: "accepted", run_id: `run-${command.preview_id}` };
  }

  async purge(): Promise<void> {}
}
