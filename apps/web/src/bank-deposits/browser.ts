import {
  EzactoApiError,
  type Whoami,
  type BankDeposit,
  type BankReviewInvoice,
} from "@conflict-hq/ezacto-client";
import { setRequestBusy } from "../request-feedback.js";
import { markMoney } from "../money-display.js";
import { bankDepositSourceLabel, type BankDepositApi } from "./model.js";

interface Session {
  identity: Whoami;
  signal: AbortSignal;
  failed: (error: unknown) => boolean;
}
const money = (amount: number, currency: string): string =>
  new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
    amount / 100,
  );
const failure = (error: unknown): string =>
  error instanceof EzactoApiError && error.status === 409
    ? "This deposit or invoice changed. Refresh and review it again."
    : error instanceof EzactoApiError && error.status === 422
      ? "The bank deposit could not be recorded. Review the source, invoice and amount."
      : "The request could not be confirmed. Retry the same action or refresh to check its status.";
export const createBankDepositController = (api: Partial<BankDepositApi>) => {
  const root = document.querySelector<HTMLElement>(
    "[data-bank-deposits-page]",
  )!;
  const get = <T extends HTMLElement>(key: string): T =>
    root.querySelector<T>(`[data-bank-${key}]`)!;
  const status = get<HTMLElement>("status"),
    list = get<HTMLElement>("list"),
    detail = get<HTMLElement>("detail"),
    actionStatus = get<HTMLElement>("action-status");
  const filter = get<HTMLSelectElement>("filter"),
    more = get<HTMLButtonElement>("more");
  const assign = get<HTMLFormElement>("assign"),
    verify = get<HTMLFormElement>("verify"),
    confirm = get<HTMLFormElement>("confirm");
  let session: Session | null = null,
    generation = 0,
    busy = false,
    mutating = false,
    page = 1,
    total = 0;
  let rows: BankDeposit[] = [],
    selected: BankDeposit | null = null,
    invoices: BankReviewInvoice[] = [];
  const commandKeys = new Map<string, string>();
  const active = (
    owner: Session | null,
    token = generation,
  ): owner is Session =>
    owner !== null &&
    session === owner &&
    !owner.signal.aborted &&
    generation === token &&
    ["administrator", "accounting"].includes(owner.identity.profile);
  const setBusy = (value: boolean): void => {
    busy = value;
    for (const element of root.querySelectorAll<
      HTMLInputElement | HTMLButtonElement | HTMLSelectElement
    >("input,button,select"))
      element.disabled = value;
    setRequestBusy(mutating ? actionStatus : status, value);
  };
  const clear = (): void => {
    rows = [];
    selected = null;
    invoices = [];
    commandKeys.clear();
    list.replaceChildren();
    get("facts").replaceChildren();
    detail.hidden = true;
    status.textContent = "";
    actionStatus.textContent = "";
    get("provider-status").textContent = "";
    verify.reset();
    assign.reset();
    (
      assign.elements.namedItem("invoice") as HTMLSelectElement
    ).replaceChildren();
    confirm.reset();
    get("confirm-summary").textContent = "";
    get("source-note").textContent = "";
    more.hidden = true;
    get<HTMLButtonElement>("sync").hidden = true;
  };
  const presentRows = (): void => {
    list.replaceChildren(
      ...rows.map((row) => {
        const li = document.createElement("li"),
          button = document.createElement("button");
        button.type = "button";
        button.textContent = `${row.counterparty ?? row.account_name} · ${money(row.amount_cents, row.currency)} · ${row.posted_at.slice(0, 10)} · ${row.state} · ${bankDepositSourceLabel(row)}`;
        markMoney(button, true);
        button.addEventListener("click", () => {
          void open(row);
        });
        li.append(button);
        return li;
      }),
    );
    more.hidden = rows.length >= total;
  };
  const presentDetail = (): void => {
    const row = selected;
    if (!row) {
      detail.hidden = true;
      return;
    }
    detail.hidden = false;
    const facts = [
      ["Account", `${row.provider} · ${row.account_name}`],
      ["Transaction", row.provider_transaction_id],
      ["Received", `${money(row.amount_cents, row.currency)} ${row.currency}`],
      ["Date", row.posted_at],
      ["From", row.counterparty ?? "Not supplied"],
      ["Memo", row.memo ?? "Not supplied"],
      ["Status", `${row.state} · ${bankDepositSourceLabel(row)}`],
    ];
    if (row.verification_reference)
      facts.push(["Verification reference", row.verification_reference]);
    get("facts").replaceChildren(
      ...facts.map(([name, value]) => {
        const div = document.createElement("div"),
          dt = document.createElement("dt"),
          dd = document.createElement("dd");
        dt.textContent = name!;
        dd.textContent = value!;
        if (name === "Received") markMoney(dd, true);
        div.append(dt, dd);
        return div;
      }),
    );
    const closed = row.state === "confirmed" || row.state === "rejected";
    get("source-note").textContent =
      row.source_status === "ineligible" ||
      row.classification === "internal_transfer"
        ? "This transaction is not an eligible customer receipt. It cannot be confirmed."
        : row.source_status === "reversed"
          ? "The provider reversed this credit. It cannot be confirmed."
          : row.source_status === "pending"
            ? "Wait for the provider to post these funds before confirming a payment."
            : row.confirmation_basis === "operator"
              ? "An administrator verified the source. This does not change the provider’s reported settlement status."
              : row.confirmation_ready
                ? "Review the invoice and amount before confirming."
                : "Source verification is required before this credit can be recorded as a payment.";
    verify.hidden =
      closed ||
      session?.identity.profile !== "administrator" ||
      row.confirmation_ready ||
      !["unknown", "final"].includes(row.source_status) ||
      row.classification === "internal_transfer";
    assign.hidden = closed;
    const select = assign.elements.namedItem("invoice") as HTMLSelectElement;
    select.replaceChildren(
      ...invoices.map((invoice) => {
        const option = document.createElement("option");
        option.value = String(invoice.id);
        option.textContent = `${invoice.number} · ${money(invoice.due_amount_cents, invoice.currency)} due · ${invoice.currency}`;
        option.selected = invoice.id === row.suggested_invoice?.id;
        return option;
      }),
    );
    if (invoices.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No eligible invoices in this currency";
      select.append(option);
    }
    const invoice = row.suggested_invoice;
    confirm.hidden = closed || !invoice || !row.confirmation_ready;
    confirm.reset();
    get("confirm-summary").textContent = invoice
      ? `Record ${money(row.amount_cents, row.currency)} ${row.currency} against invoice ${invoice.number}, which has ${money(invoice.due_amount_cents, invoice.currency)} ${invoice.currency} remaining.`
      : "";
    get("overpayment-label").hidden =
      !invoice || row.amount_cents <= invoice.due_amount_cents;
    get<HTMLButtonElement>("reject").hidden = closed;
    get<HTMLButtonElement>("reopen").hidden = row.state !== "rejected";
  };
  const load = async (append = false): Promise<boolean> => {
    const owner = session,
      token = generation;
    if (
      !active(owner) ||
      busy ||
      !api.bankDepositAccounts ||
      !api.bankDepositList
    )
      return false;
    setBusy(true);
    status.textContent = "Loading bank deposits…";
    try {
      const requestedPage = append ? page + 1 : 1;
      const [accounts, result, feedStatus] = await Promise.all([
        api.bankDepositAccounts(owner.signal),
        api.bankDepositList(
          filter.value ? (filter.value as BankDeposit["state"]) : undefined,
          requestedPage,
          owner.signal,
        ),
        api.bankFeedStatus?.(owner.signal),
      ]);
      if (!active(owner, token)) return false;
      get("provider-status").textContent = feedStatus
        ? feedStatus
            .map(
              (feed) =>
                `${feed.provider}: ${feed.configured ? `connected${feed.account_name ? ` · ${feed.account_name}` : ""}${feed.last_synced_at ? ` · last synced ${feed.last_synced_at}` : " · not synced yet"}${feed.last_error ? " · last sync failed; try again" : ""}` : "not configured"}`,
            )
            .join(". ")
        : accounts.length
          ? `Review accounts: ${accounts.map((account) => `${account.provider} · ${account.name}`).join("; ")}. Connection status unavailable.`
          : "No bank feed accounts are available. Incoming deposits will appear after a provider feed is connected.";
      get<HTMLButtonElement>("sync").hidden =
        !api.bankFeedSync || !feedStatus?.some((feed) => feed.configured);
      rows = append ? [...rows, ...result.data] : result.data;
      page = requestedPage;
      total = result.total;
      selected = selected
        ? (rows.find((row) => row.id === selected!.id) ?? null)
        : null;
      presentRows();
      presentDetail();
      status.textContent = rows.length
        ? `${rows.length} of ${total} deposits loaded.`
        : "No deposits to review.";
      return true;
    } catch (error) {
      if (active(owner, token) && !owner.failed(error))
        status.textContent = "Could not load bank deposits. Try Refresh.";
      return false;
    } finally {
      if (active(owner, token)) setBusy(false);
    }
  };
  const open = async (row: BankDeposit): Promise<void> => {
    const owner = session,
      token = generation;
    if (!active(owner) || busy || !api.bankDepositInvoices) return;
    setBusy(true);
    actionStatus.textContent = "Loading invoice choices…";
    try {
      const choices = await api.bankDepositInvoices(row.id, owner.signal);
      if (!active(owner, token)) return;
      selected = row;
      invoices = choices;
      verify.reset();
      actionStatus.textContent = "";
      presentDetail();
    } catch (error) {
      if (active(owner, token) && !owner.failed(error))
        status.textContent = failure(error);
    } finally {
      if (active(owner, token)) {
        setBusy(false);
        setRequestBusy(actionStatus, false);
      }
    }
  };
  const mutate = async (
    operation: string,
    body: object,
    call: (
      id: number,
      key: string,
      signal: AbortSignal,
    ) => Promise<BankDeposit>,
  ): Promise<void> => {
    const owner = session,
      row = selected,
      token = generation;
    if (!active(owner) || !row || busy) return;
    const fingerprint = `${row.id}:${operation}:${JSON.stringify(body)}`;
    const key = commandKeys.get(fingerprint) ?? crypto.randomUUID();
    commandKeys.set(fingerprint, key);
    mutating = true;
    setBusy(true);
    actionStatus.textContent = `${operation}…`;
    try {
      const updated = await call(row.id, key, owner.signal);
      if (!active(owner, token)) return;
      selected = updated;
      rows = rows.map((item) => (item.id === updated.id ? updated : item));
      presentRows();
      presentDetail();
      commandKeys.delete(fingerprint);
      actionStatus.textContent =
        operation === "Confirming payment"
          ? "Payment confirmed and recorded."
          : operation === "Verifying source"
            ? "Administrator verification recorded. The provider status is unchanged."
            : "Deposit updated.";
    } catch (error) {
      if (active(owner, token) && !owner.failed(error))
        actionStatus.textContent = failure(error);
    } finally {
      if (active(owner, token)) {
        setBusy(false);
        mutating = false;
      }
    }
  };
  assign.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!selected || !api.bankDepositAssign) return;
    const invoiceId = Number(
      (assign.elements.namedItem("invoice") as HTMLSelectElement).value,
    );
    if (!invoices.some((invoice) => invoice.id === invoiceId)) return;
    const body = { expected_version: selected.version, invoice_id: invoiceId };
    void mutate("Assigning invoice", body, (id, key, signal) =>
      api.bankDepositAssign!(id, key, body, signal),
    );
  });
  confirm.addEventListener("submit", (event) => {
    event.preventDefault();
    const row = selected,
      invoice = row?.suggested_invoice;
    if (!row || !invoice || !row.confirmation_ready || !api.bankDepositConfirm)
      return;
    const overpayment = (
      confirm.elements.namedItem("overpayment") as HTMLInputElement
    ).checked;
    if (row.amount_cents > invoice.due_amount_cents && !overpayment) {
      actionStatus.textContent =
        "Review and accept the overpayment before confirming.";
      return;
    }
    const body = {
      expected_version: row.version,
      invoice_id: invoice.id,
      expected_invoice_version: invoice.version,
      confirm_overpayment: overpayment,
    };
    void mutate("Confirming payment", body, (id, key, signal) =>
      api.bankDepositConfirm!(id, key, body, signal),
    );
  });
  verify.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!selected || !api.bankDepositVerify || !verify.checkValidity()) return;
    const body = {
      expected_version: selected.version,
      verification_reference: (
        verify.elements.namedItem("verification-reference") as HTMLInputElement
      ).value.trim(),
      confirm_posted_funds: true as const,
      confirm_external_credit: true as const,
    };
    void mutate("Verifying source", body, (id, key, signal) =>
      api.bankDepositVerify!(id, key, body, signal),
    );
  });
  for (const operation of ["reject", "reopen"] as const)
    get<HTMLButtonElement>(operation).addEventListener("click", () => {
      if (!selected) return;
      const call =
        operation === "reject" ? api.bankDepositReject : api.bankDepositReopen;
      if (!call) return;
      const body = { expected_version: selected.version };
      void mutate(
        operation === "reject" ? "Rejecting deposit" : "Reopening deposit",
        body,
        (id, key, signal) => call(id, key, body, signal),
      );
    });
  get<HTMLButtonElement>("refresh").addEventListener("click", () => {
    void load();
  });
  more.addEventListener("click", () => {
    void load(true);
  });
  get<HTMLButtonElement>("sync").addEventListener("click", () => {
    void (async () => {
      const owner = session,
        token = generation;
      if (!active(owner) || busy || !api.bankFeedSync) return;
      setBusy(true);
      status.textContent = "Syncing bank deposits…";
      try {
        const result = await api.bankFeedSync(owner.signal);
        if (!active(owner, token)) return;
        setBusy(false);
        const refreshed = await load();
        if (active(owner, token))
          status.textContent = !refreshed
            ? "Bank feed sync finished, but the review queue could not refresh. Use Refresh before reviewing deposits."
            : result.failed
              ? "Some bank feeds could not be synced. Review connection status and try again."
              : result.checked === 0
                ? "No bank feeds were checked. Review connection status."
                : "Bank feed sync complete. Review incoming deposits below.";
      } catch (error) {
        if (active(owner, token) && !owner.failed(error))
          status.textContent =
            "Bank feed sync could not be completed. Try again.";
      } finally {
        if (active(owner, token)) setBusy(false);
      }
    })();
  });
  filter.addEventListener("change", () => {
    selected = null;
    void load();
  });
  return {
    async activate(
      identity: Whoami,
      signal: AbortSignal,
      failed: Session["failed"],
    ): Promise<void> {
      const owner = { identity, signal, failed };
      session = owner;
      generation += 1;
      busy = false;
      mutating = false;
      clear();
      setBusy(false);
      signal.addEventListener(
        "abort",
        () => {
          if (session === owner) {
            generation += 1;
            session = null;
            clear();
            mutating = false;
            setBusy(false);
          }
        },
        { once: true },
      );
      if (document.documentElement.dataset.appView !== "invoice-bank-deposits")
        return;
      if (!["administrator", "accounting"].includes(identity.profile)) {
        status.textContent =
          "Only administrators and accounting can review bank deposits.";
        return;
      }
      if (!api.bankDepositAccounts || !api.bankDepositList) {
        get("provider-status").textContent =
          "Bank deposit review is not configured on this deployment.";
        return;
      }
      await load();
    },
  };
};
