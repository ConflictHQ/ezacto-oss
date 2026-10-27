/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BankDeposit,
  BankReviewInvoice,
  Whoami,
} from "@conflict-hq/ezacto-client";
import { createBankDepositController } from "../src/bank-deposits/browser.js";
import { renderBankDepositPage } from "../src/bank-deposits/render.js";
import type { BankDepositApi } from "../src/bank-deposits/model.js";
const invoice: BankReviewInvoice = {
  id: 2,
  number: "INV-2",
  currency: "USD",
  due_amount_cents: 1200,
  version: 4,
  state: "sent",
};
const row = (extra: Partial<BankDeposit> = {}): BankDeposit => ({
  id: 1,
  account_id: 1,
  account_name: "Example account",
  provider: "mercury",
  provider_transaction_id: "txn-1",
  currency: "USD",
  posted_at: "2026-09-10T01:00:00.000Z",
  amount_cents: 1200,
  memo: "Invoice 2",
  counterparty: "Example client",
  state: "suggested",
  version: 1,
  suggested_invoice: invoice,
  source_status: "final",
  classification: "external_credit",
  source_reason: null,
  verified_at: null,
  verified_by_user_id: null,
  verification_reference: null,
  confirmation_basis: "provider",
  confirmation_ready: true,
  payment_id: null,
  confirmed_invoice_id: null,
  ...extra,
});
const identity = (profile = "administrator") => ({ profile }) as Whoami;
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const pending = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
const find = <T extends HTMLElement = HTMLElement>(key: string): T =>
  document.querySelector<T>(`[data-bank-${key}]`)!;
const submit = (key: string) =>
  find(key).dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true }),
  );
const fixture = (deposit = row()) => {
  const api = {
    bankDepositAccounts: vi
      .fn<BankDepositApi["bankDepositAccounts"]>()
      .mockResolvedValue([
        { id: 1, provider: "mercury", name: "Example account" },
      ]),
    bankDepositList: vi
      .fn<BankDepositApi["bankDepositList"]>()
      .mockResolvedValue({ data: [deposit], total: 1 }),
    bankDepositInvoices: vi
      .fn<BankDepositApi["bankDepositInvoices"]>()
      .mockResolvedValue([invoice]),
    bankDepositAssign: vi
      .fn<BankDepositApi["bankDepositAssign"]>()
      .mockResolvedValue(deposit),
    bankDepositReject: vi
      .fn<BankDepositApi["bankDepositReject"]>()
      .mockResolvedValue(row({ state: "rejected", version: 2 })),
    bankDepositReopen: vi
      .fn<BankDepositApi["bankDepositReopen"]>()
      .mockResolvedValue(row({ state: "unmatched", version: 3 })),
    bankDepositConfirm: vi
      .fn<BankDepositApi["bankDepositConfirm"]>()
      .mockResolvedValue(
        row({
          state: "confirmed",
          payment_id: 5,
          confirmed_invoice_id: 2,
          version: 2,
        }),
      ),
    bankDepositVerify: vi
      .fn<BankDepositApi["bankDepositVerify"]>()
      .mockResolvedValue(
        row({
          source_status: "unknown",
          confirmation_basis: "operator",
          confirmation_ready: true,
          version: 2,
          verified_at: "2026-10-26T00:00:00Z",
          verification_reference: "Statement reference",
        }),
      ),
  };
  const controller = createBankDepositController(api),
    abort = new AbortController();
  return {
    api,
    controller,
    abort,
    activate: () => controller.activate(identity(), abort.signal, () => false),
    open: async () => {
      find("list").querySelector("button")!.click();
      await flush();
    },
  };
};
beforeEach(() => {
  document.documentElement.dataset.appView = "invoice-bank-deposits";
  document.body.innerHTML = renderBankDepositPage("invoice-bank-deposits");
});

