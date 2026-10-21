export const renderClientRateCard = (): string => `
<section class="client-sending" data-client-rate-card hidden aria-labelledby="client-rate-card-heading">
  <h2 id="client-rate-card-heading">Hourly rate card</h2>
  <p data-rate-card-name></p>
  <p class="hint">Card rates apply to projects billed by people using default rates. A person’s assignment override wins. Inheritance follows the worked-for parent, independently of bill-to.</p>
  <p class="form-result" data-rate-card-status role="status" aria-live="polite"></p>
  <button type="button" data-rate-card-reload>Refresh rate card</button>
  <div data-rate-card-history></div>
  <form class="client-sending-form" data-rate-card-create hidden>
    <label>Card name<input name="name" maxlength="200" required></label>
    <button type="submit">Create card for this client</button>
  </form>
  <form class="client-sending-form" data-rate-card-version hidden novalidate>
    <h3>Publish a new version</h3>
    <p class="hint">New entries use the version effective on their work date. Existing hours and invoices keep their captured rates.</p>
    <label>Effective from<input type="date" name="start_date"></label>
    <p class="hint" data-rate-card-date-hint></p>
    <fieldset data-rate-card-edit-lines><legend>Hourly rates</legend>
      <p class="hint" data-rate-card-currency></p>
      <div data-rate-card-lines></div>
      <button type="button" data-rate-card-add>Add task rate</button>
    </fieldset>
    <label class="settings-toggle"><input type="checkbox" name="retire">Retire this card from this date; use an inherited card or the person’s default instead</label>
    <button type="submit">Publish version</button>
  </form>
  <form class="client-sending-form" data-rate-card-preview>
    <h3>Preview the matching card</h3>
    <label>Task<select name="task_id" required></select></label>
    <label>Work date<input type="date" name="spent_date" required></label>
    <button type="submit">Preview rate</button>
    <p class="form-result" data-rate-card-preview-result role="status" aria-live="polite"></p>
  </form>
</section>`
