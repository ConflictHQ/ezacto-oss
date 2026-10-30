/**
 * The Saved tab of Reports (#933): saved views of reports as a table, and the
 * pinned ones as quick links above a report. Drawing only; the controller in
 * browser.ts owns the requests and the dialogs these actions open.
 */
import type { SavedReport } from '@conflict-hq/ezacto-client'
import { renderDataTable } from '../components/data-table.js'
import { reportKindLabel } from './render.js'

/** Who can open a saved report, from the viewer's side of it. */
export const sharingSummary = (report: SavedReport): string => {
  if (!report.owned_by_viewer) return report.shared ? 'Shared with you' : 'Visible to you as an administrator'
  const count = report.shared_with.users.length + report.shared_with.profiles.length
  return count === 0 ? 'Private' : `Shared with ${count}`
}

/**
 * Where a saved view opens: the report's own address, with a pointer back to
 * the saved report so the page can offer to save changes to it. The report then
 * runs through its own API under the viewer's current permissions.
 */
export const savedReportHref = (report: Pick<SavedReport, 'id' | 'view'>): string | null => {
  if (report.view === null) return null
  const params = new URLSearchParams(report.view.query)
  params.set('report', report.view.report)
  params.set('saved', report.id)
  return `/reports?${params}`
}

export interface SavedScreenActions {
  readonly open: (report: SavedReport) => void
  readonly rename: (report: SavedReport) => void
  readonly pin: (report: SavedReport) => void
  readonly share: (report: SavedReport) => void
  readonly duplicate: (report: SavedReport) => void
  readonly remove: (report: SavedReport) => void
}

const text = (tag: 'span', value: string, className: string): HTMLElement => {
  const element = document.createElement(tag)
  element.className = className
  element.textContent = value
  return element
}

export const renderSavedViewsTable = (
  reports: readonly SavedReport[],
  actions: SavedScreenActions,
): HTMLElement =>
  renderDataTable<SavedReport>({
    caption: 'Saved reports',
    table: 'saved-reports',
    defaultSort: { column: 'updated', direction: 'descending' },
    rowKey: (report) => report.id,
    rows: reports,
    empty: 'No saved reports match. Save one from any report with Save report.',
    columns: [
      {
        key: 'name',
        label: 'Name',
        wrap: true,
        sortValue: (report) => report.name,
        render: (report) => {
          const cell = document.createElement('span')
          const href = savedReportHref(report)
          if (href === null) cell.append(report.name)
          else {
            const link = document.createElement('a')
            link.href = href
            link.textContent = report.name
            cell.append(link)
          }
          if (report.pinned) cell.append(' ', text('span', 'Pinned', 'report-saved-audience'))
          return cell
        },
      },
      {
        key: 'report',
        label: 'Report',
        fit: true,
        sortValue: (report) => (report.view === null ? null : reportKindLabel(report.view.report)),
        render: (report) => (report.view === null ? '' : reportKindLabel(report.view.report)),
      },
      {
        key: 'owner',
        label: 'Owner',
        fit: true,
        sortValue: (report) => String(report.owner['name'] ?? ''),
        render: (report) => String(report.owner['name'] ?? 'Unknown owner'),
      },
      {
        key: 'shared',
        label: 'Shared',
        fit: true,
        sortValue: (report) => sharingSummary(report),
        render: sharingSummary,
      },
      {
        key: 'updated',
        label: 'Updated',
        fit: true,
        sortValue: (report) => report.updated_at,
        render: (report) => report.updated_at.slice(0, 10),
      },
    ],
    actions: (report) => [
      { label: 'Open', primary: true, onSelect: () => actions.open(report) },
      { label: report.pinned ? 'Unpin' : 'Pin', primary: true, onSelect: () => actions.pin(report) },
      ...(report.owned_by_viewer
        ? [
            { label: 'Rename', onSelect: () => actions.rename(report) },
            { label: 'Share…', onSelect: () => actions.share(report) },
          ]
        : []),
      { label: 'Duplicate', onSelect: () => actions.duplicate(report) },
      ...(report.can_delete ? [{ label: 'Delete', onSelect: () => actions.remove(report) }] : []),
    ],
  })

/** The viewer's pinned views, as links above the report they sit on. */
export const renderQuickLinks = (container: HTMLElement, reports: readonly SavedReport[]): void => {
  const pinned = reports.filter((report) => report.pinned && report.view !== null)
  container.replaceChildren(
    ...pinned.map((report) => {
      const link = document.createElement('a')
      link.href = savedReportHref(report) ?? '/reports'
      link.textContent = report.name
      return link
    }),
  )
  container.hidden = pinned.length === 0
}
