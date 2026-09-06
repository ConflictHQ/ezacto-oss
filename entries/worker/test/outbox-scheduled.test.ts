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
})
