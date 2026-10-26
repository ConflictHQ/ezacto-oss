/** @vitest-environment happy-dom */
import { EzactoApiError } from "@conflict-hq/ezacto-client";
import type { DeelStagePreview } from "@conflict-hq/ezacto-client";
import { renderDeelStage } from "../src/staff-payments/deel-stage-render.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDeelStageController,
  type DeelStageApi,
} from "../src/staff-payments/deel-stage-browser.js";
import type { StaffPaymentReport } from "@ezacto/core";
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const preview: DeelStagePreview = {
  status: "ready" as const,
  from: "2026-10-01",
  to: "2026-10-20",
  user_ids: [2],
  preview_fingerprint: "a".repeat(64),
  entry_ids: [4],
  seconds: 3600,
  timesheets: 1,
  already_staged: 0,
  people: [{ user_id: 2, contract_id: "contract2", seconds: 3600, entries: 1 }],
  conflict_entry_ids: [],
  unsyncable_entry_ids: [],
  unmatched: [],
  unresolved_entry_ids: [],
};
const result = {
  status: "staged" as const,
  command_id: "test",
  run_id: 1,
  timesheets_staged: 1,
  entries_staged: 1,
  already_staged: 0,
  unresolved_entry_ids: [],
  code: null,
};
const report = {
  month: "2026-10",
  rows: [
    {
      user_id: 2,
      name: "<img src=x onerror=alert(1)>",
      active: true,
      payout_provider: "deel",
    },
    { user_id: 3, name: "Wise person", active: true, payout_provider: "wise" },
  ],
} as StaffPaymentReport;
const mount = () => {
  document.body.innerHTML = renderDeelStage();
  const api = {
    getDeelStaging: vi.fn<NonNullable<DeelStageApi["getDeelStaging"]>>(
      async () => ({
        data: {
          configured: true,
          reason: null,
          start_date: "2026-10-01",
          last_complete_date: "2026-10-25",
        },
      }),
    ),
    previewDeelStaging: vi.fn<NonNullable<DeelStageApi["previewDeelStaging"]>>(
      async () => ({ data: preview }),
    ),
    stageDeelHours: vi.fn<NonNullable<DeelStageApi["stageDeelHours"]>>(
      async () => ({ data: result }),
    ),
    getDeelStageStatus: vi.fn<NonNullable<DeelStageApi["getDeelStageStatus"]>>(
      async () => ({ data: result }),
    ),
  } satisfies DeelStageApi;
  const controller = createDeelStageController(document.body, api, () => {});
  const abort = new AbortController();
  return { api, controller, abort };
};
const el = <T extends HTMLElement>(s: string) => document.querySelector<T>(s)!;
const review = async () => {
  el<HTMLInputElement>("[data-deel-stage-people] input").checked = true;
  el<HTMLFormElement>("form").dispatchEvent(
    new Event("submit", { cancelable: true }),
  );
  await flush();
};
const confirm = () => {
  el<HTMLInputElement>("[data-deel-stage-reviewed]").checked = true;
  el("[data-deel-stage-reviewed]").dispatchEvent(new Event("change"));
  el<HTMLButtonElement>("[data-deel-stage-send]").click();
};
describe("selected Deel hour staging", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    HTMLElement.prototype.scrollIntoView = vi.fn();
  });
  it("requires explicit people and reviewed preview; sends hours not a local amount and never claims paid", async () => {
    const { api, controller, abort } = mount();
    await controller.activate(abort.signal);
    controller.update(report);
    controller.open();
    expect(el<HTMLInputElement>("[data-deel-stage-people] input").checked).toBe(
      false,
    );
    expect(document.body.textContent).not.toContain("Wise person");
    expect(document.querySelector("img")).toBeNull();
    await review();
    expect(api.stageDeelHours).not.toHaveBeenCalled();
    confirm();
    await flush();
    const call = api.stageDeelHours.mock.calls[0]![0];
    expect(call.body.user_ids).toEqual([2]);
    expect(call["Idempotency-Key"]).toBe(call.body.command_id);
    expect(call.body).not.toHaveProperty("amount");
    expect(el("[data-deel-stage-message]").textContent).toContain(
      "Nothing is marked paid",
    );
    expect(el<HTMLAnchorElement>("[data-deel-stage-handoff]").href).toBe(
      "https://app.deel.com/",
    );
  });
  it("retains exactly the same command across an ambiguous reply and status check", async () => {
    const { api, controller, abort } = mount();
    api.stageDeelHours.mockRejectedValueOnce(new Error("lost reply"));
    await controller.activate(abort.signal);
    controller.update(report);
    await review();
    confirm();
    await flush();
    const sent = api.stageDeelHours.mock.calls[0]![0];
    el<HTMLButtonElement>("[data-deel-stage-retry]").click();
    await flush();
    expect(api.stageDeelHours.mock.calls[1]![0]).toEqual(sent);
    expect(api.stageDeelHours).toHaveBeenCalledTimes(2);
  });
  it("does not permit sending conflicts, unmatched contracts or unresolved earlier transfers", async () => {
    const { api, controller, abort } = mount();
    api.previewDeelStaging.mockResolvedValue({
      data: { ...preview, unresolved_entry_ids: [4] },
    });
    await controller.activate(abort.signal);
    controller.update(report);
    await review();
    confirm();
    await flush();
    expect(api.stageDeelHours).not.toHaveBeenCalled();
    expect(el("[data-deel-stage-preview]").textContent).toContain(
      "Entries awaiting Deel reconciliation: 4",
    );
    expect(el<HTMLAnchorElement>("[data-deel-stage-handoff]").hidden).toBe(
      false,
    );
  });
  it("clears private options, preview, pending command and late responses on signout", async () => {
    const { api, controller, abort } = mount();
    let done!: (value: { data: typeof preview }) => void;
    api.previewDeelStaging.mockImplementation(
      () =>
        new Promise((resolve) => {
          done = resolve;
        }),
    );
    await controller.activate(abort.signal);
    controller.update(report);
    el<HTMLInputElement>("[data-deel-stage-people] input").checked = true;
    el<HTMLFormElement>("form").dispatchEvent(
      new Event("submit", { cancelable: true }),
    );
    await flush();
    abort.abort();
    done({ data: preview });
    await flush();
    expect(el("[data-deel-stage-people]").textContent).toBe("");
    expect(el("[data-deel-stage-preview]").textContent).toBe("");
    expect(el("[data-deel-stage-message]").textContent).toBe("");
    expect(el<HTMLElement>("[data-deel-stage]").hidden).toBe(true);
  });
  it("does not advertise staging when configuration discovery is false", async () => {
    const { api, controller, abort } = mount();
    api.getDeelStaging.mockResolvedValue({
      data: {
        configured: false,
        reason: "unconfigured",
        start_date: null,
        last_complete_date: null,
      },
    });
    await controller.activate(abort.signal);
    controller.update(report);
    controller.open();
    expect(controller.available()).toBe(false);
    expect(el<HTMLElement>("[data-deel-stage]").hidden).toBe(true);
  });
  it("discards private state on a current authority refusal", async () => {
    const { api, controller, abort } = mount();
    await controller.activate(abort.signal);
    controller.update(report);
    api.previewDeelStaging.mockRejectedValueOnce(
      new EzactoApiError(403, { error: { code: "profile_forbidden" } }, null),
    );
    await review();
    expect(el("[data-deel-stage-people]").textContent).toBe("");
    expect(controller.available()).toBe(false);
  });
  it("does not let an older abort clear the new session and deduplicates selection rows", async () => {
    const { controller, abort } = mount();
    await controller.activate(abort.signal);
    const next = new AbortController();
    await controller.activate(next.signal);
    controller.update({ ...report, rows: [...report.rows, report.rows[0]!] });
    abort.abort();
    expect(controller.available()).toBe(true);
    expect(
      document.querySelectorAll("[data-deel-stage-people] input"),
    ).toHaveLength(1);
  });
  it("retains the Deel inspection link for partial or unknown provider acceptance", async () => {
    const { api, controller, abort } = mount();
    api.stageDeelHours.mockResolvedValueOnce({
      data: {
        ...result,
        status: "attention",
        code: "provider_outcome_unknown",
      },
    });
    await controller.activate(abort.signal);
    controller.update(report);
    await review();
    confirm();
    await flush();
    expect(el<HTMLAnchorElement>("[data-deel-stage-handoff]").hidden).toBe(
      false,
    );
    expect(el("[data-deel-stage-message]").textContent).toContain(
      "needs attention",
    );
  });
  it("uses the server sync floor when the payment register opens on an older month", async () => {
    const { controller, abort } = mount();
    await controller.activate(abort.signal);
    controller.update({ ...report, month: "2026-09" });
    expect(el<HTMLInputElement>("input[name=from]").value).toBe("2026-10-01");
    expect(el<HTMLInputElement>("input[name=to]").value).toBe("2026-10-25");
    expect(el<HTMLInputElement>("input[name=from]").min).toBe("2026-10-01");
  });
});
