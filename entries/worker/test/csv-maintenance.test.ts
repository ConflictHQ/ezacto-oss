import { beforeEach, expect, it, vi } from 'vitest'
import { worker } from '../src/index.js'
import { createRuntimeServices } from '../src/runtime.js'
import { runDemoMaintenance } from '../src/demo.js'
import * as Sentry from '@sentry/cloudflare'

vi.mock('../src/runtime.js', async (original) => ({
  ...(await original<object>()),
  createRuntimeServices: vi.fn(),
}))
vi.mock('../src/demo.js', async (original) => ({
  ...(await original<object>()),
  runDemoMaintenance: vi.fn(),
}))
vi.mock('@sentry/cloudflare', async (original) => ({
  ...(await original<object>()),
  captureException: vi.fn(),
  withSentry: (_options: unknown, handler: unknown) => handler,
}))
beforeEach(() => vi.clearAllMocks())
it.each(['purge', 'publish'] as const)(
  'isolates a failed CSV %s enqueue and still runs the other phase and independent jobs',
  async (failure) => {
    const calls: string[] = []
    vi.mocked(createRuntimeServices).mockResolvedValue({
      paymentRuns: {
        processDue: async () => {
          calls.push('payment')
        },
      },
      outbox: {
        drain: async () => {
          calls.push('outbox')
          return {}
        },
      },
    } as never)
    vi.mocked(runDemoMaintenance).mockImplementation(async () => {
      calls.push('maintenance')
      return { ran: 'nothing' } as never
    })
    const queue = {
      send: async (body: { phase: string }) => {
        calls.push(body.phase)
        if (body.phase === failure) throw new Error('private-csv-canary')
      },
    }
    await worker.scheduled!(
      { cron: '* * * * *', scheduledTime: Date.now() } as never,
      {
        DB: {},
        ATTACHMENTS: {},
        CSV_IMPORT_QUEUE: queue,
        CSV_IMPORT_QUEUE_NAME: 'owned-csv-maintenance',
      } as never,
      {} as never,
    )
    expect(calls).toEqual(['purge', 'publish', 'payment', 'maintenance', 'outbox'])
    expect(Sentry.captureException).toHaveBeenCalledOnce()
    const captured = vi.mocked(Sentry.captureException).mock.calls[0]![0] as Error
    expect(captured.message).toBe('eZacto runtime failure')
    expect(captured.message).not.toContain('private-csv-canary')
  },
)
