/** @vitest-environment happy-dom */

import { EzactoApiError, type BackupRun } from "@conflict-hq/ezacto-client";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  browserApi,
  mountShell,
  renderBrowserShell,
} from "./support/shell-harness.js";

/**
 * Settings > Company > Backups: the download link (issue 39). Its own file, not
 * shell-company-settings.test.ts, for the heap reason given in
 * shell-company-settings-notifications.test.ts.
 */
describe("company settings: backup download link", () => {
  const run: BackupRun = {
    id: 7,
    status: "completed",
    trigger: "nightly",
    table_count: 12,
    started_at: "2026-10-18T03:00:00.000Z",
    completed_at: "2026-10-18T03:01:00.000Z",
    total_rows: 120,
    r2_prefix: "backups/2026-10-18/",
    error_message: null,
  };

  const status = (completed: boolean) => ({
    last_completed: completed ? run : null,
    last_failed: null,
    has_failure: false,
    recent_runs: completed ? [run] : [],
  });

  const apiError = (httpStatus: number, code: string) =>
    new EzactoApiError(httpStatus, { error: { code, message: code } }, null);

  const stubFetch = (): void => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
  };

  const link = {
    id: 3,
    run_id: 7,
    url: "/backup-download/secret-token",
    expires_at: "2026-10-19T12:10:00.000Z",
  };

  afterEach(async () => {
    globalThis.location.hash = "";
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
    vi.unstubAllGlobals();
  });

  const open = async (
    mint: Mock<(input: { readonly code?: string }) => Promise<typeof link>>,
    completed = true,
    profile: "administrator" | "member" = "administrator",
  ) => {
    stubFetch();
    renderBrowserShell({ view: "settings-company" });
    globalThis.location.hash = "#backup";
    const base = browserApi();
    await mountShell({
      ...base,
      whoami: vi.fn(async () => ({ ...(await base.whoami()), profile })),
      getBackupStatus: vi.fn(async () => status(completed)),
      createBackupDownloadLink: mint,
    });
    const panel = document.querySelector<HTMLElement>(
      "[data-settings-backup-download]",
    )!;
    if (profile === "administrator")
      await vi.waitFor(() => expect(panel.hidden).toBe(false));
    return {
      panel,
      button: document.querySelector<HTMLButtonElement>(
        "[data-backup-download-mint]",
      )!,
      codeRow: document.querySelector<HTMLElement>(
        "[data-backup-download-code-row]",
      )!,
      code: document.querySelector<HTMLInputElement>(
        "[data-backup-download-code]",
      )!,
      result: document.querySelector<HTMLElement>(
        "[data-backup-download-result]",
      )!,
      linkRow: document.querySelector<HTMLElement>(
        "[data-backup-download-link-row]",
      )!,
      linkBox: document.querySelector<HTMLInputElement>(
        "[data-backup-download-link]",
      )!,
    };
  };

  it("[browser issue 39] warns about credential hashes and shows the link and its expiry", async () => {
    const mint = vi.fn(async () => link);
    const { panel, button, result, linkRow, linkBox } = await open(mint);
    expect(panel.textContent).toContain("password hashes");
    expect(button.disabled).toBe(false);
    button.click();
    await vi.waitFor(() => expect(linkRow.hidden).toBe(false));
    expect(mint).toHaveBeenCalledWith({}, expect.any(AbortSignal));
    expect(linkBox.value).toMatch(/\/backup-download\/secret-token$/u);
    expect(result.textContent).toContain("works once");
  });

  it("[browser issue 39] is disabled with an explanation when no run has completed", async () => {
    const mint = vi.fn(async () => link);
    const { button, result } = await open(mint, false);
    expect(button.disabled).toBe(true);
    expect(result.textContent).toContain("no completed backup");
    expect(mint).not.toHaveBeenCalled();
  });

  it("[browser issue 39] asks for a verification code when the server requires one, and sends it", async () => {
    const mint = vi
      .fn()
      .mockRejectedValueOnce(apiError(401, "two_factor_code_required"))
      .mockResolvedValueOnce(link);
    const { button, codeRow, code, result, linkRow } = await open(mint);
    expect(codeRow.hidden).toBe(true);
    button.click();
    await vi.waitFor(() => expect(codeRow.hidden).toBe(false));
    expect(result.textContent).toContain("verification code");
    code.value = "123456";
    button.click();
    await vi.waitFor(() => expect(linkRow.hidden).toBe(false));
    expect(mint).toHaveBeenLastCalledWith({ code: "123456" }, expect.any(AbortSignal));
    expect(code.value).toBe("");
  });

  it("[browser issue 39] says a wrong code is wrong and shows no link", async () => {
    const mint = vi
      .fn()
      .mockRejectedValue(apiError(401, "invalid_two_factor_code"));
    const { button, result, linkRow } = await open(mint);
    button.click();
    await vi.waitFor(() => expect(result.textContent).toContain("incorrect"));
    expect(linkRow.hidden).toBe(true);
  });

  it("[security issue 39] offers nothing to a non-administrator", async () => {
    const mint = vi.fn(async () => link);
    const { panel } = await open(mint, true, "member");
    expect(panel.hidden).toBe(true);
    expect(mint).not.toHaveBeenCalled();
  });
});
