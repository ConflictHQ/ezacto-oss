/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest'
import {
  createDeliveriesController,
  emailQuery,
  type DeliveriesApi,
  type EmailLogRow,
  type OutboxRow,
} from '../src/deliveries/browser.js'
import type { LogPageResult } from '../src/components/paged-log.js'
import { renderDeliveriesPage } from '../src/module-settings/render.js'

/**
 * Issue 929. The email log and the event deliveries loaded the newest 200 rows
 * and stopped, so an operator looking for last month's failure was told
 * nothing when it fell off the end. They page by the server's cursor, and each
 * table's place lives in the address.
 */

const email = (overrides: Partial<EmailLogRow> = {}): EmailLogRow => ({
  id: 1,
  to: [{ email: 'ap@kestrel.example.test' }],
  cc: [],
  subject: 'Invoice 1315',
  template: 'invoice:1',
  status: 'sent',
  attempt_count: 1,
  failure_code: null,
  failure_reason: null,
  viewed_at: null,
  created_at: '2026-09-13T09:00:00.000Z',
  ...overrides,
})

const delivery = (overrides: Partial<OutboxRow> = {}): OutboxRow => ({
  subscriber_id: 'quickbooks-mirror',
  event_id: 'e-1',
  event_type: 'invoice.paid',
  status: 'delivered',
  attempt_count: 1,
  last_error_code: null,
  occurred_at: '2026-09-13T09:00:00.000Z',
  created_at: '2026-09-13T09:00:00.000Z',
  ...overrides,
})

/** A page as the API answers one: the rows, and where the next page is. */
const pageOf = <Row>(
  rows: readonly Row[],
  options: { next?: string; total?: number } = {},
): LogPageResult<Row> => ({
  data: rows,
  links: {
    next: options.next === undefined ? null : `/api/v1/log?per_page=50&cursor=${options.next}`,
  },
  page: {
    per_page: 50,
    next_cursor: options.next ?? null,
    total: options.total ?? rows.length,
  },
})

