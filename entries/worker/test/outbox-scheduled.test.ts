import { readFileSync } from 'node:fs'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'

const cursorSecret = 'QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE'
const miniflares: Miniflare[] = []

afterEach(async () => {
  await Promise.all(miniflares.splice(0).map((miniflare) => miniflare.dispose()))
})

describe('Worker outbox schedule', () => {
  it('[config] enables the same bounded one-minute drainer cadence in both deployments', () => {
    const configuration = readFileSync(
      new URL('../wrangler.jsonc', import.meta.url),
      'utf8',
    )
    expect(configuration.match(/"triggers": \{ "crons": \["\* \* \* \* \*", "0 3 \* \* \*"\] \}/gu)).toHaveLength(2)
  })

  it('[integration] drains a committed D1 outbox row through a real scheduled Worker event', async () => {
    const bundled = await build({
      entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
      bundle: true,
      conditions: ['development'],
      format: 'esm',
      platform: 'browser',
    // Left to workerd rather than bundled (#743): the Sentry Cloudflare SDK
    // imports node:async_hooks for per-request isolation, which the runtime
    // provides under the nodejs_als compatibility flag. esbuild at
    // platform: browser cannot resolve it and must not try.
    external: ['node:async_hooks'],
      target: 'es2022',
      write: false,
    })
    const miniflare = new Miniflare({
      bindings: {
        API_CURSOR_SIGNING_KEY: cursorSecret,
        ENVIRONMENT: 'test',
        RELEASE: 'outbox-scheduled-test',
      },
      compatibilityDate: '2026-08-06',
      // The Sentry SDK's per-request isolation needs AsyncLocalStorage (#743).
      compatibilityFlags: ['nodejs_als'],
      d1Databases: ['DB'],
      modules: true,
      script: bundled.outputFiles[0]!.text,
      unsafeTriggerHandlers: true,
    })
    miniflares.push(miniflare)

    await miniflare.dispatchFetch('https://worker.test/api/v1')
    const database = await miniflare.getD1Database('DB')
    const occurredAt = '2026-01-02T03:04:05.000Z'
    await database
      .prepare(
        `INSERT INTO event_outbox (
          id, aggregate_type, aggregate_id, aggregate_sequence,
          event_type, payload_json, occurred_at, available_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        'scheduled-event-1',
        'fixture',
        91,
        1,
        'fixture.committed',
        JSON.stringify({ schema_version: 1, event_type: 'fixture.committed' }),
        occurredAt,
        occurredAt,
      )
      .run()

    const response = await miniflare.dispatchFetch(
      'https://worker.test/cdn-cgi/handler/scheduled?time=1788350400000&cron=*+*+*+*+*',
    )
    expect(response.status).toBe(200)
    await expect(
      database
        .prepare(
          `SELECT receipt.status, event.published_at AS publishedAt,
            activity.recorded_at AS recordedAt
           FROM event_outbox event
           JOIN outbox_delivery_receipts receipt ON receipt.event_id = event.id
           JOIN activity_log activity ON activity.event_id = event.id
           WHERE event.id = ?`,
        )
        .bind('scheduled-event-1')
        .first(),
    ).resolves.toMatchObject({
      status: 'delivered',
      publishedAt: expect.any(String),
      recordedAt: expect.any(String),
    })
  }, 30_000)

  it('[integration] registers the reminder scheduler as a subscriber of the deployed drainer', async () => {
    // For a long time no runtime registered it: `reminder_policy` was accepted
    // and stored, and `scheduled_reminders` stayed permanently empty in every
    // deployment. What this asserts is registration, through the real bundle --
    // constructing a scheduler here would pass whether or not the Worker builds
    // one. Scheduling behaviour itself is covered against the real command path
    // in packages/db/test/reminders.test.ts.
    const bundled = await build({
      entryPoints: [new URL('../src/index.ts', import.meta.url).pathname],
      bundle: true,
      conditions: ['development'],
      format: 'esm',
      platform: 'browser',
    // Left to workerd rather than bundled (#743): the Sentry Cloudflare SDK
    // imports node:async_hooks for per-request isolation, which the runtime
    // provides under the nodejs_als compatibility flag. esbuild at
    // platform: browser cannot resolve it and must not try.
    external: ['node:async_hooks'],
      target: 'es2022',
      write: false,
    })
    const miniflare = new Miniflare({
      bindings: {
        API_CURSOR_SIGNING_KEY: cursorSecret,
        ENVIRONMENT: 'test',
        RELEASE: 'reminder-subscriber-test',
      },
      compatibilityDate: '2026-08-06',
      // The Sentry SDK's per-request isolation needs AsyncLocalStorage (#743).
      compatibilityFlags: ['nodejs_als'],
      d1Databases: ['DB'],
      modules: true,
      script: bundled.outputFiles[0]!.text,
      unsafeTriggerHandlers: true,
    })
    miniflares.push(miniflare)
    await miniflare.dispatchFetch('https://worker.test/api/v1')
    const database = await miniflare.getD1Database('DB')
    const at = '2026-01-02T03:04:05.000Z'

    // A non-invoice aggregate, so the D22 command-ledger guard does not apply.
    // The reminder subscriber returns without work for it, and a subscriber
    // that returns still leaves a receipt -- which is exactly the evidence
    // that it was in the set the drain walked.
    await database
      .prepare(
        `INSERT INTO event_outbox (
          id, aggregate_type, aggregate_id, aggregate_sequence,
          event_type, payload_json, occurred_at, available_at
        ) VALUES (?, 'fixture', 91, 1, 'fixture.committed', ?, ?, ?)`,
      )
      .bind(
        'reminder-subscriber-1',
        JSON.stringify({ schema_version: 1, event_type: 'fixture.committed' }),
        at,
        at,
      )
      .run()

    const response = await miniflare.dispatchFetch(
      'https://worker.test/cdn-cgi/handler/scheduled?time=1788350400000&cron=*+*+*+*+*',
    )
    expect(response.status).toBe(200)

    const receipts = await database
      .prepare(
        `SELECT subscriber_id AS subscriberId, status
         FROM outbox_delivery_receipts
         WHERE event_id = ? ORDER BY subscriber_id`,
      )
      .bind('reminder-subscriber-1')
      .all()
    expect(receipts.results).toContainEqual({
      subscriberId: 'reminder_scheduler',
      status: 'delivered',
    })
  }, 30_000)
})
