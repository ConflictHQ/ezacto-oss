/** @vitest-environment happy-dom */
import { afterEach, expect, it } from "vitest";
import type { Estimate, Whoami } from "@conflict-hq/ezacto-client";
import { createEstimateWorkspaceController } from "../src/estimates/browser.js";
import { renderEstimatesPage } from "../src/estimates/render.js";
import { setSortPreferenceOwner } from "../src/components/table-sort.js";

const estimates = [
  { id: 1, number: "EST-10", amount_cents: 900, issue_date: "2026-10-12" },
  { id: 2, number: "EST-9", amount_cents: 10000, issue_date: "2026-10-02" },
  { id: 3, number: "EST-1315", amount_cents: 2000, issue_date: "2026-10-09" },
].map(
  (row) =>
    ({
      ...row,
      client_id: 1,
      currency: "USD",
      state: "draft",
      subject: null,
      line_items: [],
    }) as unknown as Estimate,
);
const rows = () =>
  Array.from(
    document.querySelectorAll("[data-estimate-list] tbody tr[data-row-key]"),
  ).map((row) => row.getAttribute("data-row-key"));
const header = (column: string) =>
  document.querySelector<HTMLButtonElement>(
    `[data-estimate-list] button[data-sort-column="${column}"]`,
  )!;
const mount = async (userId: number) => {
  setSortPreferenceOwner(userId);
  document.documentElement.dataset.appView = "invoice-estimates";
  document.body.innerHTML = renderEstimatesPage("invoice-estimates");
  window.history.replaceState({}, "", "/invoices/estimates");
  await createEstimateWorkspaceController({
    listEstimates: async () => ({
      data: estimates,
      page: { next_cursor: "more" },
    }),
    listEstimateClients: async () => ({
      data: [],
      page: { next_cursor: null },
    }),
  }).activate(
    {
      user_id: userId,
      profile: "administrator",
      manager_grants: [],
      authentication: { kind: "session" },
    } as unknown as Whoami,
    new AbortController().signal,
    () => false,
  );
};
afterEach(() => {
  setSortPreferenceOwner(null);
  localStorage.clear();
});
it("[browser #852] remembers natural-number, date and money sorts after remount without sharing one person’s selection", async () => {
  await mount(1);
  header("number").click();
  expect(rows()).toEqual(["2", "1", "3"]);
  header("number").click();
  expect(rows()).toEqual(["3", "1", "2"]);
  await mount(1);
  expect(rows()).toEqual(["3", "1", "2"]);
  expect(header("number").closest("th")?.getAttribute("aria-sort")).toBe(
    "descending",
  );
  header("issued").click();
  expect(rows()).toEqual(["2", "3", "1"]);
  header("amount").click();
  expect(rows()).toEqual(["1", "3", "2"]);
  await mount(1);
  expect(rows()).toEqual(["1", "3", "2"]);
  await mount(2);
  expect(rows()).toEqual(["1", "2", "3"]);
  expect(
    document.querySelector("[data-estimate-list-status]")?.textContent,
  ).toContain("Sorting covers only the rows loaded");
});
