import { describe, expect, it, vi } from 'vitest'
import {
  createTimeReminderService,
  type NotificationMessage,
} from '../src/notification-mail.js'

const message = (deliveryId: number): NotificationMessage => ({
  deliveryId,
  from: { email: 'notifications@example.test', name: 'CONFLICT' },
  to: { email: `person${String(deliveryId)}@example.test`, name: 'Person' },
  template: 'time_reminder:v1',
  subject: 'Time reminder: log your hours for Wednesday, October 14',
  text: 'Log your time.',
})

describe('time reminder service (issue 935)', () => {
  it('[unit] passes the instant to the pass and queues what it returns', async () => {
    const prepare = vi.fn<(now: string) => Promise<NotificationMessage[]>>(async () => [message(1), message(2)])
    const enqueue = vi.fn<(sent: NotificationMessage) => Promise<void>>(async () => undefined)
    const service = createTimeReminderService({ prepare }, { enqueue })

    expect(await service.processDue('2026-10-14T15:30:00.000Z')).toEqual({ queued: 2 })

    expect(prepare).toHaveBeenCalledWith('2026-10-14T15:30:00.000Z')
    expect(enqueue.mock.calls.map(([sent]) => sent.deliveryId)).toEqual([1, 2])
  })

  it('[unit] does nothing, quietly, when nobody is due', async () => {
    const enqueue = vi.fn()
    const service = createTimeReminderService({ prepare: async () => [] }, { enqueue })
    expect(await service.processDue('2026-10-14T15:30:00.000Z')).toEqual({ queued: 0 })
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('[reliability] tries every message when one cannot be queued, then reports the failure', async () => {
    const enqueue = vi.fn(async (sent: NotificationMessage) => {
      if (sent.deliveryId === 1) throw new Error('email queue is unavailable')
    })
    const service = createTimeReminderService(
      { prepare: async () => [message(1), message(2), message(3)] },
      { enqueue },
    )

    await expect(service.processDue('2026-10-14T15:30:00.000Z')).rejects.toThrow(
      'email queue is unavailable',
    )
    // One bad message did not cost the others; the failed one is already
    // recorded and the next pass queues it again from the record.
    expect(enqueue.mock.calls.map(([sent]) => sent.deliveryId)).toEqual([1, 2, 3])
  })
})
