import { dateInTimeZone } from '@ezacto/core'
import type { Whoami } from '@conflict-hq/ezacto-client'
import { detailedExpenseCsv } from '../reports/model.js'
import type { SessionPresenter } from '../session.js'
import type { CompanySettingsApi } from './model.js'
interface ModuleState {
  module: string
  enabled: boolean
}
interface ActiveSession extends SessionPresenter {
  identity: Whoami
  signal: AbortSignal
}
interface BulkAction {
  id: string
  label: string
  description: string
  href: string
  module?: 'approval'
}
export const companyBulkActions: readonly BulkAction[] = [
  {
    id: 'approve-weeks',
    label: 'Approve selected weeks',
    description:
      'Review pending submissions, select the weeks, and confirm the approval in Approvals.',
    href: '/approvals',
    module: 'approval',
  },
  {
    id: 'mark-invoiced',
    label: 'Mark selected time invoiced',
    description:
      'Select uninvoiced entries in the detailed time report, choose the invoice, and confirm.',
    href: '/reports?report=detailed-time&grain=entry&hours=uninvoiced',
  },
  {
    id: 'mark-uninvoiced',
    label: 'Mark selected time uninvoiced',
    description:
      'Review invoiced entries in the detailed time report before releasing their invoice association.',
    href: '/reports?report=detailed-time&grain=entry&invoice_state=invoiced',
  },
  {
    id: 'move-time',
    label: 'Move selected time',
    description:
      'Select entries in the detailed time report, choose the destination project and task, and confirm.',
    href: '/reports?report=detailed-time&grain=entry',
  },
]
export const renderCompanyDataTools = () => `
<section class="settings-section" data-settings-section="import-export" aria-labelledby="settings-data-title">
 <header><h2 id="settings-data-title">Import and export</h2><p>Download authorized report data, or use the operator migration tool to bring time into this instance.</p></header>
 <p class="form-result" data-settings-data-status role="status" aria-live="polite">Loading available exports…</p>
 <div data-settings-data-content hidden>
  <form class="settings-form" data-settings-data-export>
   <h3>Report files</h3>
   <p class="hint" data-settings-data-zone></p>
   <label>From<input type="date" data-settings-data-from required></label>
   <label>Through<input type="date" data-settings-data-to required></label>
   <label class="settings-toggle"><input type="checkbox" data-settings-data-internal>Include internal notes in time exports</label>
   <p class="hint">Time files include client-visible notes by default. Expense CSV matches the authorized detailed expense report, including its notes and currencies.</p>
   <div class="settings-data-actions">
    <button type="button" class="primary-action" data-settings-data-download="time-csv">Time CSV</button>
    <button type="button" class="secondary-action" data-settings-data-download="time-xlsx">Time Excel</button>
    <button type="button" class="secondary-action" data-settings-data-download="expense-csv">Expense CSV</button>
   </div>
   <p class="hint" data-settings-data-expenses></p>
   <p class="form-result" data-settings-data-result role="status" aria-live="polite"></p>
  </form>
  <h3>Other exports and recovery</h3>
  <ul><li><a href="/reports?report=detailed-time&grain=entry">Reports with client, project and person filters</a></li>
   <li><a data-settings-data-activity href="/settings/activity">Activity log and its CSV export</a><span data-settings-data-activity-off hidden>Activity log is disabled.</span></li>
   <li><a href="/settings/company#backup">Backup downloads, off-site status and recovery guidance</a></li></ul>
  <h3>CSV time imports</h3>
  <p>Run a dry run from the operator checkout before applying a file. CSV import covers people, clients, projects, tasks and time; it does not import invoices, payments, expenses or credentials.</p>
  <pre class="settings-data-command"><code>npm ci
npm run build -w ./packages/migrate
node packages/migrate/dist/cli.js import-csv --database /data/db.sqlite --file time.csv --dry-run</code></pre>
  <p><a href="https://ezacto.dev/docs/csv-import/" target="_blank" rel="noopener">CSV format and import guide</a></p>
  <h3>Move from Harvest</h3>
  <p>Use the migration guide to extract, verify, rehearse, reconcile and cut over. Keep credentials and snapshots on the operator's machine.</p>
  <p><a href="https://ezacto.dev/docs/migrating-from-harvest/" target="_blank" rel="noopener">Harvest migration and parallel-run guide</a></p>
 </div>
</section>
<section class="settings-section" data-settings-section="bulk-actions" aria-labelledby="settings-bulk-title">
 <header><h2 id="settings-bulk-title">Bulk actions</h2><p>Open a workflow to choose records and review the change. Permissions, invoice rules and locked periods are checked there.</p></header>
 <p class="form-result" data-settings-bulk-status role="status" aria-live="polite">Loading available actions…</p>
 <ul class="settings-bulk-actions" data-settings-bulk-actions hidden></ul>
</section>`
const validDate = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/u.test(value) &&
  Number.isFinite(Date.parse(value + 'T00:00:00Z')) &&
  new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value
