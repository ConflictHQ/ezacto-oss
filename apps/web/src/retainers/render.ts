/**
 * The retainers pane behind the Invoices strip's third tab.
 *
 * It replaces the labelled empty state that shipped with the strip. The empty
 * state was right while there was nothing behind the tab; it is not right now
 * that the cutover carries retainers, and it said so itself.
 *
 * List and detail live in one route, `/invoices/retainers`, with `?retainer=`
 * naming the open one — the same shape the expense-category filter already
 * uses for `?status=`. Every number is filled in by the controller, so the
 * markup states nothing it has not yet read.
 */

export const renderRetainerPage = (view?: string): string => `
  <main class="app-content invoice-workspace retainer-workspace page--grid" data-invoice-retainers-page${view === 'invoice-retainers' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">Money</p><h1>Retainers</h1></div>
    </header>
    <section data-retainer-list-view aria-labelledby="retainer-list-heading">
      <h2 class="visually-hidden" id="retainer-list-heading">Retainers</h2>
      <p class="invoice-intro">What is on retainer, and what remains of it. A balance is the sum of that retainer's ledger; open one to see the movements that produced it.</p>
      <div class="retainer-controls">
        <div class="retainer-toolbar" role="group" aria-label="Retainer status">
          <button type="button" data-retainer-filter="ongoing" aria-pressed="true">Ongoing</button>
          <button type="button" data-retainer-filter="all" aria-pressed="false">All</button>
        </div>
        <button class="primary-action" type="button" data-retainer-create data-auth-action hidden disabled>New retainer</button>
      </div>
      <p class="form-result invoice-page-status" data-retainer-list-status role="status" aria-live="polite">Loading retainers…</p>
      <div data-retainer-list></div>
      <div class="retainer-actions">
        <button class="invoice-load-more" type="button" data-retainer-load-more hidden>Load more retainers</button>
        <button class="invoice-load-more" type="button" data-retainer-list-retry hidden>Retry loading retainers</button>
      </div>
    </section>
    <section class="retainer-detail" data-retainer-detail-view hidden aria-labelledby="retainer-detail-heading">
      <div class="retainer-detail-heading">
        <div>
          <p class="eyebrow" data-retainer-detail-client>Retainer</p>
          <h2 id="retainer-detail-heading" data-retainer-detail-title>Retainer</h2>
        </div>
        <a class="retainer-detail-back" href="/invoices/retainers" data-retainer-back>Back to retainers</a>
      </div>
      <p class="form-result invoice-page-status" data-retainer-detail-status role="status" aria-live="polite">Loading retainer…</p>
      <div class="retainer-actions" data-retainer-write-actions hidden>
        <button class="primary-action" type="button" data-retainer-drawdown data-auth-action disabled>Draw down</button>
        <button type="button" data-retainer-movement data-auth-action disabled>Record a movement</button>
        <button type="button" data-retainer-policy-edit data-auth-action disabled>Edit policy</button>
      </div>
      <p class="form-result invoice-page-status" data-retainer-write-status role="status" aria-live="polite"></p>
      <div class="retainer-actions">
        <button class="invoice-load-more" type="button" data-retainer-detail-retry hidden>Retry loading this retainer</button>
      </div>
      <div data-retainer-detail-body hidden>
        <dl class="retainer-facts" data-retainer-money>
          <div><dt>On retainer</dt><dd data-retainer-commitment>—</dd></div>
          <div><dt>Deposited</dt><dd data-retainer-deposited>—</dd></div>
          <div><dt>Drawn down</dt><dd data-retainer-drawn>—</dd></div>
          <div><dt>Expired</dt><dd data-retainer-expired>—</dd></div>
          <div><dt>Adjustments</dt><dd data-retainer-adjusted>—</dd></div>
          <div><dt>Remaining</dt><dd data-retainer-remaining>—</dd></div>
          <div data-retainer-share-row hidden><dt>Remaining share</dt><dd data-retainer-share>—</dd></div>
          <div data-retainer-locked-value-row hidden><dt>Remaining at the locked rate</dt><dd data-retainer-locked-value>—</dd></div>
        </dl>
        <ul class="retainer-notes" data-retainer-notes hidden></ul>
        <dl class="retainer-facts retainer-policy" data-retainer-policy>
          <div><dt>Scope</dt><dd data-retainer-scope>—</dd></div>
          <div><dt>Basis</dt><dd data-retainer-basis>—</dd></div>
          <div><dt>State</dt><dd data-retainer-state>—</dd></div>
          <div><dt>Period</dt><dd data-retainer-period>—</dd></div>
          <div><dt>Rollover</dt><dd data-retainer-rollover>—</dd></div>
          <div><dt>Expires</dt><dd data-retainer-expires>—</dd></div>
          <div><dt>On exhaustion</dt><dd data-retainer-exhaustion>—</dd></div>
        </dl>
        <section class="retainer-ledger" aria-labelledby="retainer-ledger-heading">
          <h3 id="retainer-ledger-heading">Ledger</h3>
          <p class="hint">Every movement, oldest first, with the balance after it. The last balance is the retainer's balance.</p>
          <div data-retainer-ledger></div>
        </section>
      </div>
    </section>
  </main>`

