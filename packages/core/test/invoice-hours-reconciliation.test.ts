import { describe, expect, it } from "vitest";
import {
  reconcileInvoiceHours,
  type ReconciliationEntry,
  type ReconciliationLine,
} from "../src/invoice-hours-reconciliation.js";

const entry = (projectId: number, seconds: number): ReconciliationEntry => ({
  projectId,
  projectName: `Project ${String(projectId)}`,
  seconds,
});
const line = (
  id: number,
  projectId: number | null,
  quantity: number,
): ReconciliationLine => ({
  id,
  position: id,
  description: `Line ${String(id)}`,
  projectId,
  projectName: projectId === null ? null : `Project ${String(projectId)}`,
  quantity,
});

describe("reconciling billed hours with linked entries (issue 924)", () => {
  it("[unit] matches when the line states exactly the linked hours", () => {
    const result = reconcileInvoiceHours({
      entries: [entry(1, 3600), entry(1, 5400)],
      lines: [line(1, 1, 2.5)],
    });
    expect(result.status).toBe("matched");
    expect(result.linkedSeconds).toBe(9000);
    expect(result.billedSeconds).toBe(9000);
    expect(result.differenceSeconds).toBe(0);
    expect(result.projects).toEqual([
      expect.objectContaining({ projectId: 1, projectName: "Project 1", status: "matched" }),
    ]);
    expect(result.notCompared).toEqual([]);
  });

  it("[unit] reports a line trimmed below the linked hours", () => {
    const result = reconcileInvoiceHours({
      entries: [entry(1, 36_000)],
      lines: [line(1, 1, 8)],
    });
    expect(result.status).toBe("billed_below_linked");
    expect(result.differenceSeconds).toBe(-7200);
    expect(result.projects[0]).toMatchObject({ status: "billed_below_linked", differenceSeconds: -7200 });
  });

  it("[unit] reports a line raised above the linked hours", () => {
    const result = reconcileInvoiceHours({
      entries: [entry(1, 3600)],
      lines: [line(1, 1, 1.5)],
    });
    expect(result.status).toBe("billed_above_linked");
    expect(result.differenceSeconds).toBe(1800);
  });

  it("[unit] forgives a difference within the tolerance, and only that far", () => {
    // 7.25 h typed against 26 117 s of entries: 17 s, inside 0.01 h.
    const within = reconcileInvoiceHours({ entries: [entry(1, 26_117)], lines: [line(1, 1, 7.25)] });
    expect(within.status).toBe("matched");
    expect(within.differenceSeconds).toBe(-17);
    const edge = reconcileInvoiceHours({
      entries: [entry(1, 3600 + 36)],
      lines: [line(1, 1, 1)],
    });
    expect(edge.status).toBe("matched");
    const beyond = reconcileInvoiceHours({
      entries: [entry(1, 3600 + 37)],
      lines: [line(1, 1, 1)],
    });
    expect(beyond.status).toBe("billed_below_linked");
    const custom = reconcileInvoiceHours({
      entries: [entry(1, 3600 + 600)],
      lines: [line(1, 1, 1)],
      toleranceSeconds: 600,
    });
    expect(custom.status).toBe("matched");
    expect(custom.toleranceSeconds).toBe(600);
  });

  it("[unit] compares per project and sums several lines of one project", () => {
    const result = reconcileInvoiceHours({
      entries: [entry(1, 7200), entry(2, 3600)],
      lines: [line(1, 1, 1), line(2, 1, 1), line(3, 2, 0.5)],
    });
    expect(result.projects.map((project) => [project.projectId, project.status])).toEqual([
      [1, "matched"],
      [2, "billed_below_linked"],
    ]);
    expect(result.linkedSeconds).toBe(10_800);
    expect(result.billedSeconds).toBe(9000);
    expect(result.status).toBe("billed_below_linked");
  });

  it("[unit] shows a project with time linked but no line, and a line with nothing linked", () => {
    const result = reconcileInvoiceHours({
      entries: [entry(1, 3600)],
      lines: [line(1, 2, 2)],
    });
    expect(result.projects).toEqual([
      expect.objectContaining({ projectId: 1, billedSeconds: 0, status: "billed_below_linked" }),
      expect.objectContaining({ projectId: 2, linkedSeconds: 0, status: "billed_above_linked" }),
    ]);
  });

  it("[unit] leaves lines without a project out of every figure and lists them", () => {
    const fee = line(2, null, 1);
    const result = reconcileInvoiceHours({
      entries: [entry(1, 3600)],
      lines: [line(1, 1, 1), fee],
    });
    expect(result.status).toBe("matched");
    expect(result.billedSeconds).toBe(3600);
    expect(result.notCompared).toEqual([fee]);
  });

  it("[unit] is empty and matched for an invoice with no time and no lines", () => {
    const result = reconcileInvoiceHours({ entries: [], lines: [] });
    expect(result).toMatchObject({
      linkedSeconds: 0,
      billedSeconds: 0,
      differenceSeconds: 0,
      status: "matched",
      projects: [],
      notCompared: [],
    });
  });
});
