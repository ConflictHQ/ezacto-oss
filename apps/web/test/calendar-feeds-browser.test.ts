/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCalendarFeedsController } from "../src/capacity/calendar-feeds-browser.js";
const feed = {
  id: "a".repeat(32),
  scope: "self" as const,
  project_id: null,
  from_date: "2026-10-05",
  through_date: "2026-10-11",
  include_names: false,
  issued_at: "2026-10-05T00:00:00.000Z",
  expires_at: "2026-11-04T00:00:00.000Z",
  revoked_at: null,
  credential_generation: 1,
};
const issued = { feed, username: feed.id, password: "b".repeat(43) };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
beforeEach(() => {
  document.body.innerHTML = "<main></main>";
});
const fixture = () => {
  const api = {
    list: vi.fn(async () => [feed]),
    create: vi.fn(async () => issued),
    rotate: vi.fn(async () => issued),
    revoke: vi.fn(async () => {}),
    download: vi.fn(async () => new Blob(["ics"])),
  };
  const controller = createCalendarFeedsController(
      document.querySelector("main")!,
      api,
    ),
    active = new AbortController();
  return {
    api,
    controller,
    active,
    form: () => document.querySelector("form")!,
    status: () => document.querySelector("[role=status]")!,
  };
};
describe("owned calendar subscription controls", () => {
  it("keeps actions disabled until the owning session activates the panel", () => {
    fixture();
    expect((document.querySelector('button[type="submit"]') as HTMLButtonElement).disabled).toBe(true);
  });
  it("defaults to minimized self scope and discloses fields, lifetime and credential delivery", async () => {
    const f = fixture();
    await f.controller.activate(f.active.signal, false, {
      from: "2026-10-05",
      to: "2026-10-11",
    });
    expect(
      (document.querySelector("[name=scope]") as HTMLSelectElement).value,
    ).toBe("self");
    expect(
      (document.querySelector("[name=include_names]") as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(document.body.textContent).toContain(
      "no tracked time, rates, money, private notes or leave reasons",
    );
    f.form().dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await flush();
    expect(f.api.create).toHaveBeenCalledWith(
      {
        scope: "self",
        project_id: null,
        from_date: "2026-10-05",
        through_date: "2026-10-11",
        include_names: false,
      },
      f.active.signal,
    );
  });
  it("guards duplicate requests, clears secrets on session abort and ignores a late response", async () => {
    const f = fixture();
    await f.controller.activate(f.active.signal, true, {
      from: "2026-10-05",
      to: "2026-10-11",
      project_id: 7,
    });
    let finish!: (value: typeof issued) => void;
    f.api.create.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    f.form().dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    f.form().dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
    await flush();
    expect(f.api.create).toHaveBeenCalledTimes(1);
    expect(f.status().getAttribute("aria-busy")).toBe("true");
    f.active.abort();
    finish(issued);
    await flush();
    expect(
      document.querySelector("[data-calendar-feed-secret]")!.textContent,
    ).toBe("");
  });
  it("keeps subscription URL free of credentials and rotates/revokes through explicit row controls", async () => {
    const f = fixture();
    await f.controller.activate(f.active.signal, true, {
      from: "2026-10-05",
      to: "2026-10-11",
    });
    const rotate = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Rotate password",
    )!;
    rotate.click();
    await flush();
    const values = [
      ...document.querySelectorAll("[data-calendar-feed-secret] input"),
    ].map((i) => (i as HTMLInputElement).value);
    expect(values[0]).toMatch(/\/calendar\/planning\.ics$/);
    expect(values[0]).not.toContain(issued.password);
    expect(values[1]).toBe(issued.username);
    expect(values[2]).toBe(issued.password);
    const revoke = [...document.querySelectorAll("button")].find(
      (b) => b.textContent === "Revoke subscription",
    )!;
    revoke.click();
    await flush();
    expect(f.api.revoke).toHaveBeenCalledWith(feed.id, f.active.signal);
    expect(
      document.querySelector("[data-calendar-feed-secret]")!.textContent,
    ).toBe("");
  });
});