/**
 * The four write dialogs, rendered at shell level rather than inside the
 * retainers `<main>`.
 *
 * They sit beside the invoice dialogs for the same reason those do: the page
 * `<main>` is `hidden` on every view but its own, and a `<dialog>` inside a
 * hidden ancestor cannot be shown. The controller is constructed on every page,
 * so the elements it looks up have to exist on every page too.
 *
 * Every option list that names a client, a project or an invoice is filled in
 * by the controller. Nothing here states a number, a name or a currency it has
 * not yet read -- the same rule the page above it follows.
 */
export const renderRetainerDialogs = (): string => `
  <dialog class="retainer-dialog" data-retainer-create-dialog aria-labelledby="retainer-create-title">
    <form data-retainer-create-form novalidate>
      <header><div><p class="eyebrow">Retainer</p><h2 id="retainer-create-title">New retainer</h2></div><button type="button" data-dialog-close aria-label="Close new retainer dialog">×</button></header>
      <label for="ez-retainer-create-client">Client
        <select id="ez-retainer-create-client" name="client" data-retainer-create-client></select>
      </label>
      <label for="ez-retainer-create-project">Project
        <select id="ez-retainer-create-project" name="project" data-retainer-create-project></select>
      </label>
      <label for="ez-retainer-create-basis">Basis
        <select id="ez-retainer-create-basis" name="basis" data-retainer-create-basis>
          <option value="money">Money</option>
          <option value="hours">Hours</option>
        </select>
      </label>
      <label for="ez-retainer-create-amount"><span data-retainer-create-amount-label>Agreed amount</span>
        <input id="ez-retainer-create-amount" name="amount" data-retainer-create-amount inputmode="decimal" autocomplete="off" required>
      </label>
      <label for="ez-retainer-create-rate" data-retainer-create-rate-row hidden><span data-retainer-create-rate-label>Lock the hourly rate at</span>
        <input id="ez-retainer-create-rate" name="locked_rate" data-retainer-create-rate inputmode="decimal" autocomplete="off">
      </label>
      <label for="ez-retainer-create-period">Period
        <input id="ez-retainer-create-period" name="period" data-retainer-create-period maxlength="64" autocomplete="off" placeholder="monthly">
      </label>
      <label for="ez-retainer-create-rollover">Rollover
        <select id="ez-retainer-create-rollover" name="rollover" data-retainer-create-rollover>
          <option value="">No rollover policy</option>
          <option value="carry">Carry the remainder forward</option>
          <option value="expire">Expire the remainder at the boundary</option>
          <option value="cap">Cap the carried remainder at the agreed amount</option>
        </select>
      </label>
      <label for="ez-retainer-create-expires">Expires on
        <input id="ez-retainer-create-expires" name="expires_at" data-retainer-create-expires type="date">
      </label>
      <label for="ez-retainer-create-exhaustion">On exhaustion
        <select id="ez-retainer-create-exhaustion" name="on_exhaustion" data-retainer-create-exhaustion>
          <option value="block">Block an overdraw</option>
          <option value="warn">Warn on an overdraw</option>
          <option value="overflow">Allow an overdraw</option>
        </select>
      </label>
      <p class="hint">A new retainer starts with an empty ledger, so its balance is zero until a deposit or an adjustment is posted. The agreed amount is what the balance is measured against, not the balance itself.</p>
      <p class="form-result" data-retainer-create-result role="status" aria-live="polite"></p>
      <div class="retainer-dialog-actions"><button type="button" data-dialog-close>Cancel</button><button class="primary-action" type="submit" data-retainer-create-submit>Create retainer</button></div>
    </form>
  </dialog>
  <dialog class="retainer-dialog" data-retainer-drawdown-dialog aria-labelledby="retainer-drawdown-title">
    <form data-retainer-drawdown-form novalidate>
      <header><div><p class="eyebrow">Retainer</p><h2 id="retainer-drawdown-title">Draw down retainer</h2></div><button type="button" data-dialog-close aria-label="Close drawdown dialog">×</button></header>
      <label for="ez-retainer-drawdown-invoice">Invoice
        <select id="ez-retainer-drawdown-invoice" name="invoice" data-retainer-drawdown-invoice required></select>
      </label>
      <label for="ez-retainer-drawdown-amount"><span data-retainer-drawdown-amount-label>Amount</span>
        <input id="ez-retainer-drawdown-amount" name="amount" data-retainer-drawdown-amount inputmode="decimal" autocomplete="off" required>
      </label>
      <label for="ez-retainer-drawdown-date">Date
        <input id="ez-retainer-drawdown-date" name="occurred_on" data-retainer-drawdown-date type="date" required>
      </label>
      <label for="ez-retainer-drawdown-notes">Reason
        <textarea id="ez-retainer-drawdown-notes" name="notes" data-retainer-drawdown-notes rows="3" maxlength="10000"></textarea>
      </label>
      <p class="retainer-projection">Balance after this drawdown <strong data-retainer-drawdown-projection>—</strong></p>
      <p class="hint">A drawdown must name an invoice already linked to this retainer; the ledger will not accept any other. It is appended, never edited: a mistake is corrected with an adjustment that says so.</p>
      <p class="form-result" data-retainer-drawdown-result role="status" aria-live="polite"></p>
      <div class="retainer-dialog-actions"><button type="button" data-dialog-close>Cancel</button><button class="primary-action" type="submit" data-retainer-drawdown-submit>Draw down</button></div>
    </form>
  </dialog>
  <dialog class="retainer-dialog" data-retainer-movement-dialog aria-labelledby="retainer-movement-title">
    <form data-retainer-movement-form novalidate>
      <header><div><p class="eyebrow">Retainer</p><h2 id="retainer-movement-title">Record a movement</h2></div><button type="button" data-dialog-close aria-label="Close movement dialog">×</button></header>
      <label for="ez-retainer-movement-kind">Movement
        <select id="ez-retainer-movement-kind" name="kind" data-retainer-movement-kind>
          <option value="adjustment">Adjustment</option>
          <option value="deposit">Deposit against an invoice</option>
          <option value="expiry">Expire part of the balance</option>
          <option value="reset">Reset at a period boundary</option>
        </select>
      </label>
      <label for="ez-retainer-movement-invoice" data-retainer-movement-invoice-label hidden>Invoice
        <select id="ez-retainer-movement-invoice" name="invoice" data-retainer-movement-invoice></select>
      </label>
      <label for="ez-retainer-movement-direction" data-retainer-movement-direction-label hidden>Direction
        <select id="ez-retainer-movement-direction" name="direction" data-retainer-movement-direction>
          <option value="increase">Add to the balance</option>
          <option value="decrease">Take off the balance</option>
        </select>
      </label>
      <label for="ez-retainer-movement-amount"><span data-retainer-movement-amount-label>Amount</span>
        <input id="ez-retainer-movement-amount" name="amount" data-retainer-movement-amount inputmode="decimal" autocomplete="off" required>
      </label>
      <label for="ez-retainer-movement-date">Date
        <input id="ez-retainer-movement-date" name="occurred_on" data-retainer-movement-date type="date" required>
      </label>
      <label for="ez-retainer-movement-notes"><span data-retainer-movement-notes-label>Reason</span>
        <textarea id="ez-retainer-movement-notes" name="notes" data-retainer-movement-notes rows="3" maxlength="10000"></textarea>
      </label>
      <p class="retainer-projection">Balance after this movement <strong data-retainer-movement-projection>—</strong></p>
      <p class="hint" data-retainer-movement-hint></p>
      <p class="form-result" data-retainer-movement-result role="status" aria-live="polite"></p>
      <div class="retainer-dialog-actions"><button type="button" data-dialog-close>Cancel</button><button class="primary-action" type="submit" data-retainer-movement-submit>Record movement</button></div>
    </form>
  </dialog>
  <dialog class="retainer-dialog" data-retainer-policy-dialog aria-labelledby="retainer-policy-title">
    <form data-retainer-policy-form novalidate>
      <header><div><p class="eyebrow">Retainer</p><h2 id="retainer-policy-title">Edit retainer policy</h2></div><button type="button" data-dialog-close aria-label="Close policy dialog">×</button></header>
      <label for="ez-retainer-policy-state">State
        <select id="ez-retainer-policy-state" name="state" data-retainer-policy-state>
          <option value="ongoing">Ongoing</option>
          <option value="closed">Closed</option>
        </select>
      </label>
      <label for="ez-retainer-policy-period">Period
        <input id="ez-retainer-policy-period" name="period" data-retainer-policy-period maxlength="64" autocomplete="off" placeholder="monthly">
      </label>
      <label for="ez-retainer-policy-rollover">Rollover
        <select id="ez-retainer-policy-rollover" name="rollover" data-retainer-policy-rollover>
          <option value="">No rollover policy</option>
          <option value="carry">Carry the remainder forward</option>
          <option value="expire">Expire the remainder at the boundary</option>
          <option value="cap">Cap the carried remainder at the agreed amount</option>
        </select>
      </label>
      <label for="ez-retainer-policy-expires">Expires on
        <input id="ez-retainer-policy-expires" name="expires_at" data-retainer-policy-expires type="date">
      </label>
      <label for="ez-retainer-policy-exhaustion">On exhaustion
        <select id="ez-retainer-policy-exhaustion" name="on_exhaustion" data-retainer-policy-exhaustion>
          <option value="block">Block an overdraw</option>
          <option value="warn">Warn on an overdraw</option>
          <option value="overflow">Allow an overdraw</option>
        </select>
      </label>
      <p class="hint">Policy only. The agreed amount and the basis are fixed at creation, and the balance moves through the ledger rather than through this form.</p>
      <p class="form-result" data-retainer-policy-result role="status" aria-live="polite"></p>
      <div class="retainer-dialog-actions"><button type="button" data-dialog-close>Cancel</button><button class="primary-action" type="submit" data-retainer-policy-submit>Save policy</button></div>
    </form>
  </dialog>`