/** happy-dom's window carries its own controls, which the DOM typings do not know. */
const setAddress = (search: string): void => {
  ;(window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(
    `http://localhost/settings/deliveries${search}`,
  )
}

const mount = (search = ''): void => {
  // The tables keep their place in the address, so every test starts from a known one.
  setAddress(search)
  document.body.innerHTML = renderDeliveriesPage('settings-deliveries')
}

const api = (overrides: Partial<DeliveriesApi> = {}): DeliveriesApi => ({
  listEmailLog: vi.fn(async () => pageOf([email()])),
  listOutboxDeliveries: vi.fn(async () => pageOf([delivery()])),
  retryOutboxDelivery: vi.fn(async () => undefined),
  ...overrides,
})

const text = (selector: string): string =>
  document.querySelector<HTMLElement>(selector)?.textContent ?? ''

const activate = async (deliveries: DeliveriesApi): Promise<void> => {
  await createDeliveriesController(deliveries).activate(new AbortController().signal)
}

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const buttonNamed = (scope: string, name: string): HTMLButtonElement =>
  [...document.querySelectorAll<HTMLButtonElement>(`${scope} button`)].find(
    (button) => button.textContent === name,
  )!

const emailRows = (from: number, count: number): EmailLogRow[] =>
  Array.from({ length: count }, (_, index) =>
    email({ id: from + index, subject: `Mail ${String(from + index)}` }),
  )

const change = (selector: string, value: string): void => {
  const control = document.querySelector<HTMLInputElement>(selector)!
  control.value = value
  control.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('a log read a page at a time (#929)', () => {
  it('[browser] follows the server cursor to older rows and says where it is', async () => {
    mount()
    const listEmailLog = vi
      .fn()
      .mockResolvedValueOnce(pageOf(emailRows(1, 50), { next: 'c1', total: 120 }))
      .mockResolvedValueOnce(pageOf(emailRows(51, 50), { next: 'c2', total: 120 }))
      .mockResolvedValueOnce(pageOf(emailRows(101, 20), { total: 120 }))
    await activate(api({ listEmailLog }))
    expect(text('[data-email-log-list] .log-pager-count')).toBe('Rows 1–50 of 120')
    expect(buttonNamed('[data-email-log-list]', 'Newer').disabled).toBe(true)

    buttonNamed('[data-email-log-list]', 'Older').click()
    await flush()
    expect(listEmailLog).toHaveBeenLastCalledWith(
      { per_page: 50, order: 'newest', cursor: 'c1' },
      expect.anything(),
    )
    expect(text('[data-email-log-list] .log-pager-count')).toBe('Rows 51–100 of 120')
    expect(window.location.search).toBe('?email_cursor=c1&email_offset=50')

    buttonNamed('[data-email-log-list]', 'Older').click()
    await flush()
    expect(text('[data-email-log-list] .log-pager-count')).toBe('Rows 101–120 of 120')
    // The last page has nowhere older to go.
    expect(buttonNamed('[data-email-log-list]', 'Older').disabled).toBe(true)
  })

  it('[browser] steps back through the pages it has been to', async () => {
    mount()
    const listEmailLog = vi
      .fn()
      .mockResolvedValueOnce(pageOf(emailRows(1, 50), { next: 'c1', total: 120 }))
      .mockResolvedValueOnce(pageOf(emailRows(51, 50), { next: 'c2', total: 120 }))
      .mockResolvedValueOnce(pageOf(emailRows(1, 50), { next: 'c1', total: 120 }))
    await activate(api({ listEmailLog }))
    buttonNamed('[data-email-log-list]', 'Older').click()
    await flush()
    buttonNamed('[data-email-log-list]', 'Newer').click()
    await flush()
    expect(listEmailLog).toHaveBeenNthCalledWith(
      3,
      { per_page: 50, order: 'newest' },
      expect.anything(),
    )
    expect(window.location.search).toBe('')
    expect(text('[data-email-log-list] .log-pager-count')).toBe('Rows 1–50 of 120')
  })

  it('[browser] reopens a deep link on the page it names, and Newer goes to the newest', async () => {
    mount('?email_status=failed&email_cursor=deep&email_offset=100&email_per_page=25')
    const listEmailLog = vi.fn(async () => pageOf(emailRows(101, 25), { next: 'c9', total: 312 }))
    await activate(api({ listEmailLog }))
    expect(listEmailLog).toHaveBeenCalledWith(
      { per_page: 25, order: 'newest', cursor: 'deep', status: 'failed' },
      expect.anything(),
    )
    expect(text('[data-email-log-list] .log-pager-count')).toBe('Rows 101–125 of 312')
    expect(document.querySelector<HTMLSelectElement>('[data-email-log-status-filter]')!.value).toBe(
      'failed',
    )
    expect(
      document.querySelector<HTMLSelectElement>('[data-email-log-list] [data-log-per-page]')!.value,
    ).toBe('25')

    // Nothing in this visit is newer, so Newer goes to the newest page rather
    // than to a cursor nobody has.
    buttonNamed('[data-email-log-list]', 'Newer').click()
    await flush()
    expect(listEmailLog).toHaveBeenLastCalledWith(
      { per_page: 25, order: 'newest', status: 'failed' },
      expect.anything(),
    )
    expect(window.location.search).toBe('?email_status=failed&email_per_page=25')
  })

  it('[browser] reads the page again when the browser walks back', async () => {
    mount()
    const listEmailLog = vi
      .fn()
      .mockResolvedValueOnce(pageOf(emailRows(1, 50), { next: 'c1', total: 120 }))
      .mockResolvedValueOnce(pageOf(emailRows(51, 50), { total: 120 }))
      .mockResolvedValueOnce(pageOf(emailRows(1, 50), { next: 'c1', total: 120 }))
    await activate(api({ listEmailLog }))
    buttonNamed('[data-email-log-list]', 'Older').click()
    await flush()
    window.history.replaceState(null, '', '/settings/deliveries')
    window.dispatchEvent(new PopStateEvent('popstate'))
    await flush()
    expect(listEmailLog).toHaveBeenCalledTimes(3)
    expect(text('[data-email-log-list] .log-pager-count')).toBe('Rows 1–50 of 120')
  })

  it('[browser] starts again from the newest page when the page size or a filter changes', async () => {
    mount('?email_cursor=deep&email_offset=100')
    const listEmailLog = vi.fn(async () => pageOf(emailRows(1, 25), { next: 'c1', total: 120 }))
    await activate(api({ listEmailLog }))

    change('[data-email-log-list] [data-log-per-page]', '100')
    await flush()
    // A cursor encodes its page size, so it cannot be carried to another.
    expect(listEmailLog).toHaveBeenLastCalledWith(
      { per_page: 100, order: 'newest' },
      expect.anything(),
    )
    expect(window.location.search).toBe('?email_per_page=100')

    change('#ez-email-log-kind-filter', 'reminder')
    await flush()
    expect(listEmailLog).toHaveBeenLastCalledWith(
      { per_page: 100, order: 'newest', kind: 'reminder' },
      expect.anything(),
    )
    expect(window.location.search).toBe('?email_kind=reminder&email_per_page=100')
  })

  it('[browser] combines the filters in one request, and leaves the other table alone', async () => {
    mount('?outbox_status=failed')
    const deliveries = api()
    await activate(deliveries)
    change('#ez-email-log-status-filter', 'failed')
    change('#ez-email-log-from', '2026-09-01')
    change('#ez-email-log-to', '2026-09-08')
    change('#ez-email-log-q', ' kestrel ')
    await flush()
    expect(deliveries.listEmailLog).toHaveBeenLastCalledWith(
      {
        per_page: 50,
        order: 'newest',
        status: 'failed',
        from: '2026-09-01',
        to: '2026-09-08',
        q: 'kestrel',
      },
      expect.anything(),
    )
    const params = new URLSearchParams(window.location.search)
    expect(params.get('email_q')).toBe('kestrel')
    // The deliveries table's own place is still in the address.
    expect(params.get('outbox_status')).toBe('failed')
    expect(deliveries.listOutboxDeliveries).toHaveBeenCalledWith(
      { per_page: 50, order: 'newest', status: 'failed' },
      expect.anything(),
    )
  })

  it('[unit] sends nothing a hand-edited address cannot mean', () => {
    const query = emailQuery({
      filters: {
        kind: 'newsletter',
        status: 'delivered',
        from: 'last week',
        to: '2026-09-08',
      },
      perPage: 50,
      order: 'newest',
      cursor: null,
      offset: 0,
    })
    expect(query).toEqual({ per_page: 50, order: 'newest', to: '2026-09-08' })
  })

  it('[browser] falls back to the default page size for one the control does not offer', async () => {
    mount('?email_per_page=7&email_order=sideways')
    const deliveries = api()
    await activate(deliveries)
    expect(deliveries.listEmailLog).toHaveBeenCalledWith(
      { per_page: 50, order: 'newest' },
      expect.anything(),
    )
  })

  it('[browser] says whether the filters matched nothing or nothing was ever sent', async () => {
    mount()
    await activate(api({ listEmailLog: vi.fn(async () => pageOf([])) }))
    expect(text('[data-email-log-list]')).toBe('No email has been sent yet.')

    mount('?email_status=bounced')
    await activate(api({ listEmailLog: vi.fn(async () => pageOf([])) }))
    expect(text('[data-email-log-list]')).toBe('No email matches these filters.')
    // The other table is not touched by this one being empty.
    expect(text('[data-outbox-list]')).toContain('Invoice paid')
  })

  it('[browser] clears every filter of one table at once', async () => {
    mount('?email_status=failed&email_q=acme&outbox_status=failed')
    const deliveries = api()
    await activate(deliveries)
    document.querySelector<HTMLButtonElement>('[data-email-log-controls] [data-log-clear]')!.click()
    await flush()
    expect(deliveries.listEmailLog).toHaveBeenLastCalledWith(
      { per_page: 50, order: 'newest' },
      expect.anything(),
    )
    expect(window.location.search).toBe('?outbox_status=failed')
    expect(document.querySelector<HTMLInputElement>('#ez-email-log-q')!.value).toBe('')
  })

  it('[browser] sorts by When on the server, and keeps the keyboard on the header', async () => {
    mount()
    const listEmailLog = vi.fn(async () => pageOf(emailRows(1, 3), { next: 'c1', total: 9 }))
    await activate(api({ listEmailLog }))
    const header = (): Element =>
      document.querySelector('[data-email-log-list] th[data-column="when"]')!
    expect(header().getAttribute('aria-sort')).toBe('descending')
    // Only the order the server holds is sortable: a page of a longer log
    // sorted in the browser would claim an order the rest of the log lacks.
    expect(document.querySelectorAll('[data-email-log-list] button[data-sort-column]')).toHaveLength(1)

    document
      .querySelector<HTMLButtonElement>('[data-email-log-list] button[data-sort-column="when"]')!
      .click()
    await flush()
    expect(listEmailLog).toHaveBeenLastCalledWith(
      { per_page: 50, order: 'oldest' },
      expect.anything(),
    )
    expect(window.location.search).toBe('?email_order=oldest')
    expect(header().getAttribute('aria-sort')).toBe('ascending')
    expect(document.activeElement?.getAttribute('data-sort-column')).toBe('when')
    // Read oldest first, the next page is the newer one.
    expect(buttonNamed('[data-email-log-list]', 'Newer').disabled).toBe(false)
    expect(buttonNamed('[data-email-log-list]', 'Older').disabled).toBe(true)
  })

  it('[browser] says times in the organization timezone and names it in the column', async () => {
    mount()
    await activate(
      api({
        organizationTimezone: vi.fn(async () => 'America/Costa_Rica'),
        listEmailLog: vi.fn(async () => pageOf([email({ created_at: '2026-09-13T03:00:00.000Z' })])),
      }),
    )
    expect(text('[data-email-log-list] th[data-column="when"]')).toBe('When (America/Costa_Rica)')
    expect(text('[data-email-log-list] td[data-column="when"]')).toBe('2026-09-12 21:00')
  })

  it('[browser] falls back to UTC, labelled, when the timezone cannot be read', async () => {
    mount()
    await activate(
      api({
        organizationTimezone: vi.fn(async () => {
          throw new Error('forbidden')
        }),
      }),
    )
    expect(text('[data-email-log-list] th[data-column="when"]')).toBe('When (UTC)')
  })

  it('[browser] offers the way back to the newest rows when a link has a cursor no longer good', async () => {
    mount('?email_cursor=stale')
    const listEmailLog = vi
      .fn()
      .mockRejectedValueOnce(new Error('cursor is malformed or unsupported'))
      .mockResolvedValueOnce(pageOf(emailRows(1, 2)))
    await activate(api({ listEmailLog }))
    expect(text('[data-email-log-status]')).toBe('cursor is malformed or unsupported')
    buttonNamed('[data-email-log-list]', 'Back to the newest rows').click()
    await flush()
    expect(listEmailLog).toHaveBeenLastCalledWith(
      { per_page: 50, order: 'newest' },
      expect.anything(),
    )
    expect(text('[data-email-log-list]')).toContain('Mail 1')
  })

  it('[browser] pages the deliveries on their own cursor', async () => {
    mount()
    const listOutboxDeliveries = vi
      .fn()
      .mockResolvedValueOnce(pageOf([delivery()], { next: 'o1', total: 80 }))
      .mockResolvedValueOnce(pageOf([delivery({ event_id: 'e-2' })], { total: 80 }))
    const deliveries = api({ listOutboxDeliveries })
    await activate(deliveries)
    buttonNamed('[data-outbox-list]', 'Older').click()
    await flush()
    expect(listOutboxDeliveries).toHaveBeenLastCalledWith(
      { per_page: 50, order: 'newest', cursor: 'o1' },
      expect.anything(),
    )
    expect(window.location.search).toBe('?outbox_cursor=o1&outbox_offset=1')
    // The email table did not move.
    expect(deliveries.listEmailLog).toHaveBeenCalledTimes(1)
  })
})
