/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserApi,
  mountShell,
  renderBrowserShell,
} from "./support/shell-harness.js";

/**
 * Settings > Company > Backups where the platform backs the tenant up (issue
 * 1216). Its own file, not shell-company-settings.test.ts, for the heap reason
 * given in shell-company-settings-notifications.test.ts.
 */
describe("company settings: backups unavailable", () => {
  afterEach(async () => {
    globalThis.location.hash = "";
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    document.documentElement.removeAttribute("data-backups-unavailable");
    vi.unstubAllGlobals();
  });

  const open = async (unavailable: boolean) => {
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
    if (unavailable) document.documentElement.setAttribute("data-backups-unavailable", "");
    globalThis.location.hash = "#backup";
    const base = browserApi();
    const getBackupStatus = vi.fn(async () => ({
      last_completed: null,
      last_failed: null,
      has_failure: false,
      recent_runs: [],
    }));
    const listBackupRuns = vi.fn(async () => ({ data: [], meta: { next_cursor: null } }));
    const createBackupDownloadLink = vi.fn();
    await mountShell({
      ...base,
      whoami: vi.fn(async () => ({ ...(await base.whoami()), profile: "administrator" as const })),
      getBackupStatus,
      listBackupRuns,
      createBackupDownloadLink,
    } as never);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
    return { fetched, getBackupStatus, listBackupRuns, createBackupDownloadLink };
  };

  const section = () =>
    document.querySelector<HTMLElement>('[data-settings-section="backup"]')!;
  const link = () =>
    document.querySelector<HTMLElement>('[data-settings-section-link="backup"]')!;

  it("[browser issue 1216] hides the section and its link and requests nothing from the backup endpoints", async () => {
    const { fetched, getBackupStatus, listBackupRuns, createBackupDownloadLink } = await open(true);
    expect(link().hidden).toBe(true);
    expect(section().hidden).toBe(true);
    expect(section().hasAttribute("data-settings-unavailable")).toBe(true);
    expect(
      document.querySelector('[data-settings-section="modules"]')?.hasAttribute("hidden"),
    ).toBe(false);
    expect(getBackupStatus).not.toHaveBeenCalled();
    expect(listBackupRuns).not.toHaveBeenCalled();
    expect(createBackupDownloadLink).not.toHaveBeenCalled();
    expect(fetched.filter((url) => url.includes("/backup"))).toEqual([]);
  });

  it("[browser issue 1216] leaves the section as it was where backups are available", async () => {
    const { getBackupStatus } = await open(false);
    expect(link().hidden).toBe(false);
    expect(section().hidden).toBe(false);
    expect(getBackupStatus).toHaveBeenCalled();
  });
});
