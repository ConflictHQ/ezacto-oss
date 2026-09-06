export const renderClientDirectoryPages = (view?: string): string => `
  <main class="app-content client-workspace" data-client-list-page${view === 'client-list' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">Relationships</p><h1>Clients</h1></div>
      <button class="primary-action" type="button" data-client-create data-client-write data-auth-action hidden disabled>Add client</button>
    </header>
    <p class="client-intro">Browse the organizations you work for and the entities that receive their invoices.</p>
    <div class="client-list-toolbar" role="group" aria-label="Client status">
      <button type="button" data-client-filter="active" aria-pressed="true">Active</button>
      <button type="button" data-client-filter="all" aria-pressed="false">All</button>
    </div>
    <p class="form-result client-page-status" data-client-list-status role="status" aria-live="polite">Loading clients…</p>
    <ol class="client-tree" data-client-tree aria-label="Client hierarchy"></ol>
    <button type="button" data-client-list-retry hidden>Retry loading clients</button>
  </main>
  <main class="app-content client-workspace" data-client-detail-page${view === 'client-detail' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">Clients</p><h1 data-client-detail-name>Client detail</h1></div>
      <div class="client-header-actions">
        <a href="/clients">Back to clients</a>
        <button type="button" data-client-edit data-client-write data-auth-action hidden disabled>Edit</button>
        <button type="button" data-client-archive data-client-write data-auth-action hidden disabled>Archive</button>
      </div>
    </header>
    <p class="form-result client-page-status" data-client-detail-status role="status" aria-live="polite">Loading client…</p>
    <article class="client-detail" data-client-detail hidden>
      <section class="client-facts" aria-labelledby="client-facts-heading">
        <h2 id="client-facts-heading">Client details</h2>
        <dl>
          <div><dt>Status</dt><dd data-client-detail-active>—</dd></div>
          <div><dt>Currency</dt><dd data-client-detail-currency>—</dd></div>
          <div><dt>Worked-for parent</dt><dd data-client-detail-parent>—</dd></div>
          <div><dt>Bill-to client</dt><dd data-client-detail-bill-to>—</dd></div>
          <div><dt>Payment terms</dt><dd data-client-detail-terms>—</dd></div>
          <div><dt>Primary tax</dt><dd data-client-detail-tax>—</dd></div>
          <div><dt>Secondary tax</dt><dd data-client-detail-tax2>—</dd></div>
          <div><dt>Default discount</dt><dd data-client-detail-discount>—</dd></div>
          <div class="client-address"><dt>Address</dt><dd data-client-detail-address>—</dd></div>
        </dl>
      </section>
      <section class="client-projects" aria-labelledby="client-projects-heading">
        <header><div><p class="eyebrow">Work</p><h2 id="client-projects-heading">Associated projects</h2></div></header>
        <div data-client-projects></div>
      </section>
      <section class="client-contacts" aria-labelledby="client-contacts-heading">
        <header>
          <div><p class="eyebrow">People</p><h2 id="client-contacts-heading">Contacts</h2></div>
          <button type="button" data-contact-create data-client-write data-auth-action hidden disabled>Add contact</button>
        </header>
        <div data-client-contacts></div>
      </section>
    </article>
    <button type="button" data-client-detail-retry hidden>Retry loading client</button>
  </main>
  <dialog class="client-form-dialog" data-client-form-dialog aria-labelledby="client-form-title">
    <form data-client-form>
      <header><div><p class="eyebrow">Client</p><h2 id="client-form-title" data-client-form-title>Add client</h2></div><button type="button" data-client-dialog-close aria-label="Close">×</button></header>
      <label for="ez-client-name">Name<input id="ez-client-name" name="name" autocomplete="organization" maxlength="255" required></label>
      <label for="ez-client-address">Address<textarea id="ez-client-address" name="address" autocomplete="street-address" rows="4"></textarea></label>
      <div class="client-form-pair">
        <label for="ez-client-currency">Currency<input id="ez-client-currency" name="currency" inputmode="text" autocomplete="off" minlength="3" maxlength="3" pattern="[A-Za-z]{3}" placeholder="Organization default"></label>
        <label for="ez-client-payment-terms">Payment terms<select id="ez-client-payment-terms" name="payment_terms"><option value="upon_receipt">Upon receipt</option><option value="net_15">Net 15</option><option value="net_30">Net 30</option><option value="net_45">Net 45</option><option value="net_60">Net 60</option><option value="custom">Custom</option></select></label>
      </div>
      <div class="client-form-pair">
        <label for="ez-client-parent">Worked-for parent<select id="ez-client-parent" name="parent_client_id"><option value="">None</option></select></label>
        <label for="ez-client-bill-to">Bill-to client<select id="ez-client-bill-to" name="bill_to_client_id"><option value="">None</option></select></label>
      </div>
      <fieldset class="client-defaults">
        <legend>Invoice defaults</legend>
        <label for="ez-client-tax">Primary tax %<input id="ez-client-tax" name="default_tax_pct" type="number" min="0" step="0.0001"></label>
        <label for="ez-client-tax2">Secondary tax %<input id="ez-client-tax2" name="default_tax2_pct" type="number" min="0" step="0.0001"></label>
        <label for="ez-client-discount">Discount %<input id="ez-client-discount" name="default_discount_pct" type="number" min="0" step="0.0001"></label>
      </fieldset>
      <p class="form-result" data-client-form-result role="status" aria-live="polite"></p>
      <button class="primary-action" type="submit" data-client-form-submit>Save client</button>
    </form>
  </dialog>
  <dialog class="contact-form-dialog" data-contact-form-dialog aria-labelledby="contact-form-title">
    <form data-contact-form>
      <header><div><p class="eyebrow">Client contact</p><h2 id="contact-form-title" data-contact-form-title>Add contact</h2></div><button type="button" data-contact-dialog-close aria-label="Close">×</button></header>
      <div class="client-form-pair">
        <label for="ez-contact-title">Title<input id="ez-contact-title" name="title" autocomplete="honorific-prefix"></label>
        <label for="ez-contact-first-name">First name<input id="ez-contact-first-name" name="first_name" autocomplete="given-name" required></label>
      </div>
      <label for="ez-contact-last-name">Last name<input id="ez-contact-last-name" name="last_name" autocomplete="family-name"></label>
      <label for="ez-contact-email">Contact address<input id="ez-contact-email" name="email" type="email" autocomplete="email"></label>
      <div class="client-form-pair">
        <label for="ez-contact-office">Office phone<input id="ez-contact-office" name="phone_office" type="tel" autocomplete="tel"></label>
        <label for="ez-contact-mobile">Mobile phone<input id="ez-contact-mobile" name="phone_mobile" type="tel" autocomplete="tel"></label>
      </div>
      <label for="ez-contact-fax">Fax<input id="ez-contact-fax" name="fax" type="tel"></label>
      <label for="ez-contact-recipient">Invoice routing<select id="ez-contact-recipient" name="invoice_recipient_status"><option value="none">Not an invoice recipient</option><option value="recipient">Recipient</option><option value="cc">CC</option><option value="bcc">BCC</option></select></label>
      <p class="form-result" data-contact-form-result role="status" aria-live="polite"></p>
      <button class="primary-action" type="submit" data-contact-form-submit>Save contact</button>
    </form>
  </dialog>
  <dialog class="client-archive-dialog" data-client-archive-dialog aria-labelledby="client-archive-title">
    <form method="dialog" data-client-archive-form>
      <header><div><p class="eyebrow">Client status</p><h2 id="client-archive-title">Archive this client?</h2></div><button value="cancel" aria-label="Close">×</button></header>
      <p>The client stays in the All view and can no longer be selected as active work.</p>
      <p class="form-result" data-client-archive-result role="status" aria-live="polite"></p>
      <div class="client-confirm-actions"><button value="cancel">Cancel</button><button class="danger-action" type="submit" value="confirm" data-client-archive-confirm>Archive client</button></div>
    </form>
  </dialog>
  <dialog class="contact-delete-dialog" data-contact-delete-dialog aria-labelledby="contact-delete-title">
    <form method="dialog" data-contact-delete-form>
      <header><div><p class="eyebrow">Client contact</p><h2 id="contact-delete-title">Permanently delete this contact?</h2></div><button value="cancel" aria-label="Close">×</button></header>
      <p>This permanently deletes the contact and cannot be undone.</p>
      <p class="form-result" data-contact-delete-result role="status" aria-live="polite"></p>
      <div class="client-confirm-actions"><button value="cancel">Cancel</button><button class="danger-action" type="submit" value="confirm" data-contact-delete-confirm>Delete contact</button></div>
    </form>
  </dialog>`
