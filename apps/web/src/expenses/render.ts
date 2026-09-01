export const renderExpenseWorkflowPages = (view?: string): string => `
  <main class="app-content expense-workspace" data-expense-list-page${view === 'expense-list' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">Money out</p><h1>Expenses</h1></div>
    </header>
    <p class="expense-intro">Record your own expenses, then narrow the list by work, category, approval, or reimbursement status.</p>
    <section class="expense-module-unavailable" data-expense-module-unavailable hidden>
      <h2>Expenses are unavailable</h2>
      <p>The expenses module is not enabled for this organization.</p>
    </section>
    <section class="expense-create-panel" data-expense-create-panel aria-labelledby="expense-create-heading">
      <header><div><p class="eyebrow">New expense</p><h2 id="expense-create-heading">Add an expense</h2></div></header>
      <form class="expense-form" data-expense-create-form>
        <label>Project<select name="project_id" data-expense-create-project required></select></label>
        <label>Category<select name="expense_category_id" data-expense-create-category required></select></label>
        <label>Date<input name="spent_date" type="date" required></label>
        <label data-expense-create-value-label>Amount<input name="expense_value" inputmode="decimal" required></label>
        <label class="expense-wide-field">Notes<textarea name="notes" rows="3" maxlength="10000"></textarea></label>
        <label class="expense-check"><input name="billable" type="checkbox">Billable</label>
        <label class="expense-check"><input name="reimbursable" type="checkbox">Reimbursable</label>
        <button class="primary-action" type="submit" data-expense-create-submit>Add expense</button>
        <p class="form-result expense-wide-field" data-expense-create-result role="status" aria-live="polite"></p>
      </form>
    </section>
    <form class="expense-filter-form" data-expense-filter-form>
      <label>From<input name="from" type="date"></label>
      <label>To<input name="to" type="date"></label>
      <label>Client<select name="client_id"><option value="">All clients</option></select></label>
      <label>Project<select name="project_id"><option value="">All projects</option></select></label>
      <label>Category<select name="expense_category_id"><option value="">All categories</option></select></label>
      <label>Approval<select name="approval_status"><option value="">All approval states</option><option value="unsubmitted">Unsubmitted</option><option value="submitted">Submitted</option><option value="approved">Approved</option></select></label>
      <label>Reimbursement<select name="reimbursement_status"><option value="">All reimbursement states</option><option value="none">None</option><option value="pending">Pending</option><option value="approved">Approved</option><option value="paid">Paid</option></select></label>
      <div class="expense-filter-actions"><button class="primary-action" type="submit">Apply filters</button><button type="button" data-expense-filter-reset>Reset</button></div>
    </form>
    <p class="form-result expense-page-status" data-expense-list-status role="status" aria-live="polite">Loading expenses…</p>
    <ol class="expense-list" data-expense-list aria-label="Expenses"></ol>
    <button type="button" data-expense-load-more hidden>Load more expenses</button>
    <button type="button" data-expense-list-retry hidden>Retry loading expenses</button>
  </main>
  <main class="app-content expense-workspace" data-expense-detail-page${view === 'expense-detail' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">Expenses</p><h1>Expense detail</h1></div>
      <a href="/expenses">Back to expenses</a>
    </header>
    <section class="expense-module-unavailable" data-expense-module-unavailable hidden>
      <h2>Expenses are unavailable</h2>
      <p>The expenses module is not enabled for this organization.</p>
    </section>
    <p class="form-result expense-page-status" data-expense-detail-status role="status" aria-live="polite">Loading expense…</p>
    <article class="expense-detail" data-expense-detail hidden>
      <section class="expense-edit-panel" aria-labelledby="expense-edit-heading">
        <header><div><p class="eyebrow">Your expense</p><h2 id="expense-edit-heading">Entry and notes</h2></div><span class="expense-status-pill" data-expense-detail-approval>—</span></header>
        <p class="expense-lock-message" data-expense-lock-message hidden></p>
        <form class="expense-form" data-expense-edit-form>
          <label>Project<select name="project_id" required></select></label>
          <label>Category<select name="expense_category_id" data-expense-edit-category required></select></label>
          <label>Date<input name="spent_date" type="date" required></label>
          <label data-expense-edit-value-label>Amount<input name="expense_value" inputmode="decimal" required></label>
          <label class="expense-wide-field">Notes<textarea name="notes" rows="5" maxlength="10000"></textarea></label>
          <label class="expense-check"><input name="billable" type="checkbox">Billable</label>
          <label class="expense-check"><input name="reimbursable" type="checkbox">Reimbursable</label>
          <button class="primary-action" type="submit" data-expense-edit-submit>Save expense</button>
          <p class="form-result expense-wide-field" data-expense-edit-result role="status" aria-live="polite"></p>
        </form>
        <dl class="expense-state-facts">
          <div><dt>Approval</dt><dd data-expense-detail-approval-fact>—</dd></div>
          <div><dt>Reimbursement</dt><dd data-expense-detail-reimbursement>—</dd></div>
          <div><dt>Invoice</dt><dd data-expense-detail-invoice>—</dd></div>
          <div><dt>Total</dt><dd data-expense-detail-total>—</dd></div>
        </dl>
      </section>
      <section class="expense-attachments" aria-labelledby="expense-attachments-heading">
        <header><div><p class="eyebrow">Receipt files</p><h2 id="expense-attachments-heading">Receipts</h2></div></header>
        <form data-expense-attachment-form>
          <label>Attach a receipt<input name="file" type="file" required></label>
          <button type="submit" data-expense-attachment-submit>Upload receipt</button>
          <p class="hint">One file, up to 25 MB.</p>
        </form>
        <p class="form-result" data-expense-attachment-status role="status" aria-live="polite"></p>
        <ul data-expense-attachments></ul>
      </section>
    </article>
    <button type="button" data-expense-detail-retry hidden>Retry loading expense</button>
  </main>`
