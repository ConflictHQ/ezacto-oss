/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRetentionController,
  renderRetentionSection,
} from "../src/module-settings/retention.js";

const policy = {
  frameworks: ["colorado_cpa"],
  retained_records: [
    {
      category: "time_and_worker_attribution",
      reason: "Documented accounting obligation",
      period: "Until the obligation expires, measured from invoice settlement",
      review_after_days: 30,
    },
  ],
  response_target_days: 14,
  operator_contact: "privacy@example.test",
  user_notice: "<script>no HTML</script>",
  backup_handling: "Replay closures before restoration.",
  acknowledged: true,
};
const record = { version: 3, policy, published_at: "2026-10-09T00:00:00.000Z" };
const response = (data: unknown) =>
  new Response(JSON.stringify({ data }), {
    headers: { "content-type": "application/json" },
  });
const mount = (demo = false, profile = "administrator") => {
  document.body.innerHTML = renderRetentionSection();
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
  const controller = createRetentionController(document.body, demo);
  return { controller, active, abort, form: document.querySelector("form")! };
};
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
describe("operator erasure and retention form", () => {
  it("loads actual saved categories with fresh acknowledgement and safe text rendering", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response(record)),
    );
    const { controller, active, form } = mount();
    await controller.load(active);
    expect(
      (
        form.elements.namedItem(
          "retain-time_and_worker_attribution",
        ) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      (form.elements.namedItem("retain-legal_hold") as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(
      (form.elements.namedItem("acknowledged") as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (form.elements.namedItem("user_notice") as HTMLTextAreaElement).value,
    ).toBe(policy.user_notice);
    expect(document.querySelector("script")).toBeNull();
  });
  it("requires acknowledgement, publishes the loaded version, and preserves justified categories", async () => {
    const fetcher = vi.fn(async (_path: unknown, options?: RequestInit) =>
      response(options?.method === "POST" ? { ...record, version: 4 } : record),
    );
    vi.stubGlobal("fetch", fetcher);
    const { controller, active, form } = mount();
    await controller.load(active);
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(fetcher).toHaveBeenCalledTimes(1);
    (form.elements.namedItem("acknowledged") as HTMLInputElement).checked =
      true;
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() =>
      expect(
        document.querySelector("[data-retention-result]")?.textContent,
      ).toContain("Policy published"),
    );
    const sent = JSON.parse(fetcher.mock.calls[1]![1]!.body as string);
    expect(sent).toEqual({ expected_version: 3, policy });
    expect(
      (form.elements.namedItem("acknowledged") as HTMLInputElement).checked,
    ).toBe(false);
  });
  it("preserves edits on conflict and clears private drafts on session change", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_path: unknown, options?: RequestInit) =>
        options?.method === "POST"
          ? new Response(
              JSON.stringify({
                error: {
                  code: "stale_policy",
                  message: "The policy changed. Reload it before saving.",
                  fields: [],
                },
              }),
              { status: 409 },
            )
          : response(record),
      ),
    );
    const { controller, active, form } = mount();
    await controller.load(active);
    (form.elements.namedItem("acknowledged") as HTMLInputElement).checked =
      true;
    (form.elements.namedItem("user_notice") as HTMLTextAreaElement).value =
      "My revised disclosure";
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    await vi.waitFor(() =>
      expect(
        document.querySelector("[data-retention-result]")?.textContent,
      ).toContain("Reload"),
    );
    expect(
      (form.elements.namedItem("user_notice") as HTMLTextAreaElement).value,
    ).toBe("My revised disclosure");
    controller.clear();
    expect(form.hidden).toBe(true);
    expect(
      (form.elements.namedItem("user_notice") as HTMLTextAreaElement).value,
    ).toBe("");
  });
  it.each([
    [true, "administrator"],
    [false, "executive_manager"],
  ])("refuses writes on demo=%s, role=%s", async (demo, profile) => {
    const fetcher = vi.fn(async () => response(record));
    vi.stubGlobal("fetch", fetcher);
    const { controller, active, form } = mount(demo, profile);
    await controller.load(active);
    (form.elements.namedItem("acknowledged") as HTMLInputElement).checked =
      true;
    form.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

it("lists all states, preserves choices hidden by search, and shows saved selections on reload", async () => {
  const fetcher = vi.fn(async (_path: unknown, options?: RequestInit) =>
    response(options?.method === "POST" ? { ...record, version: 4 } : record),
  );
  vi.stubGlobal("fetch", fetcher);
  const { controller, active, form } = mount();
  await controller.load(active);
  const states = form.querySelector<HTMLDetailsElement>(
    "[data-privacy-states]",
  )!;
  expect(states.open).toBe(true);
  expect(states.querySelectorAll('[name="framework"]')).toHaveLength(51);
  const search = form.querySelector<HTMLInputElement>("[data-privacy-filter]")!;
  search.value = "Alaska";
  search.dispatchEvent(new Event("input"));
  expect(
    [
      ...states.querySelectorAll<HTMLElement>("[data-privacy-framework]"),
    ].filter((row) => !row.hidden),
  ).toHaveLength(1);
  expect(
    form.querySelector<HTMLInputElement>('[value="colorado_cpa"]')!.checked,
  ).toBe(true);
  form.querySelector<HTMLInputElement>('[value="us_ak"]')!.checked = true;
  (form.elements.namedItem("acknowledged") as HTMLInputElement).checked = true;
  form.dispatchEvent(new Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  const sent = JSON.parse(fetcher.mock.calls[1]![1]!.body as string);
  expect(sent.policy.frameworks).toEqual(["us_ak", "colorado_cpa"]);
  expect(sent.policy.retained_records).toEqual(policy.retained_records);
});
