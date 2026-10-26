import type { CsvStagingChoices, CsvStagingTallies, CsvStagingDiagnostic, CsvStagingSourceEntity, CsvStagingCandidate } from '@ezacto/api'
import type { CsvBrowserPlan, CsvBrowserDestinationSnapshot } from './csv-planner.js'
import type { CsvRow, CsvIssue } from './csv-contract.js'
import { csvSourceEntityKeys } from './csv-browser-mapping.js'
export interface CsvPreviewResult {
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
export const csvDiagnostic = (
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
export const csvTallies = (p: CsvBrowserPlan): CsvStagingTallies => ({
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

export const csvCatalog = (r: CsvPreviewResult, choices: CsvStagingChoices) => {
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
                choices.mapping as unknown as import("./csv-browser-mapping.js").CsvBrowserMapping
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
