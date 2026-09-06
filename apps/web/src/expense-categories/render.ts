export const renderExpenseCategoriesPage = (view?: string): string => `
  <main class="app-content expense-category-workspace" data-expense-categories-page${view === 'expense-categories' ? '' : ' hidden'}>
    <header class="context-row expense-category-header">
      <div><p class="eyebrow">Expenses</p><h1>Expense categories</h1></div>
      <a href="/expenses">Back to expenses</a>
    </header>
    <p class="expense-category-intro">Define how each kind of expense is entered. Existing expenses keep their category when a category is archived.</p>
    <section class="expense-module-unavailable" data-expense-category-module-unavailable hidden>
      <h2>Expense categories are unavailable</h2>
      <p>The expenses module is not enabled for this organization.</p>
    </section>
    <div data-expense-category-content>
      <section class="expense-category-create" data-expense-category-write hidden aria-labelledby="expense-category-create-heading">
        <header><div><p class="eyebrow">Administrator</p><h2 id="expense-category-create-heading">Add a category</h2></div></header>
        <form class="expense-category-form" data-expense-category-create-form>
          <label>Name<input name="name" maxlength="255" autocomplete="off" required></label>
          <label>Entry method<select name="mode"><option value="direct">Enter an amount on each expense</option><option value="unit">Enter units at a fixed price</option></select></label>
          <div class="expense-category-unit-fields" data-expense-category-create-unit-fields hidden>
            <label>Unit name<input name="unit_name" maxlength="255" autocomplete="off" placeholder="mile"></label>
            <label>Unit price (cents)<input name="unit_price_cents" inputmode="numeric" pattern="[0-9]+" min="0" step="1" placeholder="67"></label>
          </div>
          <button class="primary-action" type="submit" data-expense-category-create-submit>Create category</button>
          <p class="form-result" data-expense-category-create-result role="status" aria-live="polite"></p>
        </form>
      </section>
      <section class="expense-category-directory" aria-labelledby="expense-category-list-heading">
        <header class="expense-category-directory-header">
          <div><p class="eyebrow">Directory</p><h2 id="expense-category-list-heading">Categories</h2></div>
          <div class="expense-category-filter" role="group" aria-label="Category status">
            <button type="button" data-expense-category-filter="active" aria-pressed="true">Active</button>
            <button type="button" data-expense-category-filter="all" aria-pressed="false">All</button>
          </div>
        </header>
        <p class="form-result expense-category-status" data-expense-category-status role="status" aria-live="polite">Loading categories…</p>
        <div data-expense-category-list></div>
        <div class="expense-category-list-actions">
          <button type="button" data-expense-category-load-more hidden>Load more categories</button>
          <button type="button" data-expense-category-retry hidden>Retry loading categories</button>
        </div>
      </section>
    </div>
  </main>
  <dialog class="project-dialog expense-category-dialog" data-expense-category-edit-dialog aria-labelledby="expense-category-edit-title">
    <form class="expense-category-form" data-expense-category-edit-form>
      <header><div><p class="eyebrow">Expense category</p><h2 id="expense-category-edit-title">Edit category</h2></div><button type="button" data-dialog-close aria-label="Close">×</button></header>
      <label>Name<input name="name" maxlength="255" autocomplete="off" required></label>
      <label>Entry method<select name="mode"><option value="direct">Enter an amount on each expense</option><option value="unit">Enter units at a fixed price</option></select></label>
      <div class="expense-category-unit-fields" data-expense-category-edit-unit-fields hidden>
        <label>Unit name<input name="unit_name" maxlength="255" autocomplete="off" placeholder="mile"></label>
        <label>Unit price (cents)<input name="unit_price_cents" inputmode="numeric" pattern="[0-9]+" min="0" step="1"></label>
      </div>
      <div class="expense-category-dialog-actions"><button class="primary-action" type="submit" data-expense-category-edit-submit>Save category</button><button type="button" data-dialog-close>Cancel</button></div>
      <p class="form-result" data-expense-category-edit-result role="status" aria-live="polite"></p>
    </form>
  </dialog>
  <dialog class="project-dialog expense-category-dialog" data-expense-category-archive-dialog aria-labelledby="expense-category-archive-title">
    <form data-expense-category-archive-form>
      <header><div><p class="eyebrow">Archive category</p><h2 id="expense-category-archive-title">Archive this category?</h2></div><button type="button" data-dialog-close aria-label="Close">×</button></header>
      <p>The category will no longer be available for new expenses. Existing expenses keep their category and label.</p>
      <div class="expense-category-dialog-actions"><button class="primary-action" type="submit" name="confirmation" value="confirm" data-expense-category-archive-confirm>Archive category</button><button type="submit" name="confirmation" value="cancel">Cancel</button></div>
      <p class="form-result" data-expense-category-archive-result role="status" aria-live="polite"></p>
    </form>
  </dialog>`
