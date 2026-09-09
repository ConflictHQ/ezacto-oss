/**
 * The recurring pane behind the Invoices strip's second tab.
 *
 * It replaces the labelled empty state that shipped with the strip, which said
 * of itself that `/api/v1/recurring-invoices` already served it and this screen
 * did not read it yet. It does now.
 *
 * List and detail live in one route, `/invoices/recurring`, with `?definition=`
 * naming the open one -- the same shape the retainers pane next door uses for
 * `?retainer=`. Every value is filled in by the controller, so the markup
 * states nothing it has not read.
 *
 * The issue button is the reason the screen exists rather than a report would
 * do. It is a confirmed action: a recurring invoice is a document that goes to
 * a client, and a button that raises one on a single click is a button someone
 * will press by accident.
 */

export const renderRecurringPage = (view?: string): string => `
  <main class="app-content invoice-workspace recurring-workspace page--grid" data-invoice-recurring-page${view === 'invoice-recurring' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">Money</p><h1>Recurring</h1></div>
    </header>
    <section data-recurring-list-view aria-labelledby="recurring-list-heading">
      <h2 class="visually-hidden" id="recurring-list-heading">Recurring invoices</h2>
      <p class="invoice-intro">Standing instructions that raise an invoice on a cadence. Open one to see what it will bill for, and issue the period it is due.</p>
      <div class="recurring-toolbar">
        <label class="visually-hidden" for="ez-recurring-search">Search recurring invoices</label>
        <input id="ez-recurring-search" type="search" data-recurring-search placeholder="Search by client or subject" autocomplete="off">
      </div>
      <p class="form-result invoice-page-status" data-recurring-list-status role="status" aria-live="polite">Loading recurring invoices…</p>
      <div data-recurring-list></div>
      <div class="recurring-actions">
        <button class="invoice-load-more" type="button" data-recurring-load-more hidden>Load more recurring invoices</button>
        <button class="invoice-load-more" type="button" data-recurring-list-retry hidden>Retry loading recurring invoices</button>
      </div>
    </section>
    <section class="recurring-detail" data-recurring-detail-view hidden aria-labelledby="recurring-detail-heading">
      <div class="recurring-detail-heading">
        <div>
          <p class="eyebrow" data-recurring-detail-client>Recurring</p>
          <h2 id="recurring-detail-heading" data-recurring-detail-title>Recurring invoice</h2>
        </div>
        <a class="recurring-detail-back" href="/invoices/recurring" data-recurring-back>Back to recurring</a>
      </div>
      <p class="form-result invoice-page-status" data-recurring-detail-status role="status" aria-live="polite">Loading recurring invoice…</p>
      <div class="recurring-actions">
        <button class="invoice-load-more" type="button" data-recurring-detail-retry hidden>Retry loading this definition</button>
      </div>
      <div data-recurring-detail-body hidden>
        <dl class="recurring-facts">
          <div><dt>Client</dt><dd data-recurring-client>—</dd></div>
          <div><dt>Cadence</dt><dd data-recurring-cadence>—</dd></div>
          <div><dt>Next issue</dt><dd data-recurring-next>—</dd></div>
          <div><dt>Status</dt><dd data-recurring-due>—</dd></div>
          <div><dt>Bills</dt><dd data-recurring-basis>—</dd></div>
          <div><dt>Amount</dt><dd data-recurring-amount>—</dd></div>
          <div data-recurring-retainer-row hidden><dt>Draws from</dt><dd data-recurring-retainer>—</dd></div>
        </dl>
        <section class="recurring-issue" aria-labelledby="recurring-issue-heading">
          <h3 id="recurring-issue-heading">Issue this period</h3>
          <p class="hint" data-recurring-issue-hint>Raises the invoice this definition is due for and moves the cadence on. Nothing is sent to the client.</p>
          <button class="primary-action" type="button" data-recurring-issue disabled>Issue invoice</button>
          <p class="form-result" data-recurring-issue-result role="status" aria-live="polite"></p>
          <a class="recurring-issued-link" data-recurring-issued-link href="/invoices" hidden>Open the invoice</a>
        </section>
        <section class="recurring-config" aria-labelledby="recurring-config-heading">
          <h3 id="recurring-config-heading">What it bills</h3>
          <p class="hint" data-recurring-config-hint>—</p>
          <div data-recurring-config></div>
        </section>
        <section class="recurring-templates" aria-labelledby="recurring-templates-heading">
          <h3 id="recurring-templates-heading">On the invoice</h3>
          <dl class="recurring-facts">
            <div><dt>Subject</dt><dd data-recurring-subject>—</dd></div>
            <div><dt>Notes</dt><dd data-recurring-notes>—</dd></div>
          </dl>
        </section>
      </div>
    </section>
    <dialog class="recurring-confirm-dialog" data-recurring-confirm aria-labelledby="recurring-confirm-title">
      <form data-recurring-confirm-form method="dialog">
        <header>
          <div><p class="eyebrow">Money</p><h2 id="recurring-confirm-title">Issue this invoice?</h2></div>
          <button type="button" data-recurring-confirm-cancel aria-label="Close">×</button>
        </header>
        <p data-recurring-confirm-body>This raises a draft invoice and moves the cadence on.</p>
        <footer>
          <button type="button" data-recurring-confirm-cancel>Cancel</button>
          <button class="primary-action" type="submit" data-recurring-confirm-submit>Issue invoice</button>
        </footer>
      </form>
    </dialog>
  </main>`
