/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from "vitest";
import type { AccountDeletionRecord, RetentionObligation } from "@ezacto/core";
import { createRetentionReviewController } from "../src/module-settings/retention-review.js";
import { renderDeletionRequests } from "../src/module-settings/deletion-requests-render.js";
const row: RetentionObligation = {
  request_id: "request-one",
  area: "backups",
  kind: "downstream",
  original_reason: "<img src=x onerror=alert(1)>",
  original_period: "Until verified disposal.",
  decision: "pending",
  basis: "",
  release_condition: "",
  evidence: "",
  next_review_at: null,
  hold_active: false,
  version: 1,
  reviewed_at: null,
  actor_user_id: null,
};
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
  const done = vi.fn();
  const controller = createRetentionReviewController(document.body, demo, done);
  controller.select(active, {
    id: "request-one",
    status: "action_required",
    version: 2,
  } as AccountDeletionRecord);
  document.querySelector<HTMLButtonElement>("[data-retention-load]")!.click();
  return { abort, done };
}
const form = (area: string) =>
  document.querySelector<HTMLFormElement>(`form[data-area="${area}"]`)!;
const submit = (form: HTMLFormElement) =>
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
it("escapes disclosure and preserves a different area draft when one review is saved", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response([row, { ...row, area: "attachments" }]))
    .mockResolvedValueOnce(
      response({ ...row, version: 2, decision: "removed" }),
    );
  vi.stubGlobal("fetch", fetch);
  mount();
  await vi.waitFor(() => expect(form("backups")).not.toBeNull());
  expect(document.querySelector("[data-retention-content] img")).toBeNull();
  const other = form("attachments").elements.namedItem(
    "evidence",
  ) as HTMLTextAreaElement;
  other.value = "Unsaved protected attachment evidence.";
  const selected = form("backups");
  (selected.elements.namedItem("decision") as HTMLSelectElement).value =
    "removed";
  (selected.elements.namedItem("evidence") as HTMLTextAreaElement).value =
    "Removal verified against the protected backup inventory.";
  (selected.elements.namedItem("acknowledged") as HTMLInputElement).checked =
    true;
  submit(selected);
  await vi.waitFor(() =>
    expect(
      document.querySelector("[data-retention-status]")!.textContent,
    ).toContain("Review recorded"),
  );
  expect(
    (form("attachments").elements.namedItem("evidence") as HTMLTextAreaElement)
      .value,
  ).toBe("Unsaved protected attachment evidence.");
  expect(JSON.parse(fetch.mock.calls[1]![1].body)).toMatchObject({
    expected_version: 1,
    decision: "removed",
    acknowledged: true,
  });
});
it("keeps a failed review draft and disables demo mutations", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response([row]))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { code: "review_changed", message: "Reload this review." },
        }),
        { status: 409 },
      ),
    );
  vi.stubGlobal("fetch", fetch);
  mount();
  await vi.waitFor(() => expect(form("backups")).not.toBeNull());
  const selected = form("backups");
  (selected.elements.namedItem("evidence") as HTMLTextAreaElement).value =
    "Unsaved evidence retained on conflict.";
  (selected.elements.namedItem("acknowledged") as HTMLInputElement).checked =
    true;
  submit(selected);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(
    (form("backups").elements.namedItem("evidence") as HTMLTextAreaElement)
      .value,
  ).toContain("Unsaved");
  fetch.mockResolvedValueOnce(response([row]));
  mount(true);
  await vi.waitFor(() => expect(form("backups")).not.toBeNull());
  expect(form("backups").querySelector("button")!.disabled).toBe(true);
});
it("sends manual historical acknowledgment separately and suppresses stale responses after logout", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      response([
        {
          ...row,
          area: "apple_authorization",
          decision: "removed",
          version: 3,
        },
      ]),
    )
    .mockResolvedValueOnce(
      response({ confirmation: "Historical disconnect manually verified." }),
    );
  vi.stubGlobal("fetch", fetch);
  const { done } = mount();
  await vi.waitFor(() => expect(form("apple_authorization")).not.toBeNull());
  const complete = document.querySelector<HTMLFormElement>(
    "[data-retention-content] > form",
  )!;
  for (const input of complete.querySelectorAll("input")) input.checked = true;
  submit(complete);
  await vi.waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(JSON.parse(fetch.mock.calls[1]![1].body)).toMatchObject({
    apple_historical_manual_verified: true,
    expected_request_version: 2,
    expected_reviews: { apple_authorization: 3 },
  });
  let resolve!: (response: Response) => void;
  fetch.mockImplementationOnce(
    () => new Promise<Response>((r) => (resolve = r)),
  );
  const next = mount();
  next.abort.abort();
  resolve(response([row]));
  await Promise.resolve();
  expect(form("backups")).toBeNull();
});
