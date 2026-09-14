/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest'
import {
  createDeliveriesController,
  failureText,
  type DeliveriesApi,
  type EmailLogRow,
  type OutboxRow,
} from '../src/deliveries/browser.js'
import { renderDeliveriesPage } from '../src/module-settings/render.js'

/**
 * Issue 485. Both endpoints shipped without a screen, so "did that invoice
 * reach the client" needed an API token and a terminal, and a failed delivery
 * could not be retried from the product at all.
 */

const email = (overrides: Partial<EmailLogRow> = {}): EmailLogRow => ({
  id: 1,
  to: [{ email: 'ap@kestrel.example.test' }],
  subject: 'Invoice 1315',
  template: 'invoice_sent',
  status: 'sent',
  attempt_count: 1,
  failure_code: null,
  failure_reason: null,
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
  ...overrides,
})

const mount = (): void => {
  document.body.innerHTML = renderDeliveriesPage('settings-deliveries')
}

const api = (overrides: Partial<DeliveriesApi> = {}): DeliveriesApi => ({
  listEmailLog: vi.fn(async () => ({ data: [email()] })),
  listOutboxDeliveries: vi.fn(async () => ({ data: [delivery()] })),
  retryOutboxDelivery: vi.fn(async () => undefined),
  ...overrides,
})

const text = (selector: string): string =>
  document.querySelector<HTMLElement>(selector)?.textContent ?? ''

const activate = async (deliveries: DeliveriesApi) => {
  const controller = createDeliveriesController(deliveries)
  await controller.activate(new AbortController().signal)
  return controller
}

describe('what was sent (#485)', () => {
  it('[browser] shows every addressee, not just the first', async () => {
    // A message that went to two people looking like it went to one is the
    // sort of thing somebody only notices after asking why a client says they
    // never received it.
    mount()
    await activate(
      api({
        listEmailLog: vi.fn(async () => ({
          data: [
            email({
              to: [
                { email: 'ap@kestrel.example.test' },
                { email: 'finance@kestrel.example.test' },
              ],
            }),
          ],
        })),
      }),
    )
    expect(text('[data-email-log-list]')).toContain('ap@kestrel.example.test')
    expect(text('[data-email-log-list]')).toContain('finance@kestrel.example.test')
  })

  it('[browser] puts the reason in the row, so failures are not all alike', async () => {
    mount()
    await activate(
      api({
        listEmailLog: vi.fn(async () => ({
          data: [
            email({
              status: 'failed',
              failure_code: 'provider_rejected',
              failure_reason: 'recipient address does not exist',
            }),
          ],
        })),
      }),
    )
    const table = text('[data-email-log-list]')
    expect(table).toContain('provider_rejected')
    expect(table).toContain('recipient address does not exist')
  })

  it('[browser] falls back to the template where a message carries no subject', async () => {
    mount()
    await activate(
      api({ listEmailLog: vi.fn(async () => ({ data: [email({ subject: '' })] })) }),
    )
    expect(text('[data-email-log-list]')).toContain('Invoice sent')
  })

  it('[browser] says it could not read rather than drawing an empty table', async () => {
    // This screen is what somebody opens when something has gone wrong. An
    // empty table would read as "nothing was ever sent", which is the opposite
    // of what a failed read means.
    mount()
    await activate(
      api({
        listEmailLog: vi.fn(async () => {
          throw new Error('Email log is unavailable.')
        }),
      }),
    )
    expect(text('[data-email-log-status]')).toBe('Email log is unavailable.')
    expect(text('[data-email-log-list]')).toBe('')
  })

  it('[browser] omits an untouched filter rather than sending it blank', async () => {
    mount()
    const deliveries = api()
    await activate(deliveries)
    // "" is not a status, and sending it turns an untouched control into a 422.
    expect(deliveries.listEmailLog).toHaveBeenCalledWith({}, expect.anything())
  })

  it('[browser] offers every status the API actually has', () => {
    mount()
    const options = [
      ...document.querySelectorAll('[data-email-log-status-filter] option'),
    ].map((option) => option.getAttribute('value'))
    // The first draft offered three of the five, so a bounced message was
    // unreachable through a control that looked complete.
    expect(options).toEqual(['', 'queued', 'sent', 'failed', 'bounced', 'complained'])
  })
})

describe('what became of it (#485)', () => {
  it('[browser] offers Retry only where there is something to retry', async () => {
    mount()
    await activate(
      api({
        listOutboxDeliveries: vi.fn(async () => ({
          data: [
            delivery({ event_id: 'e-1', status: 'delivered' }),
            delivery({ event_id: 'e-2', status: 'failed', last_error_code: 'subscriber_timeout' }),
          ],
        })),
      }),
    )
    // A Retry beside a delivered row invites doing the work twice for nothing.
    const buttons = [...document.querySelectorAll('[data-outbox-list] button')].filter(
      (button) => button.textContent === 'Retry',
    )
    expect(buttons).toHaveLength(1)
  })

  it('[money] retries the delivery it was asked to, and reloads after', async () => {
    mount()
    const deliveries = api({
      listOutboxDeliveries: vi.fn(async () => ({
        data: [delivery({ status: 'failed', last_error_code: 'subscriber_timeout' })],
      })),
    })
    await activate(deliveries)
    const retry = [...document.querySelectorAll('[data-outbox-list] button')].find(
      (button) => button.textContent === 'Retry',
    ) as HTMLButtonElement
    retry.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(deliveries.retryOutboxDelivery).toHaveBeenCalledWith(
      'quickbooks-mirror',
      'e-1',
      expect.anything(),
    )
    // Reloaded, or the row keeps showing the state it had before the retry.
    expect(deliveries.listOutboxDeliveries).toHaveBeenCalledTimes(2)
  })

  it('[browser] counts the failures separately, because that is the number that needs somebody', async () => {
    mount()
    await activate(
      api({
        listOutboxDeliveries: vi.fn(async () => ({
          data: [
            delivery({ event_id: 'e-1' }),
            delivery({ event_id: 'e-2', status: 'failed' }),
            delivery({ event_id: 'e-3', status: 'failed' }),
          ],
        })),
      }),
    )
    expect(text('[data-outbox-status]')).toBe('3 deliveries, 2 failed.')
  })

  it('[browser] says a retry failed rather than silently leaving the row', async () => {
    mount()
    const deliveries = api({
      listOutboxDeliveries: vi.fn(async () => ({ data: [delivery({ status: 'failed' })] })),
      retryOutboxDelivery: vi.fn(async () => {
        throw new Error('Subscriber is still unreachable.')
      }),
    })
    await activate(deliveries)
    const retry = [...document.querySelectorAll('[data-outbox-list] button')].find(
      (button) => button.textContent === 'Retry',
    ) as HTMLButtonElement
    retry.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(text('[data-outbox-status]')).toBe('Subscriber is still unreachable.')
  })
})

describe('the failure column (#485)', () => {
  it('[unit] reads as nothing, a code, a reason, or both', () => {
    expect(failureText(null, null)).toBe('')
    expect(failureText('provider_timeout', null)).toBe('provider_timeout')
    expect(failureText(null, 'mailbox full')).toBe('mailbox full')
    expect(failureText('provider_rejected', 'mailbox full')).toBe(
      'provider_rejected: mailbox full',
    )
  })
})
