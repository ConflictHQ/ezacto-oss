export const renderDeletionRequests = () => `
  <section aria-labelledby="deletion-requests-title" data-deletion-requests hidden>
    <h3 id="deletion-requests-title">Account deletion requests</h3>
    <p>Requests remain here even when email is unavailable. An initial response target is not a promised completion date. Changing status does not close access or erase data.</p>
    <button type="button" data-deletion-refresh>Refresh requests</button>
    <p role="status" aria-live="polite" data-deletion-status></p>
    <ul data-deletion-list></ul>
    <button type="button" data-deletion-more hidden>Load more requests</button>
    <section data-deletion-detail hidden>
      <h4 data-deletion-heading></h4>
      <div data-deletion-disclosure></div>
      <p data-deletion-notification></p>
      <button type="button" data-deletion-retry>Retry administrator notification</button>
      <form data-deletion-form>
        <label for="deletion-request-status">Status</label><select id="deletion-request-status" name="status"><option value="pending">Pending</option><option value="in_progress">In progress</option><option value="action_required">Action required</option></select>
        <label>Message shown to the requester<textarea name="message" rows="3" maxlength="5000"></textarea></label>
        <p class="hint">Explain required actions and timing. Avoid unnecessary personal information; this message is retained in the request history.</p>
        <label>Expected completion date, if established (UTC)<input type="date" name="completion_date"></label>
        <p class="hint">Leave empty if you have not established a date. Publishing a target does not extend legal deadlines.</p>
        <button type="submit">Save request update</button>
      </form>
      <p role="status" aria-live="polite" data-deletion-result></p>
      <section aria-label="Account closure" data-account-closure>
        <h4>Close account access</h4>
        <p>Review this person's actual records before closing access. This permanently removes local sign-in credentials and unnecessary profile fields. Retained records, Apple authorization, external systems and backups need separate review.</p>
        <button type="button" data-closure-review>Review account closure</button>
        <div data-closure-inventory></div>
        <form data-closure-form hidden>
          <label><input type="checkbox" name="acknowledged" required> I reviewed the actual retained records and current operator policy. The documented reasons, periods and review targets apply to this person. I understand access closure is irreversible and does not confirm that all data was erased.</label>
          <button type="submit">Close access and erase local credentials</button>
        </form>
        <p role="status" aria-live="polite" data-closure-result></p>
      </section>
    </section>
  </section>`;
