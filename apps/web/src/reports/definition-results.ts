import type { ReportRunnerResult } from "@conflict-hq/ezacto-client";
import {
  renderDataTable,
  type DataColumn,
  type DataTableSort,
} from "../components/data-table.js";

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Keep each metric's existing value/exception payload; compare its numeric value. */
export const renderDefinitionResultTable = (
  report: Readonly<ReportRunnerResult>,
  options: {
    sort?: DataTableSort;
    onSort?: (sort: DataTableSort) => void;
  } = {},
): HTMLElement => {
  const rows = report.rows.map((raw, index) => ({
    raw,
    key: typeof raw["key"] === "string" ? raw["key"] : String(index),
  }));
  type Row = (typeof rows)[number];
  const metrics = [
    ...new Set(rows.flatMap((row) => Object.keys(record(row.raw["metrics"])))),
  ];
  const columns: DataColumn<Row>[] = [
    {
      key: "result",
      label: "Result",
      sortValue: (row) =>
        typeof row.raw["label"] === "string" ? row.raw["label"] : null,
      render: (row) => {
        const label =
          typeof row.raw["label"] === "string" ? row.raw["label"] : "Result";
        if (typeof row.raw["drillThrough"] !== "string") return label;
        const link = document.createElement("a");
        link.href = row.raw["drillThrough"];
        link.textContent = label;
        return link;
      },
    },
    ...metrics.map((metric): DataColumn<Row> => ({
      key: `metric-${metric}`,
      label: metric.replaceAll("_", " "),
      numeric: true,
      sortDescription: "Sort by numeric value; missing values remain last",
      sortValue: (row) => {
        const value = record(record(row.raw["metrics"])[metric])["value"];
        return typeof value === "number" && Number.isFinite(value)
          ? value
          : null;
      },
      render: (row) => JSON.stringify(record(row.raw["metrics"])[metric] ?? {}),
    })),
  ];
  return renderDataTable({
    caption: "Custom report results",
    table: `custom-report:${report.definitionId}`,
    rows,
    rowKey: (row) => row.key,
    columns,
    defaultSort: { column: "result", direction: "ascending" },
    ...options,
  });
};
