import type { ShellTab } from '../shell/render.js'
import type { ReportKind } from './model.js'

const reportKindNames: readonly { readonly kind: ReportKind; readonly label: string }[] = [
  // First, and first for everybody: it is the only kind that answers without a
  // client or project chosen, and for a member it is the whole section.
  { kind: 'my-hours', label: 'My hours' },
  // Second, and first of the firm-wide ones, because it is the report the
  // reference product opens on: one dataset over a period, four ways.
  { kind: 'time', label: 'Time' },
  { kind: 'invoiced', label: 'Invoiced' },
  { kind: 'payments-received', label: 'Payments received' },
  { kind: 'receivables', label: 'Receivables' },
  { kind: 'uninvoiced', label: 'Uninvoiced work' },
  { kind: 'detailed-time', label: 'Detailed time' },
  { kind: 'detailed-expense', label: 'Detailed expense' },
  { kind: 'client-rollup', label: 'Client rollup' },
  // Not a table of figures but a feed of what happened, which is why it sits
  // after the reports that answer "how much" rather than among them.
  { kind: 'activity-log', label: 'Activity log' },
  { kind: 'project-budget', label: 'Project budget' },
  // Last, and the only kind the browser drops for a profile that reads the
  // financial ones: it is entirely cost, so the administrator alone keeps it.
  { kind: 'profitability', label: 'Profitability' },
  { kind: 'contractor-cost', label: 'Contractor cost' },
]

/**
 * The kinds as the section's level-2 strip. They were the first field of the
 * filter card, so which report you were looking at was invisible until you
 * opened the dropdown. Every tab is a real link because the kind is already the
 * address the browser pushes; the browser re-marks the current tab, and drops
 * the kinds a profile cannot read, once whoami has answered.
 */
export const reportKindTabs = (kind: string | null): readonly ShellTab[] =>
  reportKindNames.map((entry) => ({
    label: entry.label,
    href: `/reports?report=${entry.kind}`,
    current: entry.kind === (kind ?? 'uninvoiced'),
  }))

