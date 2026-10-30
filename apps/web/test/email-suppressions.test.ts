/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EzactoApiError,
  type EmailSuppression,
  type EmailSuppressionsPage,
  type Whoami,
} from '@conflict-hq/ezacto-client'
import { emailReputationWarning, type CompanySettingsApi } from '../src/module-settings/model.js'
import { createEmailSuppressionController } from '../src/module-settings/email-suppressions-browser.js'
import { renderEmailSuppressionReview } from '../src/module-settings/email-suppressions-render.js'
const now = '2026-10-21T12:00:00.000Z'
const record: EmailSuppression = {
  id: 2,
  address: 'recipient@example.test',
  reason: 'complaint',
  first_seen_at: now,
  last_seen_at: now,
  event_count: 2,
}
const page = (data: EmailSuppression[], next: string | null = null): EmailSuppressionsPage => ({
  data,
  links: {
    self: '/api/v1/email-suppressions',
    next: next ? '/api/v1/email-suppressions?cursor=next' : null,
  },
  page: { per_page: 50, next_cursor: next },
})
const who = (profile: Whoami['profile'] = 'administrator'): Whoami =>
  ({ user_id: 7, profile, manager_grants: [], authentication: { kind: 'session' } }) as Whoami
const context = (profile: Whoami['profile'] = 'administrator', abort = new AbortController()) => ({
  identity: who(profile),
  signal: abort.signal,
  failed: vi.fn((_error: unknown, paint: () => void) => paint()),
})
const query = <T extends Element>(selector: string): T => document.querySelector<T>(selector)!
const fixture = () => ({
  listEmailSuppressions: vi.fn<NonNullable<CompanySettingsApi['listEmailSuppressions']>>(async () =>
    page([record]),
  ),
  liftEmailSuppression: vi.fn<NonNullable<CompanySettingsApi['liftEmailSuppression']>>(
    async (_id, input) => ({
      id: 1,
      address: record.address,
      through_event_id: record.id,
      actor_user_id: 7,
      note: input.note,
      complaint_acknowledged: true,
      lifted_at: now,
    }),
  ),
})
const open = () =>
  [...document.querySelectorAll<HTMLButtonElement>('[data-email-suppression-list] button')]
    .find((button) => button.textContent?.trim() === 'Allow future email')!
    .click()
const submit = () =>
  query<HTMLFormElement>('[data-email-suppression-form]').dispatchEvent(
    new Event('submit', { bubbles: true, cancelable: true }),
  )