export const createCompanyDataTools = (
  api: Pick<
    CompanySettingsApi,
    'downloadDetailedTimeReport' | 'getDetailedExpenseReport' | 'getTimesheetLockPolicy'
  >,
  modules: (signal: AbortSignal) => Promise<readonly ModuleState[]>,
) => {
  const required = <T extends HTMLElement>(selector: string) => {
    const found = document.querySelector<T>(selector)
    if (!found) throw new Error('Missing company data tools: ' + selector)
    return found
  }
  const status = required('[data-settings-data-status]'),
    content = required('[data-settings-data-content]'),
    form = required<HTMLFormElement>('[data-settings-data-export]'),
    from = required<HTMLInputElement>('[data-settings-data-from]'),
    to = required<HTMLInputElement>('[data-settings-data-to]'),
    internal = required<HTMLInputElement>('[data-settings-data-internal]'),
    result = required('[data-settings-data-result]'),
    zoneLabel = required('[data-settings-data-zone]'),
    expenseNote = required('[data-settings-data-expenses]'),
    activity = required<HTMLAnchorElement>('[data-settings-data-activity]'),
    activityOff = required('[data-settings-data-activity-off]'),
    bulkStatus = required('[data-settings-bulk-status]'),
    list = required<HTMLUListElement>('[data-settings-bulk-actions]')
  const buttons = [...form.querySelectorAll<HTMLButtonElement>('[data-settings-data-download]')]
  let session: ActiveSession | null = null,
    expenses = false,
    busy = false
  const paintButtons = () => {
    for (const button of buttons)
      button.disabled =
        busy ||
        (button.dataset.settingsDataDownload === 'expense-csv'
          ? !expenses || !api.getDetailedExpenseReport
          : !api.downloadDetailedTimeReport)
  }
  const clear = () => {
    session = null
    expenses = false
    busy = false
    content.hidden = list.hidden = true
    list.replaceChildren()
    from.value = to.value = ''
    internal.checked = false
    result.textContent = ''
    status.textContent = bulkStatus.textContent =
      'Sign in as an administrator to use company data tools.'
    paintButtons()
  }
  const observe = (active: ActiveSession) => {
    if (session === active) return
    clear()
    session = active
    active.signal.addEventListener(
      'abort',
      () => {
        if (session === active) clear()
      },
      { once: true },
    )
  }
  const download = async (kind: string) => {
    const active = session
    if (!active || active.signal.aborted || active.identity.profile !== 'administrator' || busy)
      return
    if (!validDate(from.value) || !validDate(to.value) || from.value > to.value) {
      result.textContent = 'Choose real dates with From on or before Through.'
      return
    }
    const range = { from: from.value, to: to.value }
    busy = true
    paintButtons()
    result.textContent = 'Preparing the export…'
    try {
      let file: { blob: Blob; filename: string }
      if (kind === 'expense-csv') {
        if (!expenses || !api.getDetailedExpenseReport)
          throw new Error('Expense exports are unavailable while the Expenses module is off.')
        const report = await api.getDetailedExpenseReport(range, active.signal)
        file = {
          blob: new Blob([detailedExpenseCsv(report)], { type: 'text/csv;charset=utf-8' }),
          filename: `detailed-expense-${range.from}-to-${range.to}.csv`,
        }
      } else {
        if (!api.downloadDetailedTimeReport)
          throw new Error('Time file exports are unavailable on this deployment.')
        file = await api.downloadDetailedTimeReport(
          { ...range, grain: 'entry' },
          kind === 'time-xlsx' ? 'xlsx' : 'csv',
          internal.checked ? 'internal' : 'client',
          active.signal,
        )
      }
      if (session !== active || active.signal.aborted) return
      active.present(() => {
        const href = URL.createObjectURL(file.blob),
          link = document.createElement('a')
        link.href = href
        link.download = file.filename
        link.click()
        setTimeout(() => URL.revokeObjectURL(href), 0)
        result.textContent = `Downloaded ${file.filename}.`
      })
    } catch (error) {
      active.presentFailure(error, () => {
        result.textContent =
          'The export could not be downloaded. Check the date range and permissions, then try again.'
      })
    } finally {
      if (session === active) {
        busy = false
        paintButtons()
      }
    }
  }
  for (const button of buttons)
    button.addEventListener('click', () => void download(button.dataset.settingsDataDownload!))
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void download('time-csv')
  })
  return {
    clear,
    async loadExports(active: ActiveSession) {
      observe(active)
      if (active.identity.profile !== 'administrator') {
        status.textContent = 'Only administrators can use company import and export.'
        return
      }
      content.hidden = true
      status.textContent = 'Loading available exports…'
      const [flags, policy] = await Promise.all([
        modules(active.signal),
        api.getTimesheetLockPolicy?.(active.signal),
      ])
      const zone = policy?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
      if (session !== active || active.signal.aborted) return
      const today = dateInTimeZone(new Date().toISOString(), zone)
      active.present(() => {
        expenses = flags.some((flag) => flag.module === 'expenses' && flag.enabled)
        from.value = today.slice(0, 8) + '01'
        to.value = today
        zoneLabel.textContent = `Default dates use ${zone}; From and Through are inclusive.`
        activity.hidden = !flags.some((flag) => flag.module === 'activity_log' && flag.enabled)
        activityOff.hidden = !activity.hidden
        expenseNote.textContent = expenses
          ? 'Expense exports include amounts in each recorded currency.'
          : 'Expense CSV is unavailable while the Expenses module is off.'
        paintButtons()
        content.hidden = false
        status.textContent = ''
      })
    },
    async loadBulk(active: ActiveSession) {
      observe(active)
      if (active.identity.profile !== 'administrator') {
        bulkStatus.textContent = 'Only administrators can view the company bulk-actions catalog.'
        return
      }
      list.hidden = true
      bulkStatus.textContent = 'Loading available actions…'
      const flags = await modules(active.signal)
      if (session !== active || active.signal.aborted) return
      active.present(() => {
        list.replaceChildren(
          ...companyBulkActions.map((action) => {
            const item = document.createElement('li'),
              heading = document.createElement('h3'),
              detail = document.createElement('p')
            heading.textContent = action.label
            detail.textContent = action.description
            item.appendChild(heading)
            item.appendChild(detail)
            if (
              action.module &&
              !flags.some((flag) => flag.module === action.module && flag.enabled)
            ) {
              const disabled = document.createElement('p')
              disabled.textContent = 'Unavailable while Timesheet approval is off.'
              item.appendChild(disabled)
            } else {
              const link = document.createElement('a')
              link.href = action.href
              link.textContent =
                action.id === 'approve-weeks' ? 'Open Approvals' : 'Open detailed time report'
              item.appendChild(link)
            }
            return item
          }),
        )
        list.hidden = false
        bulkStatus.textContent = 'Opening a workflow does not apply an action.'
      })
    },
  }
}