export const renderReportsPage = (view?: string): string => `
  <main class="app-content reports-workspace page--grid" data-reports-page${view === 'reports' ? '' : ' hidden'}>
    <header class="context-row">
      <div><p class="eyebrow">Analysis</p><h1>Reports</h1></div>
      <div class="report-actions"><button type="button" data-saved-reports-open>Saved reports</button><button class="primary-action" type="button" data-report-builder-open>New report</button></div>
    </header>
    <p class="reports-intro">Review live operational totals. Each currency remains separate.</p>
    <form class="report-filters" data-report-form>
      <!--
        The mount point for the shared period control, which replaces the two
        bare From/To fields that stood here. It is empty in the served HTML
        because the control is DOM the way data-table is DOM: one
        implementation, built once, rather than a string copy in every screen's
        renderer that has to be kept in step with the browser one. §6 budgets
        three bands between the tab strip and the first data row, so the period
        takes the filter card's date fields rather than a band of its own.
      -->
      <div class="report-filter-field report-period-field" data-report-period></div>
      <div class="report-filter-field" data-report-catalog-field><label for="ez-report-catalog">Show</label>
        <select id="ez-report-catalog" name="catalog" data-report-catalog>
          <option value="active">Active only</option>
          <option value="all">Active and archived</option>
        </select>
      </div>
      <div class="report-filter-field" data-report-client-field><label for="ez-report-client" data-report-client-label>Client</label>
        <select id="ez-report-client" name="client_id" data-report-client></select>
      </div>
      <div class="report-filter-field" data-report-project-field><label for="ez-report-project" data-report-project-label>Project</label>
        <select id="ez-report-project" name="project_id" data-report-project></select>
      </div>
      <label class="report-filter-field report-check-field" data-report-fixed-fee-field hidden>
        <input type="checkbox" data-report-fixed-fee> Include fixed-fee project hours
      </label>
      <div class="report-filter-field" data-report-invoice-status-field hidden>
        <label for="ez-report-invoice-status">Status</label>
        <select id="ez-report-invoice-status" data-report-invoice-status>
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="open">Open</option>
          <option value="paid">Paid</option>
          <option value="closed">Closed</option>
        </select>
      </div>
      <div class="report-filter-field" data-report-profit-status-field hidden>
        <label for="ez-report-profit-status">Project status</label>
        <select id="ez-report-profit-status" data-report-profit-status>
          <option value="all">All projects</option>
          <option value="active">Active</option>
          <option value="archived">Archived</option>
        </select>
      </div>
      <div class="report-filter-field" data-report-profit-billing-field hidden>
        <label for="ez-report-profit-billing">Billing type</label>
        <select id="ez-report-profit-billing" data-report-profit-billing>
          <option value="">All billing types</option>
          <option value="time_materials">Time &amp; materials</option>
          <option value="fixed_fee">Fixed fee</option>
          <option value="non_billable">Non-billable</option>
        </select>
      </div>
      <div class="report-filter-field" data-report-profit-manager-field hidden>
        <label for="ez-report-profit-manager">Manager ID</label>
        <input id="ez-report-profit-manager" inputmode="numeric" pattern="[1-9][0-9]*" data-report-profit-manager>
      </div>
      <div class="report-filter-field" data-report-profit-tag-field hidden>
        <label for="ez-report-profit-tag">Tag ID</label>
        <input id="ez-report-profit-tag" inputmode="numeric" pattern="[1-9][0-9]*" data-report-profit-tag>
      </div>
      <div class="report-filter-field" data-report-expense-category-field hidden>
        <label for="ez-report-expense-category">Category ID</label>
        <input id="ez-report-expense-category" inputmode="numeric" pattern="[1-9][0-9]*" data-report-expense-category>
      </div>
      <div class="report-filter-field" data-report-expense-user-field hidden>
        <label for="ez-report-expense-user">Teammate ID</label>
        <input id="ez-report-expense-user" inputmode="numeric" pattern="[1-9][0-9]*" data-report-expense-user>
      </div>
      <div class="report-filter-field" data-report-expense-billable-field hidden>
        <label for="ez-report-expense-billable">Billable</label>
        <select id="ez-report-expense-billable" data-report-expense-billable><option value="all">All</option><option value="yes">Billable</option><option value="no">Non-billable</option></select>
      </div>
      <div class="report-filter-field" data-report-expense-reimbursable-field hidden>
        <label for="ez-report-expense-reimbursable">Reimbursable</label>
        <select id="ez-report-expense-reimbursable" data-report-expense-reimbursable><option value="all">All</option><option value="yes">Reimbursable</option><option value="no">Not reimbursable</option></select>
      </div>
      <div class="report-filter-field" data-report-expense-invoice-field hidden>
        <label for="ez-report-expense-invoice">Invoice state</label>
        <select id="ez-report-expense-invoice" data-report-expense-invoice><option value="all">All</option><option value="invoiced">Invoiced</option><option value="uninvoiced">Uninvoiced</option></select>
      </div>
      <label class="report-filter-field report-check-field" data-report-expense-active-field hidden>
        <input type="checkbox" data-report-expense-active> Active projects only
      </label>
      <button class="primary-action" type="submit" data-report-run>Run report</button>
    </form>
    <p class="form-result report-status" data-report-status role="status" aria-live="polite">Loading report…</p>
    <button type="button" data-report-retry hidden>Retry report</button>
    <section class="report-results" data-report-results aria-live="polite" aria-label="Report results"></section>
    <section class="report-saved-library" data-saved-reports-library hidden aria-label="Saved reports">
      <header><h2>Saved reports</h2><button type="button" data-saved-reports-close>Close</button></header>
      <div class="report-actions" role="group" aria-label="Saved report view">
        <button type="button" data-saved-view="all" aria-pressed="true">All</button>
        <button type="button" data-saved-view="yours" aria-pressed="false">Your reports</button>
        <button type="button" data-saved-view="shared" aria-pressed="false">Shared with you</button>
      </div>
      <label>Search <input type="search" data-saved-search></label>
      <label><input type="checkbox" data-saved-custom-only> Custom reports only</label>
      <p data-saved-status role="status"></p><div data-saved-list></div>
    </section>
    <dialog data-report-builder aria-labelledby="report-builder-title">
      <form method="dialog" data-report-builder-form>
        <header><div><p class="eyebrow">New report</p><h2 id="report-builder-title">Custom report builder</h2></div><button type="button" data-report-builder-close aria-label="Close">×</button></header>
        <label>Report type<select data-builder-template><option value="custom">Custom report</option><option value="detailed-time">Detailed time</option><option value="detailed-expense">Detailed expense</option></select></label>
        <label>Name<input data-builder-name required maxlength="200"></label>
        <label>Fields<select multiple data-builder-fields></select></label>
        <div class="report-actions" role="group" aria-label="Order fields"><button type="button" data-builder-fields-up>Field up</button><button type="button" data-builder-fields-down>Field down</button></div>
        <label>Metrics<select multiple data-builder-metrics></select></label>
        <div class="report-actions" role="group" aria-label="Order metrics"><button type="button" data-builder-metrics-up>Metric up</button><button type="button" data-builder-metrics-down>Metric down</button></div>
        <label>Period start<input type="date" data-builder-from required></label>
        <label>Period end<input type="date" data-builder-to required></label>
        <label>Client IDs <input data-builder-clients inputmode="numeric" placeholder="All clients, or 2, 7"></label>
        <label>Project IDs <input data-builder-projects inputmode="numeric" placeholder="All projects, or 10, 14"></label>
        <label>Group by<select data-builder-group><option value="">Ungrouped</option><option value="client">Client</option><option value="project">Project</option><option value="task">Task</option><option value="user">Teammate</option><option value="date">Date</option></select></label>
        <label>Result<select data-builder-result><option value="summary">Summary</option><option value="detailed">Detailed</option></select></label>
        <label><input type="checkbox" data-builder-grouped checked> Grouped</label>
        <label><input type="checkbox" data-builder-zero> Include zero values</label>
        <p data-builder-status role="status"></p>
        <footer><button type="button" data-builder-preview>Preview</button><button class="primary-action" type="submit">Save report</button></footer>
      </form>
    </dialog>
  </main>`