describe("bank-deposit review", () => {
  it("loads real API rows, holds duplicate requests and exposes immediate accessible progress", async () => {
    const f = fixture(),
      request = pending<{ data: BankDeposit[]; total: number }>();
    f.api.bankDepositList.mockReturnValueOnce(request.promise);
    const running = f.activate();
    expect(find("status").textContent).toContain("Loading bank deposits");
    expect(find("status").getAttribute("aria-busy")).toBe("true");
    find<HTMLButtonElement>("refresh").click();
    expect(f.api.bankDepositList).toHaveBeenCalledTimes(1);
    request.resolve({ data: [row()], total: 1 });
    await running;
    expect(find("status").getAttribute("aria-busy")).toBe("false");
    expect(find("list").textContent).toContain("Example client");
    await f.open();
    expect(find("facts").textContent).toContain("txn-1");
    expect(find("confirm").hidden).toBe(false);
  });
  it("requires explicit overpayment review and never confirms twice during a pending response", async () => {
    const f = fixture(row({ amount_cents: 1500 })),
      result = pending<BankDeposit>();
    f.api.bankDepositConfirm.mockReturnValueOnce(result.promise);
    await f.activate();
    await f.open();
    submit("confirm");
    expect(f.api.bankDepositConfirm).not.toHaveBeenCalled();
    expect(find("action-status").textContent).toContain("overpayment");
    const checkbox = find<HTMLFormElement>("confirm").elements.namedItem(
      "overpayment",
    ) as HTMLInputElement;
    checkbox.checked = true;
    submit("confirm");
    submit("confirm");
    expect(f.api.bankDepositConfirm).toHaveBeenCalledTimes(1);
    expect(f.api.bankDepositConfirm.mock.calls[0]![2]).toEqual({
      expected_version: 1,
      invoice_id: 2,
      expected_invoice_version: 4,
      confirm_overpayment: true,
    });
    expect(find("action-status").getAttribute("aria-busy")).toBe("true");
    result.resolve(row({ state: "confirmed", version: 2, payment_id: 5 }));
    await flush();
    expect(find("action-status").textContent).toBe(
      "Payment confirmed and recorded.",
    );
    expect(find("confirm").hidden).toBe(true);
  });
  it("uses the same idempotency key and exact body when a response is uncertain", async () => {
    const f = fixture();
    f.api.bankDepositConfirm.mockRejectedValueOnce(
      new Error("private transport details"),
    );
    await f.activate();
    await f.open();
    submit("confirm");
    await flush();
    expect(find("action-status").textContent).not.toContain(
      "private transport details",
    );
    const first = f.api.bankDepositConfirm.mock.calls[0]!;
    submit("confirm");
    await flush();
    expect(f.api.bankDepositConfirm.mock.calls[1]).toEqual(first);
  });
  it("keeps unknown provider status truthful after an administrator verifies source evidence", async () => {
    const f = fixture(
      row({
        provider: "wise",
        source_status: "unknown",
        confirmation_ready: false,
        confirmation_basis: null,
      }),
    );
    await f.activate();
    await f.open();
    expect(find("confirm").hidden).toBe(true);
    expect(find("verify").hidden).toBe(false);
    submit("verify");
    expect(f.api.bankDepositVerify).not.toHaveBeenCalled();
    const form = find<HTMLFormElement>("verify");
    (form.elements.namedItem("posted") as HTMLInputElement).checked = true;
    (form.elements.namedItem("external") as HTMLInputElement).checked = true;
    (
      form.elements.namedItem("verification-reference") as HTMLInputElement
    ).value = "Statement reference";
    submit("verify");
    await flush();
    expect(f.api.bankDepositVerify.mock.calls[0]![2]).toMatchObject({
      confirm_posted_funds: true,
      confirm_external_credit: true,
      verification_reference: "Statement reference",
    });
    expect(find("source-note").textContent).toContain(
      "does not change the provider",
    );
    expect(find("confirm").hidden).toBe(false);
  });
  it.each(["pending", "reversed", "ineligible"] as const)(
    "never offers verification or confirmation for %s credits",
    async (source_status) => {
      const f = fixture(
        row({
          source_status,
          confirmation_ready: false,
          confirmation_basis: null,
        }),
      );
      await f.activate();
      await f.open();
      expect(find("verify").hidden).toBe(true);
      expect(find("confirm").hidden).toBe(true);
      expect(find("source-note").textContent).toMatch(
        source_status === "pending"
          ? /Wait for/
          : source_status === "ineligible"
            ? /not an eligible/
            : /reversed/,
      );
    },
  );
  it("clears private rows/evidence on logout and ignores late completion from the old session", async () => {
    const f = fixture(),
      result = pending<BankDeposit>();
    f.api.bankDepositConfirm.mockReturnValueOnce(result.promise);
    await f.activate();
    await f.open();
    submit("confirm");
    f.abort.abort();
    expect(document.body.textContent).not.toContain("Example client");
    expect(document.body.textContent).not.toContain("txn-1");
    expect(document.body.textContent).not.toContain("INV-2");
    result.resolve(row({ state: "confirmed" }));
    await flush();
    expect(document.body.textContent).not.toContain("Payment confirmed");
    expect(find("detail").hidden).toBe(true);
  });
  it("rejects then reopens using the returned version without creating a payment", async () => {
    const f = fixture();
    await f.activate();
    await f.open();
    find<HTMLButtonElement>("reject").click();
    await flush();
    expect(find("reopen").hidden).toBe(false);
    find<HTMLButtonElement>("reopen").click();
    await flush();
    expect(f.api.bankDepositReopen.mock.calls[0]![2]).toEqual({
      expected_version: 2,
    });
    expect(f.api.bankDepositConfirm).not.toHaveBeenCalled();
  });
  it("renders provider and row text as text, not markup", async () => {
    const f = fixture(
      row({
        counterparty: "<img src=x onerror=alert(1)>",
        memo: "<script>bad</script>",
      }),
    );
    await f.activate();
    await f.open();
    expect(find("facts").querySelector("script")).toBeNull();
    expect(find("list").querySelector("img")).toBeNull();
    expect(find("facts").textContent).toContain("<script>bad</script>");
  });
});

