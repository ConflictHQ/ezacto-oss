/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserApi,
  mountShell,
  renderBrowserShell,
} from "./support/shell-harness.js";

/**
 * Settings > Company sections of a module the operator switched off (issue
 * 1254): SSO and Invoices (with its Reminders). Its own file, not
 * shell-company-settings.test.ts, for the heap reason given in
 * shell-company-settings-notifications.test.ts. Backups and Accounting have
 * their own files, and run through the same code.
 */
describe("company settings: operator-disabled modules", () => {
  afterEach(async () => {
    globalThis.location.hash = "";
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    for (const module of ["sso", "invoices"]) {
      document.documentElement.removeAttribute(`data-${module}-unavailable`);
    }
    vi.unstubAllGlobals();
  });

  const open = async (module: "sso" | "invoices" | null, hash: string) => {
    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        fetched.push(String(input instanceof Request ? input.url : input));
        return new Response(JSON.stringify({ data: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );
    renderBrowserShell({ view: "settings-company" });
    if (module !== null) document.documentElement.setAttribute(`data-${module}-unavailable`, "");
    globalThis.location.hash = hash;
    const base = browserApi();
    const listSsoDomains = vi.fn(async () => ({ data: [] }));
    const getInvoiceDefaults = vi.fn(async () => ({}));
    const getInvoiceReminders = vi.fn(async () => ({}));
    await mountShell({
      ...base,
      whoami: vi.fn(async () => ({ ...(await base.whoami()), profile: "administrator" as const })),
      listSsoDomains,
      getInvoiceDefaults,
      getInvoiceReminders,
    } as never);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
    return { fetched, listSsoDomains, getInvoiceDefaults, getInvoiceReminders };
  };

  const section = (id: string) =>
    document.querySelector<HTMLElement>(`[data-settings-section="${id}"]`)!;
  const link = (id: string) =>
    document.querySelector<HTMLElement>(`[data-settings-section-link="${id}"]`)!;

  it("[browser issue 1254] withdraws SSO, sends its deep link to the default section and asks nothing of it", async () => {
    const { fetched, listSsoDomains } = await open("sso", "#sso");
    expect(link("sso").hidden).toBe(true);
    expect(section("sso").hidden).toBe(true);
    expect(section("sso").hasAttribute("data-settings-unavailable")).toBe(true);
    expect(section("modules").hidden).toBe(false);
    expect(link("modules").hidden).toBe(false);
    expect(listSsoDomains).not.toHaveBeenCalled();
    expect(fetched.filter((url) => url.includes("sso-domains"))).toEqual([]);
  });

  it("[browser issue 1254] withdraws Invoices and Reminders and asks nothing of either", async () => {
    for (const hash of ["#invoices", "#reminders"]) {
      const { fetched, getInvoiceDefaults, getInvoiceReminders } = await open("invoices", hash);
      for (const id of ["invoices", "reminders"]) {
        expect(link(id).hidden).toBe(true);
        expect(section(id).hidden).toBe(true);
      }
      expect(section("modules").hidden).toBe(false);
      expect(getInvoiceDefaults).not.toHaveBeenCalled();
      expect(getInvoiceReminders).not.toHaveBeenCalled();
      expect(fetched.filter((url) => /invoice-(defaults|reminders)/u.test(url))).toEqual([]);
      document.body.innerHTML = "";
      document.documentElement.removeAttribute("data-invoices-unavailable");
    }
  });

  it("[browser issue 1254] leaves every section as it was where no module is switched off", async () => {
    const { getInvoiceDefaults } = await open(null, "#invoices");
    expect(link("invoices").hidden).toBe(false);
    expect(section("invoices").hidden).toBe(false);
    expect(getInvoiceDefaults).toHaveBeenCalled();
  });
});
