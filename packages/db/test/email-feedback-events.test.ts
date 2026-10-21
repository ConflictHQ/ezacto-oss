import {
  createContainerEmailSuppressionStore,
  createD1EmailSuppressionStore,
} from '../src/email-suppressions.js'
import { createHmac } from 'node:crypto'
import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createMailgunFeedbackService,
  processQueuedEmail,
  type EmailSuppressionStore,
  type EmailFeedbackLedger,
  type EmailLogStore,
  type EmailMessage,
  type MailgunFeedbackService,
} from '@ezacto/mailer'
import {
  createContainerEmailFeedbackLedger,
  createD1EmailFeedbackLedger,
} from '../src/email-feedback-events.js'
import { createContainerEmailLogStore, createD1EmailLogStore } from '../src/email-log.js'
import { migrateContainer, migrateContainerThrough, migrateD1 } from '../src/migrate.js'

// A made-up key for this file only. Nothing here is, or resembles, a real one.
const fixtureKey = 'fixture-mailgun-webhook-key-for-tests'
const instant = '2026-10-19T12:00:00.000Z'
const seconds = Date.parse(instant) / 1000

interface Harness {
  log: EmailLogStore
  suppressions: EmailSuppressionStore
  ledger: EmailFeedbackLedger
  rows<T>(query: string, ...bindings: unknown[]): Promise<T[]>
  close(): Promise<void>
}

const containerHarness = async (): Promise<Harness> => {
  const database = new BetterSqlite3(':memory:')
  migrateContainer(database)
  return {
    log: createContainerEmailLogStore(database, { now: () => instant }),
    suppressions: createContainerEmailSuppressionStore(database),
    ledger: createContainerEmailFeedbackLedger(database),
    rows: async <T>(query: string, ...bindings: unknown[]) =>
      database.prepare(query).all(...bindings) as T[],
    close: async () => {
      database.close()
    },
  }
}

const d1Harness = async (): Promise<Harness> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const database = await miniflare.getD1Database('DB')
  await migrateD1(database)
  return {
    log: createD1EmailLogStore(database, { now: () => instant }),
    suppressions: createD1EmailSuppressionStore(database),
    ledger: createD1EmailFeedbackLedger(database),
    rows: async <T>(query: string, ...bindings: unknown[]) =>
      (
        await database
          .prepare(query)
          .bind(...bindings)
          .all<T>()
      ).results,
    close: async () => miniflare.dispose(),
  }
}

const message = (from: string, to = 'owner@example.test'): EmailMessage => ({
  from: { email: from, name: 'Billing' },
  to: [{ email: to }],
  cc: [{ email: 'copy@example.test' }],
  template: 'invoice_sent',
  subject: 'Invoice',
  text: 'Body',
  related: { type: 'invoice', id: 1 },
})

const sign = (timestamp: string, token: string, key = fixtureKey): string =>
  createHmac('sha256', key)
    .update(timestamp + token)
    .digest('hex')

interface EventInput {
  id: string
  event?: string
  severity?: string
  recipient?: string
  messageId?: string
  token?: string
  timestamp?: string
  key?: string
  reason?: string
}

const post = (input: EventInput): string => {
  const token = input.token ?? `token-${input.id}`
  const timestamp = input.timestamp ?? String(seconds)
  return JSON.stringify({
    signature: { timestamp, token, signature: sign(timestamp, token, input.key) },
    'event-data': {
      id: input.id,
      event: input.event ?? 'failed',
      severity: input.severity ?? 'permanent',
      recipient: input.recipient ?? 'owner@example.test',
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      message: { headers: { 'message-id': input.messageId ?? 'mg-a' } },
    },
  })
}

