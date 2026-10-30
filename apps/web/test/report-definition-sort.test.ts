/** @vitest-environment happy-dom */
import { afterEach, expect, it } from "vitest";
import { renderDefinitionResultTable } from "../src/reports/definition-results.js";
import { setSortPreferenceOwner } from "../src/components/table-sort.js";

const report = {
  definitionId: "cost-and-hours",
  definitionVersion: 2,
  state: "ready" as const,
  rows: [
    {
      key: "ten",
      label: "Client 10",
      metrics: { hours: { value: 10 }, cost: { value: 1000 } },
      drillThrough: "/reports?client_id=10",
    },
    {
      key: "two",
      label: "Client 2",
      metrics: { hours: { value: 2 }, cost: { value: 2000 } },
      drillThrough: "/reports?client_id=2",
    },
    {
      key: "missing",
      label: "<Missing>",
      metrics: {
        hours: {
          value: null,
          missingReason: "missing_rate",
          fixUrl: "/team/1",
        },
      },
    },
  ],
};
const keys = () =>
  [...document.querySelectorAll("tbody tr[data-row-key]")].map((row) =>
    row.getAttribute("data-row-key"),
  );
const sort = (column: string) =>
  document
    .querySelector<HTMLButtonElement>(`button[data-sort-column="${column}"]`)!
    .click();
afterEach(() => {
  setSortPreferenceOwner(null);
  localStorage.clear();
  document.body.replaceChildren();
});
it("[browser #852] sorts custom result labels and numeric metrics, preserving exceptions and drill links", () => {
  document.body.replaceChildren(renderDefinitionResultTable(report));
  expect(document.querySelectorAll("thead th")).toHaveLength(3);
  sort("metric-hours");
  expect(keys()).toEqual(["two", "ten", "missing"]);
  sort("metric-hours");
  expect(keys()).toEqual(["ten", "two", "missing"]);
  sort("result");
  expect(keys()).toEqual(["missing", "two", "ten"]);
  expect(
    document.querySelector(
      '[data-row-key="missing"] [data-column="metric-hours"]',
    )?.textContent,
  ).toContain("missing_rate");
  expect(
    document.querySelector('[data-row-key="two"] a')?.getAttribute("href"),
  ).toBe("/reports?client_id=2");
  expect(document.querySelector("missing")).toBeNull();
});
it("[browser #852] remembers a definition’s metric sort and falls back when that metric disappears", () => {
  setSortPreferenceOwner(1);
  document.body.replaceChildren(renderDefinitionResultTable(report));
  sort("metric-cost");
  document.body.replaceChildren(renderDefinitionResultTable(report));
  expect(keys()).toEqual(["ten", "two", "missing"]);
  expect(
    document
      .querySelector('[data-column="metric-cost"]')
      ?.getAttribute("aria-sort"),
  ).toBe("ascending");
  const changed = {
    ...report,
    rows: report.rows.map((row) => ({
      ...row,
      metrics: { hours: row.metrics.hours },
    })),
  };
  document.body.replaceChildren(renderDefinitionResultTable(changed));
  expect(keys()).toEqual(["missing", "two", "ten"]);
  expect(
    document
      .querySelector('th[data-column="result"]')
      ?.getAttribute("aria-sort"),
  ).toBe("ascending");
  setSortPreferenceOwner(2);
  document.body.replaceChildren(renderDefinitionResultTable(report));
  expect(keys()).toEqual(["missing", "two", "ten"]);
});
