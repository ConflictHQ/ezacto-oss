/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  AccountClosurePreview,
  AccountDeletionRecord,
} from "@ezacto/core";
import { createAccountClosureController } from "../src/module-settings/account-closure.js";
import { renderDeletionRequests } from "../src/module-settings/deletion-requests-render.js";
const policy = {
  frameworks: [],
  retained_records: [],
  response_target_days: 14,
  operator_contact: "privacy@example.test",
  user_notice: "<img src=x onerror=alert(1)>",
  backup_handling: "Replay closure before restoring service.",
  acknowledged: true as const,
};
const preview: AccountClosurePreview = {
  request_id: "request-1",
  user_id: 2,
  request_version: 4,
  review_token: "a".repeat(64),
  policy_version: 3,
  policy_snapshot: policy,
  inventory: [],
  uncovered_categories: [],
  owner_transfer_required: false,
  running_timer: false,
  closure: null,
};
const record = { id: "request-1", status: "pending" } as AccountDeletionRecord;
const response = (data: unknown) =>
  new Response(JSON.stringify({ data }), {
    headers: { "content-type": "application/json" },
  });
function mount(demo = false) {
  document.body.innerHTML = renderDeletionRequests();
  const abort = new AbortController();
  const active = {
    identity: { profile: "administrator" },
    signal: abort.signal,
    present: (show: () => void) => {
      if (abort.signal.aborted) return false;
      show();
      return true;
    },
    presentFailure: (_error: unknown, show: () => void) => {
      if (abort.signal.aborted) return false;
      show();
      return true;
    },
  };
  const closed = vi.fn();
  const controller = createAccountClosureController(
    document.body,
    demo,
    closed,
  );
  controller.select(active, record);
  const review = document.querySelector<HTMLButtonElement>(
    "[data-closure-review]",
  )!;
  const form = document.querySelector<HTMLFormElement>("[data-closure-form]")!;
  const checkbox = form.elements.namedItem("acknowledged") as HTMLInputElement;
  return { controller, active, closed, review, form, checkbox };
}
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
describe("operator account closure review", () => {
  it("requires explicit acknowledgement and submits exactly the reviewed policy and request versions", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(preview))
      .mockResolvedValueOnce(response({ request_id: "request-1", user_id: 2 }));
    vi.stubGlobal("fetch", fetch);
    const { review, form, checkbox, closed } = mount();
    review.click();
    await vi.waitFor(() => expect(form.hidden).toBe(false));
    expect(document.querySelector("[data-closure-inventory] img")).toBeNull();
    expect(document.body.textContent).toContain(policy.user_notice);
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(fetch).toHaveBeenCalledTimes(1);
    checkbox.checked = true;
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(closed).toHaveBeenCalledOnce());
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({
      expected_version: 4,
      expected_policy_version: 3,
      review_token: "a".repeat(64),
      acknowledged: true,
    });
    expect(
      document.querySelector("[data-closure-result]")!.textContent,
    ).toContain("external cleanup remain under review");
  });
  it("blocks closure for ownership, running time and undocumented actual retention", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        response({
          ...preview,
          owner_transfer_required: true,
          running_timer: true,
          uncovered_categories: ["time_and_worker_attribution"],
        }),
      ),
    );
    const { review, form } = mount();
    review.click();
    await vi.waitFor(() =>
      expect(
        document.querySelector("[data-closure-result]")!.textContent,
      ).toContain("Review complete"),
    );
    expect(form.hidden).toBe(true);
    expect(document.body.textContent).toContain("transfer ownership");
    expect(document.body.textContent).toContain("running timer");
    expect(document.body.textContent).toContain(
      "Do not select a category merely",
    );
  });
  it("retries configured web cleanup after closure without claiming complete erasure", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({...preview,apple_cleanup_retry_available:true,closure:{request_id:"request-1",user_id:2,actor_user_id:1,closed_at:"2026-10-09T00:00:00.000Z",policy_version:3,policy_snapshot:policy,inventory:[],retained_identity:false,apple_cleanup:"pending"}})).mockResolvedValueOnce(response({apple_cleanup:"revoked"}));
    vi.stubGlobal("fetch",fetch);
    const {review,closed}=mount();
    review.click();
    await vi.waitFor(()=>expect(document.body.textContent).toContain("Retry server-managed Apple cleanup"));
    const retry=Array.from(document.querySelectorAll("button")).find(button=>button.textContent==="Retry server-managed Apple cleanup")!;
    retry.click();
    await vi.waitFor(()=>expect(document.body.textContent).toContain("Apple cleanup confirmed. Retained records still require review."));
    expect(fetch.mock.calls[1]![0]).toBe("/api/v1/admin/deletion-requests/request-1/apple-cleanup");
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({});
    expect(closed).not.toHaveBeenCalled();
  });
  it("does not replace another selection with a late preview and keeps demo read-only", async () => {
    let finish: (response: Response) => void = () => undefined;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const { controller, active, review, form } = mount();
    review.click();
    controller.select(active, { ...record, id: "request-2" });
    finish(response(preview));
    await Promise.resolve();
    await Promise.resolve();
    expect(form.hidden).toBe(true);
    expect(
      document.querySelector("[data-closure-inventory]")!.textContent,
    ).toBe("");
    const demo = mount(true);
    demo.review.click();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
