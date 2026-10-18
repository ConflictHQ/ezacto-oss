/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeletionRequestsController } from "../src/module-settings/deletion-requests.js";
import { renderDeletionRequests } from "../src/module-settings/deletion-requests-render.js";

const record = {
  id: "request-1",
  user_id: 2,
  requested_at: "2026-10-09T00:00:00.000Z",
  policy_version: 1,
  policy_snapshot: {
    user_notice: "<img src=x onerror=alert(1)>",
    operator_contact: "privacy@example.test",
    retained_records: [],
    backup_handling: "Replay closures.",
  },
  policy_reviewed: false,
  status: "pending",
  version: 1,
  message: "",
  response_target_at: "2026-10-23T00:00:00.000Z",
  expected_completion_at: null,
  completion_confirmation: null,
  completed_at: null,
  notification: "failed",
};
const response = (data: unknown) =>
  new Response(JSON.stringify({ data, links: { next: null } }), {
    headers: { "content-type": "application/json" },
  });
function mount(profile = "administrator", demo = false) {
  document.body.innerHTML = renderDeletionRequests();
  const abort = new AbortController();
  const active = {
    identity: { profile },
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
  const controller = createDeletionRequestsController(document.body, demo);
  const select = () =>
    document
      .querySelector<HTMLButtonElement>("[data-deletion-list] button")!
      .click();
  const form = document.querySelector<HTMLFormElement>("[data-deletion-form]")!;
  return { controller, active, abort, select, form };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
describe("operator deletion request queue", () => {
  it("retries a lost settings write under one key after the instance advertises replay support", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const advertised = { "idempotency-key-lifetime": "86400" };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [record], links: { next: null } }), { headers: advertised }))
      .mockRejectedValueOnce(new TypeError("response lost after commit"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { ...record, version: 2, message: "Reviewing." } }), { headers: { ...advertised, "idempotent-replayed": "true" } }));
    vi.stubGlobal("fetch", fetch);
    const { controller, active, select, form } = mount();
    await controller.load(active);
    select();
    (form.elements.namedItem("message") as HTMLTextAreaElement).value = "Reviewing.";
    form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector("[data-deletion-result]")!.textContent).toContain("Request updated"));
    expect(fetch).toHaveBeenCalledTimes(3);
    const first = fetch.mock.calls[1]![1] as RequestInit;
    const second = fetch.mock.calls[2]![1] as RequestInit;
    const key = new Headers(first.headers).get("idempotency-key");
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(new Headers(second.headers).get("idempotency-key")).toBe(key);
    expect(first.method).toBe("PATCH");
    expect(second.method).toBe("PATCH");
    expect(first.body).toBe(second.body);
    expect(first.credentials).toBe("same-origin");
  });
  it("shows captured disclosure safely and distinguishes a response target from completion", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response([record])),
    );
    const { controller, active, select, form } = mount();
    await controller.load(active);
    select();
    expect(
      document.querySelector("[data-deletion-disclosure]")!.textContent,
    ).toContain(record.policy_snapshot.user_notice);
    expect(document.querySelector("[data-deletion-disclosure] img")).toBeNull();
    expect(document.body.textContent).toContain(
      "client did not confirm reviewing it",
    );
    expect(document.body.textContent).toContain("Initial response target");
    expect(form.querySelector('option[value="completed"]')).toBeNull();
    expect(
      (form.elements.namedItem("completion_date") as HTMLInputElement).value,
    ).toBe("");
  });
  it("keeps user edits after a stale-version refusal", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response([record]))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "stale_request",
              message: "This request changed. Reload before saving.",
            },
          }),
          { status: 409 },
        ),
      );
    vi.stubGlobal("fetch", fetch);
    const { controller, active, select, form } = mount();
    await controller.load(active);
    select();
    const message = form.elements.namedItem("message") as HTMLTextAreaElement;
    message.value = "Please transfer ownership.";
    form.dispatchEvent(
      new Event("submit", { cancelable: true, bubbles: true }),
    );
    await vi.waitFor(() =>
      expect(
        document.querySelector("[data-deletion-result]")!.textContent,
      ).toContain("Reload"),
    );
    expect(message.value).toBe("Please transfer ownership.");
    expect(JSON.parse(fetch.mock.calls[1]![1].body)).toMatchObject({
      expected_version: 1,
      message: "Please transfer ownership.",
      expected_completion_at: null,
    });
  });
  it("keeps saved state and version when navigating between requests", async () => {
    const updated = { ...record, version: 2, status: 'in_progress', message: 'Reviewing.' };
    const fetch = vi.fn().mockResolvedValueOnce(response([record, { ...record, id: 'request-2', user_id: 3 }])).mockResolvedValueOnce(response(updated)).mockResolvedValueOnce(response({ ...updated, version: 3 }));
    vi.stubGlobal('fetch', fetch);
    const { controller, active, select, form } = mount();
    await controller.load(active); select();
    (form.elements.namedItem('message') as HTMLTextAreaElement).value = 'Reviewing.';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(document.querySelector('[data-deletion-result]')!.textContent).toContain('Request updated'));
    const buttons = document.querySelectorAll<HTMLButtonElement>('[data-deletion-list] button');
    expect(buttons[0]!.textContent).toContain('in progress');
    buttons[1]!.click(); buttons[0]!.click();
    expect((form.elements.namedItem('message') as HTMLTextAreaElement).value).toBe('Reviewing.');
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(JSON.parse(fetch.mock.calls[2]![1].body).expected_version).toBe(2);
  });
  it("preserves unsaved edits and their version while retrying a notification", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response([record])).mockResolvedValueOnce(response({ ...record, notification: 'queued', version: 2, message: 'A concurrent operator edit.' })).mockResolvedValueOnce(response(record));
    vi.stubGlobal('fetch', fetch);
    const { controller, active, select, form } = mount();
    await controller.load(active); select();
    const message = form.elements.namedItem('message') as HTMLTextAreaElement;
    const date = form.elements.namedItem('completion_date') as HTMLInputElement;
    message.value = 'My unsaved draft.'; date.value = '2026-10-30';
    document.querySelector<HTMLButtonElement>('[data-deletion-retry]')!.click();
    await vi.waitFor(() => expect(document.querySelector('[data-deletion-result]')!.textContent).toContain('Notification status'));
    expect(message.value).toBe('My unsaved draft.'); expect(date.value).toBe('2026-10-30');
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(JSON.parse(fetch.mock.calls[2]![1].body)).toMatchObject({ expected_version: 1, message: 'My unsaved draft.', expected_completion_at: '2026-10-30T23:59:59.000Z' });
  });
  it("does not load requests for an executive and refuses demo writes", async () => {
    const fetch = vi.fn(async () => response([record]));
    vi.stubGlobal("fetch", fetch);
    const viewer = mount("executive");
    await viewer.controller.load(viewer.active);
    expect(fetch).not.toHaveBeenCalled();
    const demo = mount("administrator", true);
    await demo.controller.load(demo.active);
    demo.select();
    demo.form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(
      document.querySelector<HTMLButtonElement>("[data-deletion-retry]")!
        .disabled,
    ).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("removes private request data on logout and refuses stale presentation", async () => {
    let deliver: ((value: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            deliver = resolve;
          }),
      ),
    );
    const { controller, active, abort } = mount();
    const pending = controller.load(active);
    abort.abort();
    controller.clear();
    deliver!(response([record]));
    await pending;
    expect(
      document.querySelector("[data-deletion-list]")!.children,
    ).toHaveLength(0);
    expect(
      document.querySelector<HTMLElement>("[data-deletion-requests]")!.hidden,
    ).toBe(true);
  });
});