beforeEach(() => {
  document.body.innerHTML = renderEmailSuppressionReview()
})
describe('email suppression review #42', () => {
  it('requires administrator capability before any read and clears data on a session switch', async () => {
    const api = fixture()
    const controller = createEmailSuppressionController(api)
    await controller.activate(context('member'))
    expect(api.listEmailSuppressions).not.toHaveBeenCalled()
    expect(query<HTMLElement>('[data-email-suppression-review]').hidden).toBe(true)
    await controller.activate(context())
    expect(query('[data-email-suppression-list]').textContent).toContain(record.address)
    open()
    expect(query<HTMLDialogElement>('dialog').open).toBe(true)
    await controller.activate(context('accounting'))
    expect(query<HTMLElement>('[data-email-suppression-review]').hidden).toBe(true)
    expect(query('[data-email-suppression-list]').textContent).toBe('')
    expect(query<HTMLDialogElement>('dialog').open).toBe(false)
  })
  it('requires a reason and typed complaint acknowledgement, then records one lift and refreshes', async () => {
    const api = fixture()
    api.listEmailSuppressions.mockResolvedValueOnce(page([record])).mockResolvedValueOnce(page([]))
    await createEmailSuppressionController(api).activate(context())
    open()
    submit()
    expect(api.liftEmailSuppression).not.toHaveBeenCalled()
    query<HTMLTextAreaElement>('[name="note"]').value = 'Recipient requested future invoices'
    submit()
    expect(api.liftEmailSuppression).not.toHaveBeenCalled()
    expect(query('[data-email-suppression-dialog-result]').textContent).toContain(
      'Type the email address',
    )
    query<HTMLInputElement>('[name="confirmation"]').value = 'RECIPIENT@example.test'
    submit()
    submit()
    await vi.waitFor(() => expect(api.liftEmailSuppression).toHaveBeenCalledTimes(1))
    expect(api.liftEmailSuppression).toHaveBeenCalledWith(
      2,
      { note: 'Recipient requested future invoices', confirmation: 'RECIPIENT@example.test' },
      expect.any(AbortSignal),
    )
    await vi.waitFor(() =>
      expect(query('[data-email-suppression-result]').textContent).toContain(
        'review for recipient@example.test was recorded',
      ),
    )
    expect(query('[data-email-suppression-list]').textContent).toContain(
      'No recipients are currently suppressed',
    )
    expect(query<HTMLDialogElement>('dialog').open).toBe(false)
    expect(query<HTMLTextAreaElement>('[name="note"]').value).toBe('')
  })
  it('keeps actionable stale-evidence errors and the review text instead of claiming success', async () => {
    const api = fixture()
    api.liftEmailSuppression.mockRejectedValue(
      new EzactoApiError(
        409,
        { error: { message: 'New feedback arrived. Refresh the list.' } },
        'fixture',
      ),
    )
    await createEmailSuppressionController(api).activate(context())
    open()
    query<HTMLTextAreaElement>('[name="note"]').value = 'Reviewed'
    query<HTMLInputElement>('[name="confirmation"]').value = record.address
    submit()
    await vi.waitFor(() =>
      expect(query('[data-email-suppression-dialog-result]').textContent).toContain(
        'New feedback arrived',
      ),
    )
    expect(query<HTMLDialogElement>('dialog').open).toBe(true)
    expect(query<HTMLTextAreaElement>('[name="note"]').value).toBe('Reviewed')
    expect(query('[data-email-suppression-result]').textContent).toBe('')
  })
  it('paginates the actual server cursor and keeps all loaded recipient rows', async () => {
    const api = fixture()
    api.listEmailSuppressions
      .mockResolvedValueOnce(page([record], 'next'))
      .mockResolvedValueOnce(
        page([{ ...record, id: 3, address: 'second@example.test', reason: 'bounce' }]),
      )
    await createEmailSuppressionController(api).activate(context())
    query<HTMLButtonElement>('[data-email-suppression-more]').click()
    await vi.waitFor(() =>
      expect(query('[data-email-suppression-list]').textContent).toContain('second@example.test'),
    )
    expect(api.listEmailSuppressions).toHaveBeenLastCalledWith('next', expect.any(AbortSignal))
    expect(
      document.querySelectorAll('[data-email-suppression-list] tbody tr[data-row]'),
    ).toHaveLength(2)
    expect(query<HTMLButtonElement>('[data-email-suppression-more]').hidden).toBe(true)
  })
  it('discards late reads and failed lifts from a prior session without calling its failure handler', async () => {
    const api = fixture()
    const read = Promise.withResolvers<EmailSuppressionsPage>()
    api.listEmailSuppressions.mockReturnValueOnce(read.promise)
    const controller = createEmailSuppressionController(api)
    const first = controller.activate(context())
    await controller.activate(context('member'))
    read.resolve(page([record]))
    await first
    expect(query('[data-email-suppression-list]').textContent).toBe('')
    const old = context()
    await controller.activate(old)
    const write =
      Promise.withResolvers<
        Awaited<ReturnType<NonNullable<CompanySettingsApi['liftEmailSuppression']>>>
      >()
    api.liftEmailSuppression.mockReturnValueOnce(write.promise)
    open()
    query<HTMLTextAreaElement>('[name="note"]').value = 'Reviewed'
    query<HTMLInputElement>('[name="confirmation"]').value = record.address
    submit()
    await controller.activate(context('member'))
    write.reject(new EzactoApiError(401, {}, 'old'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(old.failed).not.toHaveBeenCalled()
    expect(query('[data-email-suppression-result]').textContent).toBe('')
    expect(query<HTMLDialogElement>('dialog').open).toBe(false)
  })
})

it('[unit #42] warns at the local review thresholds and watches from half those values', () => {
  const signal = (bounce_rate_ppm: number, complaint_rate_ppm: number) =>
    emailReputationWarning({ bounce_rate_ppm, complaint_rate_ppm })
  expect(signal(9999, 499)).toBe('')
  expect(signal(10000, 0)).toContain('Watch')
  expect(signal(0, 500)).toContain('Watch')
  expect(signal(20000, 0)).toContain('Review')
  expect(signal(0, 1000)).toContain('Review')
})