for (const [runtime, factory] of [
  ['container', containerHarness],
  ['D1', d1Harness],
] as const) {
  describe(`mailgun feedback webhook (${runtime})`, () => {
    let harness: Harness | undefined
    afterEach(async () => harness?.close())

    const setup = async (): Promise<{ current: Harness; service: MailgunFeedbackService }> => {
      const current = (harness = await factory())
      return {
        current,
        service: createMailgunFeedbackService({
          signingKey: fixtureKey,
          log: current.log,
          ledger: current.ledger,
          now: () => new Date(instant),
        }),
      }
    }

    const sent = async (current: Harness, from: string, id: string) => {
      const queued = await current.log.createQueued(message(from))
      await current.log.claimAttempt(queued.id, 'mailgun', `attempt-${id}`, 60)
      return current.log.markSent(queued.id, 'mailgun', { messageId: id }, `attempt-${id}`)
    }

    it('[security #42] binds resumed feedback to its recorded message and recipient', async () => {
      const { current, service } = await setup()
      const first = await sent(current, 'a@example.test', 'mg-a')
      const second = await sent(current, 'b@example.test', 'mg-b')
      await current.ledger.claim({
        eventId: 'bound',
        signatureToken: 'token-bound',
        eventType: 'failed',
        severity: 'permanent',
        recipient: 'owner@example.test',
        providerMessageId: 'mg-a',
        deliveryId: first.id,
        now: instant,
      })
      expect(await service.receive(post({ id: 'bound', messageId: 'mg-b' }))).toEqual({
        kind: 'replayed',
      })
      expect((await current.log.get(second.id))?.status).toBe('sent')
      expect(await current.suppressions.snapshot()).toBe(0)
      expect(await service.receive(post({ id: 'bound' }))).toEqual({
        kind: 'applied',
        outcome: 'bounced',
      })
      expect(await current.suppressions.lookup(['OWNER@example.test'])).toBe('bounce')
    })

    it('[security #42] refuses future To/Cc delivery, audits explicit lifts, and reactivates only for new evidence', async () => {
      const { current, service } = await setup()
      await current.rows(
        `INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at) VALUES
        (1,'Admin','One','administrator','[]',?,?),(2,'Member','Two','member','[]',?,?) RETURNING id`,
        instant,
        instant,
        instant,
        instant,
      )
      await sent(current, 'a@example.test', 'mg-a')
      await sent(current, 'b@example.test', 'mg-b')
      await service.receive(post({ id: 'bounce' }))
      await service.receive(
        post({
          id: 'complaint',
          event: 'complained',
          recipient: 'copy@example.test',
          messageId: 'mg-b',
        }),
      )
      const rows = await current.suppressions.list({
        snapshot: await current.suppressions.snapshot(),
        take: 20,
      })
      expect(rows.map((row) => [row.address, row.reason, row.events])).toEqual([
        ['owner@example.test', 'bounce', 1],
        ['copy@example.test', 'complaint', 1],
      ])
      const send = vi.fn(async () => ({ messageId: 'smtp-allowed' }))
      const deliver = async (to: string) => {
        const mail = message('c@example.test', to)
        const queued = await current.log.createQueued(mail)
        const disposition = await processQueuedEmail(
          { schemaVersion: 1, deliveryId: queued.id, message: mail },
          1,
          current.log,
          { name: 'smtp', send },
          { getRecipientSuppression: current.suppressions.lookup },
        )
        expect(disposition).toEqual({ action: 'ack' })
        return current.log.get(queued.id)
      }
      expect(await deliver('owner@example.test')).toMatchObject({
        status: 'failed',
        failureReason: 'recipient_suppressed:COMPLAINT',
      })
      expect(await deliver('fresh@example.test')).toMatchObject({
        status: 'failed',
        failureReason: 'recipient_suppressed:COMPLAINT',
      })
      expect(send).not.toHaveBeenCalled()
      const bounce = rows[0]!,
        complaint = rows[1]!
      await expect(
        current.suppressions.lift(
          { eventId: bounce.id, actorId: 2, note: 'No authority', confirmation: '' },
          instant,
        ),
      ).rejects.toMatchObject({ code: 'profile_forbidden' })
      expect(
        await current.suppressions.lift(
          {
            eventId: bounce.id,
            actorId: 1,
            note: 'Recipient verified the address',
            confirmation: '',
          },
          instant,
        ),
      ).toMatchObject({ address: 'owner@example.test', actorId: 1, complaintAcknowledged: false })
      await expect(
        current.suppressions.lift(
          { eventId: complaint.id, actorId: 1, note: 'Reviewed complaint', confirmation: '' },
          instant,
        ),
      ).rejects.toMatchObject({ code: 'confirmation_required' })
      expect(
        await current.suppressions.lift(
          {
            eventId: complaint.id,
            actorId: 1,
            note: 'Recipient requested future mail',
            confirmation: 'COPY@example.test',
          },
          instant,
        ),
      ).toMatchObject({ address: 'copy@example.test', actorId: 1, complaintAcknowledged: true })
      expect(await deliver('owner@example.test')).toMatchObject({
        status: 'sent',
        providerMessageId: 'smtp-allowed',
      })
      expect(send).toHaveBeenCalledTimes(1)
      expect(
        await current.suppressions.list({
          snapshot: await current.suppressions.snapshot(),
          take: 20,
        }),
      ).toEqual([])
      await service.receive(post({ id: 'bounce' }))
      expect(await current.suppressions.lookup(['owner@example.test'])).toBeNull()
      await sent(current, 'a@example.test', 'mg-new')
      await service.receive(post({ id: 'new-bounce', messageId: 'mg-new' }))
      expect(await current.suppressions.lookup(['owner@example.test'])).toBe('bounce')
      await expect(
        current.suppressions.lift(
          { eventId: bounce.id, actorId: 1, note: 'Stale record', confirmation: '' },
          instant,
        ),
      ).rejects.toMatchObject({ code: 'state_conflict' })
      expect(
        await current.rows(
          'SELECT actor_user_id,note,complaint_acknowledged FROM email_suppression_lifts ORDER BY id',
        ),
      ).toEqual([
        { actor_user_id: 1, note: 'Recipient verified the address', complaint_acknowledged: 0 },
        { actor_user_id: 1, note: 'Recipient requested future mail', complaint_acknowledged: 1 },
      ])
      await expect(
        current.rows('DELETE FROM email_suppression_lifts RETURNING id'),
      ).rejects.toThrow(/append-only/)
      await expect(
        current.rows(`UPDATE email_suppression_events SET reason='complaint' RETURNING id`),
      ).rejects.toThrow(/immutable/)
    })

    it('[concurrency #42] a review cannot dismiss later evidence and concurrent reviews create one receipt', async () => {
      const { current, service } = await setup()
      await current.rows(`INSERT INTO users(id,first_name,last_name,profile,manager_grants,created_at,updated_at)
        VALUES(1,'Admin','One','administrator','[]',?,?) RETURNING id`, instant, instant)
      await sent(current, 'a@example.test', 'mg-a')
      await sent(current, 'a@example.test', 'mg-next')
      await service.receive(post({ id: 'before-review' }))
      const oldId = await current.suppressions.snapshot()
      const race = await Promise.allSettled([
        current.suppressions.lift({eventId: oldId,actorId:1,note:'Reviewed bounce',confirmation:''},instant),
        service.receive(post({id:'during-review',event:'complained',messageId:'mg-next'})),
      ])
      expect(race[1].status).toBe('fulfilled')
      expect(await current.suppressions.lookup(['owner@example.test'])).toBe('complaint')
      const newId = await current.suppressions.snapshot()
      expect(newId).toBeGreaterThan(oldId)
      expect(await current.rows<{through_event_id:number}>('SELECT through_event_id FROM email_suppression_lifts'))
        .toEqual(race[0].status === 'fulfilled' ? [{through_event_id:oldId}] : [])
      const reviews = await Promise.allSettled([1,2].map(() => current.suppressions.lift({
        eventId:newId,actorId:1,note:'Recipient requested mail',confirmation:'owner@example.test',
      },instant)))
      expect(reviews.filter(result => result.status==='fulfilled')).toHaveLength(1)
      expect(await current.rows('SELECT through_event_id FROM email_suppression_lifts WHERE through_event_id=?',newId))
        .toEqual([{through_event_id:newId}])
      expect(await current.suppressions.lookup(['owner@example.test'])).toBeNull()
    })

    it('[unit #42] preserves feedback matching for mail relayed through SMTP', async () => {
      const { current, service } = await setup()
      const mail = await current.log.createQueued(message('a@example.test'))
      await current.log.claimAttempt(mail.id, 'smtp', 'smtp-attempt', 60)
      await current.log.markSent(mail.id, 'smtp', { messageId: 'smtp-message' }, 'smtp-attempt')
      expect(
        await service.receive(post({ id: 'wrong-provider', messageId: 'smtp-message' })),
      ).toEqual({ kind: 'applied', outcome: 'bounced' })
      expect((await current.log.get(mail.id))?.status).toBe('bounced')
      expect(await current.suppressions.lookup(['owner@example.test'])).toBe('bounce')
    })

    it('[unit] a bounce moves one identity only, and the event is kept once', async () => {
      const { current, service } = await setup()
      await sent(current, 'a@example.test', 'mg-a')
      await sent(current, 'b@example.test', 'mg-b')

      await expect(
        service.receive(post({ id: 'evt-1', reason: 'suppress-bounce' })),
      ).resolves.toEqual({
        kind: 'applied',
        outcome: 'bounced',
      })
      // The same post again, as Mailgun retries it.
      await expect(service.receive(post({ id: 'evt-1' }))).resolves.toEqual({ kind: 'duplicate' })

      expect(await current.log.countByStatusPerSender()).toEqual([
        { sender: 'a@example.test', counts: expect.objectContaining({ sent: 0, bounced: 1 }) },
        { sender: 'b@example.test', counts: expect.objectContaining({ sent: 1, bounced: 0 }) },
      ])
      expect(
        await current.rows(
          'SELECT event_id AS id, outcome, detail, delivery_id AS deliveryId FROM email_feedback_events',
        ),
      ).toEqual([{ id: 'evt-1', outcome: 'bounced', detail: 'suppress-bounce', deliveryId: 1 }])
    })

    it('[unit] a complaint on a copied recipient is acted on and a delivery is only recorded', async () => {
      const { current, service } = await setup()
      await sent(current, 'a@example.test', 'mg-a')
      await sent(current, 'a@example.test', 'mg-c')

      await expect(
        service.receive(post({ id: 'evt-d', event: 'delivered', recipient: 'Owner@Example.test' })),
      ).resolves.toEqual({ kind: 'applied', outcome: 'delivered' })
      await expect(
        service.receive(
          post({
            id: 'evt-c',
            event: 'complained',
            recipient: 'copy@example.test',
            messageId: '<mg-c>',
          }),
        ),
      ).resolves.toEqual({ kind: 'applied', outcome: 'complained' })

      expect((await current.log.get(1))?.status).toBe('sent')
      expect((await current.log.get(2))?.status).toBe('complained')
    })

    it('[security] refuses a wrong key, a stale timestamp and a spent token, and writes nothing', async () => {
      const { current, service } = await setup()
      await sent(current, 'a@example.test', 'mg-a')

      await expect(service.receive(post({ id: 'evt-x', key: 'some-other-key' }))).resolves.toEqual({
        kind: 'unverified',
      })
      await expect(service.receive('not json')).resolves.toEqual({ kind: 'unverified' })
      await expect(
        service.receive(post({ id: 'evt-old', timestamp: String(seconds - 3_600) })),
      ).resolves.toEqual({ kind: 'stale' })
      expect(await current.rows('SELECT 1 FROM email_feedback_events')).toEqual([])
      expect((await current.log.get(1))?.status).toBe('sent')

      // A genuine signature carried by a different event is a replay.
      await service.receive(post({ id: 'evt-1', event: 'delivered', token: 'shared-token' }))
      await expect(service.receive(post({ id: 'evt-2', token: 'shared-token' }))).resolves.toEqual({
        kind: 'replayed',
      })
      expect((await current.log.get(1))?.status).toBe('sent')
    })

    it('[unit] ignores, but records, events that are not ours or not for an addressed recipient', async () => {
      const { current, service } = await setup()
      await sent(current, 'a@example.test', 'mg-a')

      await service.receive(post({ id: 'evt-1', messageId: 'someone-elses' }))
      await service.receive(post({ id: 'evt-2', recipient: 'stranger@example.test' }))
      await service.receive(post({ id: 'evt-3', severity: 'temporary' }))
      await service.receive(post({ id: 'evt-4', event: 'opened' }))

      expect((await current.log.get(1))?.status).toBe('sent')
      expect(await current.suppressions.snapshot()).toBe(0)
      expect(
        await current.rows<{ id: string; outcome: string }>(
          'SELECT event_id AS id, outcome FROM email_feedback_events ORDER BY event_id',
        ),
      ).toEqual([
        { id: 'evt-1', outcome: 'ignored' },
        { id: 'evt-2', outcome: 'ignored' },
        { id: 'evt-3', outcome: 'ignored' },
        { id: 'evt-4', outcome: 'ignored' },
      ])
    })

    it('[unit] answers retry while a send is mid-flight, records nothing, and lands on the retry', async () => {
      const { current, service } = await setup()
      const queued = await current.log.createQueued(message('a@example.test'))
      await current.log.claimAttempt(queued.id, 'mailgun', 'attempt-live', 60)

      const bounce = post({ id: 'evt-1' })
      await expect(service.receive(bounce)).resolves.toEqual({ kind: 'retry' })
      expect(await current.rows('SELECT 1 FROM email_feedback_events')).toEqual([])

      await current.log.markSent(queued.id, 'mailgun', { messageId: 'mg-a' }, 'attempt-live')
      await expect(service.receive(bounce)).resolves.toEqual({
        kind: 'applied',
        outcome: 'bounced',
      })
      expect((await current.log.get(queued.id))?.status).toBe('bounced')
    })

    it('[unit] completes an event that was accepted but never finished', async () => {
      const { current, service } = await setup()
      const record = await sent(current, 'a@example.test', 'mg-a')
      await expect(
        current.ledger.claim({
          eventId: 'evt-1',
          signatureToken: 'token-evt-1',
          eventType: 'failed',
          severity: 'permanent',
          recipient: 'owner@example.test',
          providerMessageId: 'mg-a',
          deliveryId: record.id,
          now: instant,
        }),
      ).resolves.toBe('fresh')

      await expect(service.receive(post({ id: 'evt-1' }))).resolves.toEqual({
        kind: 'applied',
        outcome: 'bounced',
      })
      expect((await current.log.get(record.id))?.status).toBe('bounced')
      await expect(service.receive(post({ id: 'evt-1' }))).resolves.toEqual({ kind: 'duplicate' })
    })
  })
}

