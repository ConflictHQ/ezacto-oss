import { createHmac } from 'node:crypto'
import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createMailgunFeedbackService,
  type EmailFeedbackLedger,
  type EmailLogStore,
  type EmailMessage,
  type MailgunFeedbackService,
} from '@ezacto/mailer'
import { createContainerEmailFeedbackLedger, createD1EmailFeedbackLedger } from '../src/email-feedback-events.js'
import { createContainerEmailLogStore, createD1EmailLogStore } from '../src/email-log.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'

// A made-up key for this file only. Nothing here is, or resembles, a real one.
const fixtureKey = 'fixture-mailgun-webhook-key-for-tests'
const instant = '2026-10-19T12:00:00.000Z'
const seconds = Date.parse(instant) / 1000

interface Harness {
  log: EmailLogStore
  ledger: EmailFeedbackLedger
  rows<T>(query: string, ...bindings: unknown[]): Promise<T[]>
  close(): Promise<void>
}

const containerHarness = async (): Promise<Harness> => {
  const database = new BetterSqlite3(':memory:')
  migrateContainer(database)
  return {
    log: createContainerEmailLogStore(database, { now: () => instant }),
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
  createHmac('sha256', key).update(timestamp + token).digest('hex')

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

    it('[unit] a bounce moves one identity only, and the event is kept once', async () => {
      const { current, service } = await setup()
      await sent(current, 'a@example.test', 'mg-a')
      await sent(current, 'b@example.test', 'mg-b')

      await expect(service.receive(post({ id: 'evt-1', reason: 'suppress-bounce' }))).resolves.toEqual({
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
          post({ id: 'evt-c', event: 'complained', recipient: 'copy@example.test', messageId: '<mg-c>' }),
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
      await expect(service.receive(bounce)).resolves.toEqual({ kind: 'applied', outcome: 'bounced' })
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
