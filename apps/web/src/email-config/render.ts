/**
 * The configure pane behind the Invoices strip's last tab.
 *
 * It replaces the labelled empty state that shipped with the strip, which said
 * of itself that `/api/v1/sender-identities` and `/api/v1/email-templates`
 * already served it and this screen did not read them yet. It does now.
 *
 * Both halves are on one page rather than behind a sub-navigation, because
 * they answer one question between them -- what a client sees when an invoice
 * arrives -- and an operator checking the address is usually about to check the
 * wording.
 *
 * `?template=` names the template being edited, so a link to a draft in
 * progress goes back to the same one.
 */

export const renderEmailConfigPage = (view?: string): string => `
  <main class="app-content invoice-workspace email-config-workspace page--grid" data-invoice-configure-page${view === 'invoice-configure' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">Money</p><h1>Configure</h1></div>
    </header>
    <p class="invoice-intro">Who invoice mail comes from, and what it says.</p>
    <section class="email-senders" aria-labelledby="email-senders-heading">
      <h2 id="email-senders-heading">Sender identities</h2>
      <p class="hint">One is the default, and every invoice goes out as it. The provider decides whether it may: a sender whose evidence is failing will be refused or filtered, and a bounce is a late way to find that out.</p>
      <p class="form-result email-sender-warning" data-sender-warning role="status" aria-live="polite" hidden></p>
      <p class="form-result invoice-page-status" data-sender-status role="status" aria-live="polite">Loading sender identities…</p>
      <div data-sender-list></div>
      <div class="email-config-actions">
        <button class="invoice-load-more" type="button" data-sender-retry hidden>Retry loading senders</button>
      </div>
      <p class="hint">A new sender identity is created against the mail provider this deployment is configured for, so it is added where that configuration lives rather than here.</p>
    </section>
    <section class="email-templates" aria-labelledby="email-templates-heading">
      <h2 id="email-templates-heading">Email templates</h2>
      <p class="hint">Variables are written <code>%like_this%</code> — the same syntax Harvest uses, so templates brought across paste in unchanged.</p>
      <p class="form-result invoice-page-status" data-template-status role="status" aria-live="polite">Loading templates…</p>
      <div data-template-list></div>
      <div class="email-config-actions">
        <button class="invoice-load-more" type="button" data-template-retry hidden>Retry loading templates</button>
      </div>
      <section class="email-template-editor" data-template-editor hidden aria-labelledby="email-template-editor-heading">
        <div class="email-template-editor-heading">
          <div>
            <p class="eyebrow" data-template-editor-kind>Template</p>
            <h3 id="email-template-editor-heading" data-template-editor-title>Template</h3>
          </div>
          <a class="email-template-close" href="/invoices/configure" data-template-close>Close</a>
        </div>
        <p class="hint" data-template-purpose>—</p>
        <form data-template-form novalidate>
          <label for="ez-template-subject">Subject
            <input id="ez-template-subject" name="subject" data-template-subject maxlength="2000" required>
          </label>
          <label for="ez-template-text">Plain text
            <textarea id="ez-template-text" name="text" data-template-text rows="12" required></textarea>
          </label>
          <label for="ez-template-html">HTML <span class="hint">Optional. Left empty, the plain text is the whole message.</span>
            <textarea id="ez-template-html" name="html" data-template-html rows="10"></textarea>
          </label>
          <p class="form-result email-template-unknown" data-template-unknown role="status" aria-live="polite" hidden></p>
          <div class="email-config-actions">
            <button class="primary-action" type="submit" data-template-save disabled>Save new version</button>
            <button type="button" data-template-revert disabled>Revert</button>
          </div>
          <p class="form-result" data-template-result role="status" aria-live="polite"></p>
        </form>
        <section class="email-template-variables" aria-labelledby="email-template-variables-heading">
          <h4 id="email-template-variables-heading">Variables for this template</h4>
          <div data-template-variables></div>
        </section>
        <section class="email-template-history" aria-labelledby="email-template-history-heading">
          <h4 id="email-template-history-heading">Versions</h4>
          <p class="hint">Templates are append-only: saving writes a new version rather than replacing the one in use.</p>
          <div data-template-history></div>
        </section>
      </section>
    </section>
  </main>`