it("shows actual provider availability and serializes manual sync before refreshing the queue", async () => {
  const f = fixture(),
    running = pending<{ checked: number; failed: number }>();
  const bankFeedStatus = vi.fn().mockResolvedValue([
    {
      provider: "mercury",
      configured: false,
      account_name: null,
      last_synced_at: null,
      last_error: null,
      next_poll_at: null,
    },
    {
      provider: "wise",
      configured: true,
      account_name: "Review balance",
      last_synced_at: null,
      last_error: "provider",
      next_poll_at: null,
    },
  ]);
  const bankFeedSync = vi.fn().mockReturnValue(running.promise);
  const controller = createBankDepositController({
    ...f.api,
    bankFeedStatus,
    bankFeedSync,
  });
  await controller.activate(identity(), f.abort.signal, () => false);
  expect(find("provider-status").textContent).toContain(
    "mercury: not configured",
  );
  expect(find("provider-status").textContent).toContain("last sync failed");
  find<HTMLButtonElement>("sync").click();
  find<HTMLButtonElement>("sync").click();
  expect(bankFeedSync).toHaveBeenCalledTimes(1);
  expect(find("status").textContent).toContain("Syncing bank deposits");
  running.resolve({ checked: 1, failed: 0 });
  await flush();
  expect(f.api.bankDepositList).toHaveBeenCalledTimes(2);
  expect(find("status").textContent).toContain("sync complete");
});

it("does not report a refreshed queue when sync succeeds but the subsequent list fails", async () => {
  const f = fixture();
  f.api.bankDepositList
    .mockResolvedValueOnce({ data: [row()], total: 1 })
    .mockRejectedValueOnce(new Error("private provider detail"));
  const controller = createBankDepositController({
    ...f.api,
    bankFeedStatus: async () => [
      {
        provider: "wise",
        configured: true,
        account_name: "Review",
        last_synced_at: null,
        last_error: null,
        next_poll_at: null,
      },
    ],
    bankFeedSync: async () => ({ checked: 1, failed: 0 }),
  });
  await controller.activate(identity(), f.abort.signal, () => false);
  find<HTMLButtonElement>("sync").click();
  await flush();
  expect(find("status").textContent).toContain(
    "review queue could not refresh",
  );
  expect(find("status").textContent).not.toContain("sync complete");
  expect(find("status").textContent).not.toContain("private provider detail");
});
