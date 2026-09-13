/**
 * The estimates pane behind the Invoices strip (issue 485).
 *
 * Seven API paths and nine client methods served since the API shipped, and no
 * screen called any of them. This is the screen.
 *
 * List and detail live in one route, `/invoices/estimates`, with `?estimate=`
 * naming the open one -- the same shape the recurring and retainer panes beside
 * it use for `?definition=` and `?retainer=`. Every value is filled in by the
 * controller, so the markup states nothing it has not read.
 *
 * Convert is a confirmed action, for the reason the recurring pane gives about
 * issuing: it raises a document that goes to a client, and a button that does
 * that on a single click is one somebody presses by accident. It is also the
 * only write here -- messages and attachments are correspondence about an
 * estimate, and a screen that could send those without being able to raise the
 * invoice would have the priority backwards.
 */

export const renderEstimatesPage = (view?: string): string => `
  <main class="app-content invoice-workspace estimates-workspace page--grid" data-invoice-estimates-page${view === 'invoice-estimates' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">Money</p><h1>Estimates</h1></div>
    </header>
    <section data-estimate-list-view aria-labelledby="estimate-list-heading">
      <h2 class="visually-hidden" id="estimate-list-heading">Estimates</h2>
      <p class="invoice-intro">What was quoted, and what happened to it. An accepted estimate can be turned into an invoice.</p>
      <div class="recurring-toolbar">
        <label class="visually-hidden" for="ez-estimate-search">Search estimates</label>
        <input id="ez-estimate-search" type="search" data-estimate-search placeholder="Search by client, number or subject" autocomplete="off">
      </div>
      <p class="form-result invoice-page-status" data-estimate-list-status role="status" aria-live="polite">Loading estimates…</p>
      <div data-estimate-list></div>
      <div class="recurring-actions">
        <button class="invoice-load-more" type="button" data-estimate-load-more hidden>Load more estimates</button>
        <button class="invoice-load-more" type="button" data-estimate-list-retry hidden>Retry loading estimates</button>
      </div>
    </section>
    <section class="recurring-detail" data-estimate-detail-view hidden aria-labelledby="estimate-detail-heading">
      <div class="recurring-detail-heading">
        <div>
          <p class="eyebrow" data-estimate-detail-client>Estimate</p>
          <h2 id="estimate-detail-heading" data-estimate-detail-title>Estimate</h2>
        </div>
        <div class="recurring-detail-actions">
          <a class="recurring-detail-back" href="/invoices/estimates" data-estimate-back>Back to estimates</a>
        </div>
      </div>
      <p class="form-result invoice-page-status" data-estimate-detail-status role="status" aria-live="polite">Loading estimate…</p>
      <div class="recurring-actions">
        <button class="invoice-load-more" type="button" data-estimate-detail-retry hidden>Retry loading this estimate</button>
      </div>
      <div data-estimate-detail-body hidden>
        <dl class="recurring-facts">
          <div><dt>Client</dt><dd data-estimate-client>—</dd></div>
          <div><dt>Number</dt><dd data-estimate-number>—</dd></div>
          <div><dt>Status</dt><dd data-estimate-state>—</dd></div>
          <div><dt>Issued</dt><dd data-estimate-issued>—</dd></div>
          <div data-estimate-purchase-order-row hidden><dt>Purchase order</dt><dd data-estimate-purchase-order>—</dd></div>
          <div><dt>Total</dt><dd data-estimate-amount>—</dd></div>
        </dl>
        <section class="recurring-lines" aria-labelledby="estimate-lines-heading">
          <h3 id="estimate-lines-heading">What was quoted</h3>
          <div data-estimate-lines></div>
        </section>
        <section class="recurring-issue" data-estimate-convert-section hidden aria-labelledby="estimate-convert-heading">
          <h3 id="estimate-convert-heading">Turn this into an invoice</h3>
          <p class="hint" data-estimate-convert-hint>Raises an invoice for what this estimate quoted. Nothing is sent to the client.</p>
          <form class="estimate-convert-form" data-estimate-convert-form>
            <label>Invoice number<input name="number" data-estimate-convert-number required autocomplete="off"></label>
            <label>Issue date<input name="issue_date" type="date" data-estimate-convert-issued required></label>
            <label>Payment terms
              <select name="payment_terms" data-estimate-convert-terms>
                <option value="upon_receipt">On receipt</option>
                <option value="net_15">Net 15</option>
                <option value="net_30" selected>Net 30</option>
                <option value="net_45">Net 45</option>
                <option value="net_60">Net 60</option>
                <option value="custom">Custom</option>
              </select>
            </label>
            <label>Due date<input name="due_date" type="date" data-estimate-convert-due required></label>
            <button class="primary-action" type="submit" data-estimate-write data-estimate-convert hidden>Convert to invoice</button>
          </form>
          <p class="form-result" data-estimate-convert-result role="status" aria-live="polite"></p>
        </section>
      </div>
    </section>
  </main>`