it('[upgrade #42] backfills processed negative recipient evidence without rewriting its original event', async () => {
  const database = new BetterSqlite3(':memory:')
  try {
    migrateContainerThrough(database,'0139_timesheet_automatic_receipts')
    const log = createContainerEmailLogStore(database,{now:()=>instant})
    const ledger = createContainerEmailFeedbackLedger(database)
    const queued = await log.createQueued(message('a@example.test'))
    await log.claimAttempt(queued.id,'mailgun','backfill-attempt',60)
    await log.markSent(queued.id,'mailgun',{messageId:'mg-a'},'backfill-attempt')
    const feedback = createMailgunFeedbackService({signingKey:fixtureKey,log,ledger,now:()=>new Date(instant)})
    await feedback.receive(post({id:'already-processed',event:'complained',recipient:'copy@example.test'}))
    const before = database.prepare('SELECT * FROM email_feedback_events').all()
    migrateContainer(database)
    const suppressions = createContainerEmailSuppressionStore(database)
    expect(await suppressions.lookup(['copy@example.test'])).toBe('complaint')
    expect(await suppressions.lookup(['owner@example.test'])).toBeNull()
    expect(database.prepare('SELECT * FROM email_feedback_events').all()).toEqual(before)
    migrateContainer(database)
    expect(await suppressions.snapshot()).toBe(1)
    await feedback.receive(post({id:'already-processed',event:'complained',recipient:'copy@example.test'}))
    expect(await suppressions.snapshot()).toBe(1)
  } finally { database.close() }
})
