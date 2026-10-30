import type { EmailSuppression, Whoami } from '@conflict-hq/ezacto-client'
import { renderDataTable } from '../components/data-table.js'
import { apiErrorMessage, type CompanySettingsApi } from './model.js'
interface Context {
  identity: Whoami
  signal: AbortSignal
  failed(error: unknown, paint: () => void): void
}
type Api = Pick<CompanySettingsApi, 'listEmailSuppressions' | 'liftEmailSuppression'>
export const createEmailSuppressionController = (
  api: Api,
): { clear(): void; activate(context: Context): Promise<void> } => {
  const root = document.querySelector<HTMLElement>('[data-email-suppression-review]')
  if (!root) return { clear: () => {}, activate: async () => {} }
  const query = <T extends Element>(selector: string): T => root.querySelector<T>(selector)!
  const status = query<HTMLElement>('[data-email-suppression-status]')
  const list = query<HTMLElement>('[data-email-suppression-list]')
  const result = query<HTMLElement>('[data-email-suppression-result]')
  const more = query<HTMLButtonElement>('[data-email-suppression-more]')
  const dialog = query<HTMLDialogElement>('[data-email-suppression-dialog]')
  const form = query<HTMLFormElement>('[data-email-suppression-form]')
  const note = form.elements.namedItem('note') as HTMLTextAreaElement
  const confirmation = form.elements.namedItem('confirmation') as HTMLInputElement
  const dialogResult = query<HTMLElement>('[data-email-suppression-dialog-result]')
  let context: Context | null = null
  let rows: EmailSuppression[] = []
  let next: string | null = null
  let selected: EmailSuppression | null = null
  let pending = false
  const current = (active: Context): boolean => context === active && !active.signal.aborted
  const busy = (value: boolean): void => {
    pending = value
    for (const control of root.querySelectorAll<
      HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement
    >('button,input,textarea'))
      control.disabled = value
  }
  const clear = (): void => {
    context = null
    rows = []
    next = null
    selected = null
    busy(false)
    root.hidden = true
    status.textContent = ''
    result.textContent = ''
    list.replaceChildren()
    form.reset()
    dialogResult.textContent = ''
    query<HTMLElement>('[data-email-suppression-recipient]').textContent = ''
    if (dialog.open) dialog.close()
    more.hidden = true
  }
  const render = (): void => {
    list.replaceChildren(
      renderDataTable<EmailSuppression>({
        caption: 'Suppressed email recipients',
        table: 'email-suppressions',
        rows,
        rowKey: (row) => String(row.id),
        empty: 'No recipients are currently suppressed.',
        columns: [
          {
            key: 'address',
            label: 'Recipient',
            sortValue: (row) => row.address,
            render: (row) => row.address,
          },
          {
            key: 'reason',
            label: 'Why',
            render: (row) => (row.reason === 'complaint' ? 'Complaint' : 'Permanent bounce'),
          },
          {
            key: 'last_seen_at',
            label: 'Latest feedback (UTC)',
            render: (row) => row.last_seen_at,
          },
          {
            key: 'event_count',
            label: 'Events since last lift',
            numeric: true,
            render: (row) => String(row.event_count),
          },
        ],
        actions: (row) => [
          {
            label: 'Allow future email',
            primary: true,
            onSelect: () => {
              if (!context || pending) return
              selected = row
              form.reset()
              dialogResult.textContent = ''
              query<HTMLElement>('[data-email-suppression-recipient]').textContent =
                `${row.address} — ${row.reason === 'complaint' ? 'complaint' : 'permanent bounce'}`
              query<HTMLElement>('[data-email-suppression-confirm-row]').hidden =
                row.reason !== 'complaint'
              confirmation.required = row.reason === 'complaint'
              dialog.showModal()
              note.focus()
            },
          },
        ],
      }),
    )
    more.hidden = next === null
    status.textContent = `${rows.length} suppressed ${rows.length === 1 ? 'address' : 'addresses'} shown.`
  }
  const load = async (append = false): Promise<void> => {
    const active = context
    if (!active || pending || !api.listEmailSuppressions) return
    busy(true)
    status.textContent = 'Loading suppressed recipients…'
    if (!append) {
      rows = []
      next = null
      list.replaceChildren()
      more.hidden = true
    }
    try {
      const page = await api.listEmailSuppressions(
        append ? (next ?? undefined) : undefined,
        active.signal,
      )
      if (!current(active)) return
      rows = append ? [...rows, ...page.data] : page.data
      next = page.page.next_cursor
      render()
    } catch (error) {
      if (current(active))
        active.failed(error, () => {
          status.textContent = apiErrorMessage(
            error,
            'Suppressed recipients could not be loaded. Refresh to try again.',
          )
        })
    } finally {
      if (current(active)) busy(false)
    }
  }
  query<HTMLButtonElement>('[data-email-suppression-refresh]').addEventListener(
    'click',
    () => void load(),
  )
  more.addEventListener('click', () => {
    if (next) void load(true)
  })
  query<HTMLButtonElement>('[data-email-suppression-cancel]').addEventListener('click', () => {
    if (!pending) dialog.close()
  })
  dialog.addEventListener('cancel', (event) => {
    if (pending) event.preventDefault()
  })
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const active = context
    const reviewed = selected
    if (!active || !reviewed || pending || !api.liftEmailSuppression) return
    const reason = note.value.trim()
    const confirmed = confirmation.value.trim()
    if (!reason) {
      dialogResult.textContent = 'Explain why delivery may be allowed again.'
      return
    }
    if (
      reviewed.reason === 'complaint' &&
      confirmed.toLowerCase() !== reviewed.address.toLowerCase()
    ) {
      dialogResult.textContent = 'Type the email address to acknowledge its complaint.'
      return
    }
    busy(true)
    dialogResult.textContent = 'Recording your review…'
    void (async () => {
      let saved = false
      try {
        await api.liftEmailSuppression!(
          reviewed.id,
          { note: reason, ...(confirmed ? { confirmation: confirmed } : {}) },
          active.signal,
        )
        if (!current(active)) return
        saved = true
        dialog.close()
        form.reset()
        selected = null
      } catch (error) {
        if (current(active))
          active.failed(error, () => {
            dialogResult.textContent = apiErrorMessage(
              error,
              'The suppression could not be lifted. Cancel and refresh to review current feedback.',
            )
          })
      } finally {
        if (current(active)) busy(false)
      }
      if (saved && current(active)) {
        await load()
        if (current(active))
          result.textContent = `Your review for ${reviewed.address} was recorded. The feedback and your reason remain in the audit record.`
      }
    })()
  })
  return {
    clear,
    async activate(active: Context) {
      clear()
      context = active
      active.signal.addEventListener(
        'abort',
        () => {
          if (context === active) clear()
        },
        { once: true },
      )
      if (
        active.signal.aborted ||
        active.identity.profile !== 'administrator' ||
        !api.listEmailSuppressions ||
        !api.liftEmailSuppression
      )
        return
      root.hidden = false
      await load()
    },
  }
}
