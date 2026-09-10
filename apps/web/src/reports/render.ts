import type { ShellTab } from '../shell/render.js'
import type { ReportKind } from './model.js'

const reportKindNames: readonly { readonly kind: ReportKind; readonly label: string }[] = [
  // First, and first for everybody: it is the only kind that answers without a
  // client or project chosen, and for a member it is the whole section.
  { kind: 'my-hours', label: 'My hours' },
  { kind: 'uninvoiced', label: 'Uninvoiced work' },
  { kind: 'client-rollup', label: 'Client rollup' },
  { kind: 'project-budget', label: 'Project budget' },
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
    </header>
    <p class="reports-intro">Review live operational totals. Each currency remains separate.</p>
    <form class="report-filters" data-report-form>
      <div class="report-filter-field"><label for="ez-report-from">From</label><input id="ez-report-from" name="from" type="date" data-report-from required></div>
      <div class="report-filter-field"><label for="ez-report-to">To</label><input id="ez-report-to" name="to" type="date" data-report-to required></div>
      <div class="report-filter-field"><label for="ez-report-catalog">Show</label>
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
      <button class="primary-action" type="submit" data-report-run>Run report</button>
    </form>
    <p class="form-result report-status" data-report-status role="status" aria-live="polite">Loading report…</p>
    <button type="button" data-report-retry hidden>Retry report</button>
    <section class="report-results" data-report-results aria-live="polite" aria-label="Report results"></section>
  </main>`
