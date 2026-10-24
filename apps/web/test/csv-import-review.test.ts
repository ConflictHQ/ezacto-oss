import { describe, expect, it } from "vitest";
import {
  cancelNotice,
  type ImportChoices,
  type RowError,
} from "../src/csv-import/contract.js";
import {
  afterSessionChange,
  applyCommand,
  blockers,
  startReview,
} from "../src/csv-import/review.js";
import { FakeImportApi } from "./support/fake-import-api.js";

const choices: ImportChoices = {
  source_id: "workspace-1",
  date_format: "YYYY-MM-DD",
  export_zone: "UTC",
  destination_interpretation: "wall_clock_as_written",
  new_client_currency: "USD",
  mapping: { people: {}, clients: {}, projects: {}, tasks: {} },
};

const errorLines = (count: number): RowError[] =>
  Array.from({ length: count }, (_, i) => ({
    line: i + 2,
    category: i % 2 === 0 ? ("invalid" as const) : ("unsupported" as const),
    code: i % 2 === 0 ? "bad_date" : "unsupported_tag",
    message: "Row cannot be imported.",
  }));

describe("import preview contract (fake provider)", () => {
  it("writes nothing for upload, preview or error paging", async () => {
    const api = new FakeImportApi({ errors: errorLines(3) });
    const upload = await api.upload(new Uint8Array(8));
    const preview = await api.preview(upload.upload_id, choices);
    await api.errors(preview.preview_id, null);
    expect(api.writes).toBe(0);
  });

  it("pages every error and keeps full totals on each page", async () => {
    const api = new FakeImportApi({ errors: errorLines(5) });
    const preview = await api.preview("up", choices);
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const page = await api.errors(preview.preview_id, cursor);
      expect(page.total).toEqual({ invalid: 3, unsupported: 2 });
      seen.push(...page.items.map((e) => e.line));
      cursor = page.next_cursor;
    } while (cursor !== null);
    expect(seen).toEqual([2, 3, 4, 5, 6]);
  });

  it("refuses rejected rows by default and applies only the reviewed exclusion", async () => {
    const api = new FakeImportApi({ errors: errorLines(2) });
    const preview = await api.preview("up", choices);
    const review = startReview(preview, "admin:1:administrator");
    expect(blockers(review)).toHaveLength(2);
    expect(() => applyCommand(review)).toThrow();

    const refused = await api.apply({
      preview_id: preview.preview_id,
      acknowledgements: { rounding: false, partial: false, excluded_count: 0 },
    });
    expect(refused).toEqual({ status: "refused", reason: "rejected_rows" });
    expect(api.writes).toBe(0);

    const reviewed = { ...review, partial: true, excludedCount: 2 };
    expect(blockers(reviewed)).toEqual([]);
    expect((await api.apply(applyCommand(reviewed))).status).toBe("accepted");
    expect(api.writes).toBe(8);
  });

  it("requires acknowledging rounded seconds that differ from the source", async () => {
    const api = new FakeImportApi({
      sourceSeconds: 3601,
      roundedSeconds: 3600,
    });
    const preview = await api.preview("up", choices);
    const review = startReview(preview, "admin:1:administrator");
    expect(blockers(review)).toHaveLength(1);
    expect(
      await api.apply({
        preview_id: preview.preview_id,
        acknowledgements: applyAck(false),
      }),
    ).toEqual({
      status: "refused",
      reason: "acknowledgement_missing",
    });
    expect(api.writes).toBe(0);
    expect(
      applyCommand({ ...review, rounding: true }).acknowledgements.rounding,
    ).toBe(true);
  });

  it("treats a replaced preview as stale and writes nothing from it", async () => {
    const api = new FakeImportApi();
    const first = await api.preview("up", choices);
    await api.preview("up", { ...choices, export_zone: "America/Denver" });
    const outcome = await api.apply(
      applyCommand(startReview(first, "admin:1:administrator")),
    );
    expect(outcome).toEqual({ status: "stale", reason: "preview_replaced" });
    expect(api.writes).toBe(0);
  });

  it("discards a review when the session identity or role changes", async () => {
    const api = new FakeImportApi();
    const review = startReview(
      await api.preview("up", choices),
      "admin:1:administrator",
    );
    expect(afterSessionChange(review, "admin:1:administrator")).toBe(review);
    expect(afterSessionChange(review, "admin:1:member")).toBeNull();
    expect(afterSessionChange(review, "admin:2:administrator")).toBeNull();
    expect(afterSessionChange(review, null)).toBeNull();
  });

  it("reports capability truthfully before any call", async () => {
    const api = new FakeImportApi({
      capability: {
        state: "unsupported_runtime",
        guidance: "Use the import-csv command.",
      },
    });
    expect((await api.capability()).state).toBe("unsupported_runtime");
  });

  it("never claims a rollback on cancel", () => {
    expect(cancelNotice(120, 3)).toContain("Nothing was rolled back");
  });
});

const applyAck = (rounding: boolean) => ({
  rounding,
  partial: false,
  excluded_count: 0,
});
