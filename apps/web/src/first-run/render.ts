export const renderFirstRunChecklist = (): string => `
  <section class="first-run-checklist" data-first-run-checklist aria-labelledby="first-run-heading" hidden>
    <header>
      <div><p class="eyebrow">Getting started</p><h2 id="first-run-heading">Log your first time entry</h2></div>
      <button type="button" data-first-run-dismiss>Dismiss setup guide</button>
    </header>
    <p>Follow these steps in order. This guide checks your saved setup each time you open it.</p>
    <ol data-first-run-steps></ol>
    <p data-first-run-status role="status" aria-live="polite"></p>
    <button type="button" data-first-run-refresh>Check setup again</button>
  </section>`
