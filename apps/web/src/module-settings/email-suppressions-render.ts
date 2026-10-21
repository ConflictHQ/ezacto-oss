export const renderEmailSuppressionReview = (): string => `
<div data-email-suppression-review hidden>
  <h3>Suppressed recipients</h3>
  <p class="hint">Permanent bounces and complaints block future mail to that address across every transport. A message naming a suppressed recipient fails as a whole. Allow delivery again only after reviewing the recipient’s circumstances.</p>
  <button type="button" data-email-suppression-refresh>Refresh suppressed recipients</button>
  <p class="form-result" data-email-suppression-status role="status" aria-live="polite"></p>
  <div class="settings-table" data-email-suppression-list></div>
  <button type="button" data-email-suppression-more hidden>Load more suppressed recipients</button>
  <p class="form-result" data-email-suppression-result role="status" aria-live="polite"></p>
  <dialog class="settings-token-dialog" data-email-suppression-dialog aria-labelledby="email-suppression-title">
    <form class="settings-form" data-email-suppression-form novalidate>
      <h3 id="email-suppression-title">Allow future email</h3>
      <p data-email-suppression-recipient></p>
      <p class="hint">This acknowledges the feedback currently shown. New provider feedback can suppress the address again. Failed messages keep their delivery history. This review does not remove a provider’s own suppression or send mail.</p>
      <label>Reason for allowing delivery again<textarea name="note" rows="3" required maxlength="1000"></textarea></label>
      <label data-email-suppression-confirm-row hidden>Type the email address to acknowledge its complaint<input name="confirmation" type="text" autocomplete="off" maxlength="254"></label>
      <p class="form-result" data-email-suppression-dialog-result role="status" aria-live="polite"></p>
      <div class="dialog-actions"><button type="button" data-email-suppression-cancel>Cancel</button><button type="submit" class="primary-action">Allow future email</button></div>
    </form>
  </dialog>
</div>`
