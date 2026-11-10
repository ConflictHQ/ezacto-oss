import { describe, expect, it, vi } from 'vitest'
import type { EmailLogRecord } from '@ezacto/mailer'
import { MailgunMailer } from '@ezacto/mailer'
import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { migrateContainer } from '@ezacto/db'
import { migrateD1 } from '@ezacto/db/d1'
import { createContainerEmailLogStore, createD1EmailLogStore } from '../../../packages/db/src/email-log.js'
import { reconcileHeldMailgunReminders, runReminderReconciliation } from '../src/reminder-reconciliation.js'

const attemptId = 'b5f88b55-bc30-4bf2-94f5-350849e4b6c0'
const record = (id: number): EmailLogRecord => ({
  id, from: null, replyTo: [], to: [{ email: 'to@example.test' }], cc: [{ email: 'cc@example.test' }],
  template: 'reminder:payment', subject: 'Reminder', provider: 'mailgun', providerMessageId: null,
  providerRequestId: null, providerLatencyMs: null, status: 'queued', relatedType: null, relatedId: null,
  attemptCount: 1, failureCode: null, failureReason: null,
  createdAt: '2026-08-28T20:00:00.000Z', updatedAt: '2026-08-28T20:00:00.000Z',
})

describe('held Mailgun reminder reconciliation', () => {
  it.each([
    ['SQLite', 'accepted', 'sent'], ['D1', 'accepted', 'sent'],
    ['SQLite', 'failed', 'bounced'], ['D1', 'complained', 'complained'],
  ] as const)('records %s provider event %s as %s without sending mail', async (backend, event, expected) => {
    const db = backend === 'SQLite' ? new BetterSqlite3(':memory:') : null
    const miniflare = backend === 'D1' ? new Miniflare({ modules: true,
      script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'] }) : null
    try {
      const d1 = miniflare === null ? null : await miniflare.getD1Database('DB')
      if (db !== null) migrateContainer(db)
      if (d1 !== null) await migrateD1(d1)
      let now = '2026-08-28T20:00:00.000Z'
      const log = db !== null ? createContainerEmailLogStore(db, { now: () => now }) : createD1EmailLogStore(d1!, { now: () => now })
      const queued = await log.createQueued({ from: { email: 'sender@example.test' },
        to: [{ email: 'to@example.test' }], cc: [{ email: 'cc@example.test' }],
        template: 'reminder:payment', subject: 'Reminder', text: 'Reminder' })
      await log.claimAttempt(queued.id, 'mailgun', attemptId, 60)
      now = '2026-08-28T20:02:00.000Z'
      const fetch = vi.fn().mockImplementation(async (request: Request) => {
        expect(request.method).toBe('GET')
        return new Response(JSON.stringify({ items: [{ id: 'event-terminal', event, severity: 'permanent', timestamp: Date.parse('2026-08-28T20:00:01.000Z') / 1000,
          recipient: 'cc@example.test', tags: [`ezacto-reminder-${attemptId.slice(0, 2)}`],
          'user-variables': { ezacto_idempotency_key: `ezacto-reminder-${queued.id}-${attemptId}` },
          message: { headers: { 'message-id': '<mailgun-id>' } } }] }))
      })
      const lookup = new MailgunMailer({ apiKey: 'test-key', domain: 'mail.example.test' }, { fetch })
      await runReminderReconciliation({ store: log, lookup, token: '7acbff11-1395-4011-a881-c299dad9e890' })
      expect(await log.get(queued.id)).toMatchObject({ status: expected, providerMessageId: 'mailgun-id' })
      if (event !== 'accepted') {
        const rows = db !== null ? db.prepare('SELECT address, reason FROM email_suppression_events').all() :
          (await d1!.prepare('SELECT address, reason FROM email_suppression_events').all()).results
        expect(rows).toEqual([{ address: 'cc@example.test', reason: event === 'failed' ? 'bounce' : 'complaint' }])
      }
      expect(await log.heldReminderAttempts(0, 10)).toEqual([])
      expect(fetch).toHaveBeenCalledOnce()
      expect(await log.claimReminderSweep(attemptId)).toBeNull()
    } finally { db?.close(); await miniflare?.dispose() }
  })

  it('marks only positive observations using the exact held attempt', async () => {
    const list = vi.fn().mockResolvedValue([1, 2, 3].map(id => ({ record: record(id), attemptId,
      claimedAt: '2026-08-28T20:00:00.000Z' })))
    const findReminderReceipt = vi.fn().mockResolvedValueOnce({ messageId: 'accepted' })
      .mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('provider unavailable'))
    const markSent = vi.fn().mockResolvedValue(record(1))
    const get = vi.fn()
    const recordReminderFeedback = vi.fn()
    expect(await reconcileHeldMailgunReminders({ afterId: 0, list, lookup: { findReminderReceipt }, log: { markSent, get, recordReminderFeedback } }))
      .toEqual({ nextId: null, examined: 3, reconciled: 1, deferred: 2 })
    expect(markSent).toHaveBeenCalledExactlyOnceWith(1, 'mailgun', { messageId: 'accepted' }, attemptId)
    expect(findReminderReceipt.mock.calls[0]![0]).toMatchObject({ deliveryId: 1, attemptId,
      recipients: ['to@example.test', 'cc@example.test'] })
  })

  it('leaves legacy claims held and tolerates another actor winning the receipt CAS', async () => {
    const list = vi.fn().mockResolvedValue([{ record: record(1), attemptId: 'old-id', claimedAt: record(1).updatedAt },
      { record: record(2), attemptId, claimedAt: record(2).updatedAt }])
    const findReminderReceipt = vi.fn().mockResolvedValue({ messageId: 'accepted' })
    const markSent = vi.fn().mockRejectedValue(new Error('claim lost'))
    const get = vi.fn().mockResolvedValue({ ...record(2), status: 'sent' })
    const recordReminderFeedback = vi.fn()
    expect(await reconcileHeldMailgunReminders({ afterId: 0, list, lookup: { findReminderReceipt }, log: { markSent, get, recordReminderFeedback } }))
      .toEqual({ nextId: null, examined: 2, reconciled: 0, deferred: 2 })
    expect(findReminderReceipt).toHaveBeenCalledOnce()
    get.mockResolvedValue(record(2))
    await expect(reconcileHeldMailgunReminders({ afterId: 0, list, lookup: { findReminderReceipt }, log: { markSent, get, recordReminderFeedback } }))
      .rejects.toThrow('claim lost')
  })

  it('advances a full page and does not advance after a database error', async () => {
    const heldReminderAttempts = vi.fn().mockResolvedValue(Array.from({ length: 10 }, (_, index) => ({
      record: record(index + 1), attemptId, claimedAt: record(1).updatedAt,
    })))
    const claimReminderSweep = vi.fn().mockResolvedValue(0)
    const finishReminderSweep = vi.fn().mockResolvedValue(true)
    const markSent = vi.fn().mockResolvedValue(record(1))
    const get = vi.fn()
    const recordReminderFeedback = vi.fn()
    const store = { heldReminderAttempts, claimReminderSweep, finishReminderSweep, markSent, get, recordReminderFeedback }
    const lookup = { findReminderReceipt: vi.fn().mockResolvedValue(null) }
    const token = '7acbff11-1395-4011-a881-c299dad9e890'
    await runReminderReconciliation({ store, lookup, token })
    expect(finishReminderSweep).toHaveBeenCalledExactlyOnceWith(token, 10, true)
    finishReminderSweep.mockClear()
    heldReminderAttempts.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(runReminderReconciliation({ store, lookup, token })).rejects.toThrow('database unavailable')
    expect(finishReminderSweep).not.toHaveBeenCalled()
  })
})