it("keeps the due queue usable after refresh and retains completion feedback across the parent reload", async () => {
  const obligation = {
    request_id: record.id,
    area: "apple_authorization",
    kind: "downstream",
    original_reason: "Protected fixture.",
    original_period: "Until reviewed.",
    decision: "not_applicable",
    basis: "",
    release_condition: "",
    evidence: "Verified fixture has no Apple identity.",
    next_review_at: null,
    hold_active: false,
    version: 2,
    reviewed_at: null,
    actor_user_id: null,
  };
  const confirmation =
    "Local closure reviewed. Required work attribution remains retained.";
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response([record]))
    .mockResolvedValueOnce(response([record]))
    .mockResolvedValueOnce(response([obligation]))
    .mockResolvedValueOnce(
      response({ completed_at: "2026-10-09T00:00:00.000Z", confirmation }),
    )
    .mockResolvedValueOnce(
      response([
        {
          ...record,
          status: "completed",
          completion_confirmation: confirmation,
        },
      ]),
    );
  vi.stubGlobal("fetch", fetch);
  const { controller, active, select } = mount();
  await controller.load(active);
  document.querySelector<HTMLButtonElement>("[data-deletion-refresh]")!.click();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  await vi.waitFor(() =>
    expect(
      document.querySelector<HTMLButtonElement>("[data-deletion-refresh]")!
        .disabled,
    ).toBe(false),
  );
  expect(
    document.querySelector<HTMLButtonElement>("[data-retention-due]")!.disabled,
  ).toBe(false);
  select();
  document.querySelector<HTMLButtonElement>("[data-retention-load]")!.click();
  await vi.waitFor(() =>
    expect(
      document.querySelector("[data-retention-content] > form"),
    ).not.toBeNull(),
  );
  const complete = document.querySelector<HTMLFormElement>(
    "[data-retention-content] > form",
  )!;
  complete.querySelector<HTMLInputElement>("input[required]")!.checked = true;
  complete.dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true }),
  );
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(5));
  await vi.waitFor(() =>
    expect(
      document.querySelector("[data-deletion-list]")!.textContent,
    ).toContain("completed"),
  );
  expect(document.querySelector("[data-retention-status]")!.textContent).toBe(
    confirmation,
  );
  expect(
    document.querySelector<HTMLButtonElement>("[data-retention-due]")!.disabled,
  ).toBe(false);
});
