import { describe, expect, it, vi } from 'vitest'
import type { QueuedMailer } from '@ezacto/mailer'
import {
  createBudgetAlertSubscriber,
  createDeploymentNotificationMailer,
  type NotificationMessage,
} from '../src/notification-mail.js'

const message = (deliveryId: number, email: string): NotificationMessage => ({
  deliveryId,
  from: { email: 'notifications@example.test', name: 'CONFLICT' },
  to: { email, name: 'Pia Manager' },
  template: 'budget_alert:v1',
  subject: 'Budget alert: Site survey has used 90% of its hours budget',
  text: 'Site survey has used 90% of its hours budget.',
  related: { type: 'project', id: 1 },
})

const event = (alertId: unknown) => ({
  eventType: 'project.budget_alert',
  payload: { project: { alert_id: alertId } },
})

describe('budget alert subscriber (issue 934)', () => {
  it('[unit] queues each recorded message for the alert the event names', async () => {
    const prepare = vi.fn(async () => [message(7, 'pia@example.test'), message(8, 'ada@example.test')])
    const enqueue = vi.fn<(sent: NotificationMessage) => Promise<void>>(async () => undefined)
    const subscriber = createBudgetAlertSubscriber({ prepare }, { enqueue })

    await subscriber.deliver(event(12))

    expect(subscriber.id).toBe('budget_alert_mail')
    expect(prepare).toHaveBeenCalledWith(12)
    expect(enqueue.mock.calls.map(([sent]) => sent.deliveryId)).toEqual([7, 8])
  })

  it('[unit] ignores every other event', async () => {
    const prepare = vi.fn(async () => [])
    const subscriber = createBudgetAlertSubscriber({ prepare }, { enqueue: vi.fn() })
    await subscriber.deliver({ eventType: 'invoice.paid', payload: {} })
    expect(prepare).not.toHaveBeenCalled()
  })

  it('[reliability] fails the delivery when the queue is down, so the outbox retries it', async () => {
    const enqueue = vi.fn(async () => {
      throw new Error('email queue is unavailable')
    })
    const subscriber = createBudgetAlertSubscriber(
      { prepare: async () => [message(7, 'pia@example.test')] },
      { enqueue },
    )
    await expect(subscriber.deliver(event(12))).rejects.toThrow('email queue is unavailable')
  })

  it('[reliability] refuses an event that does not name its alert instead of mailing nobody', async () => {
    const subscriber = createBudgetAlertSubscriber({ prepare: async () => [] }, { enqueue: vi.fn() })
    await expect(subscriber.deliver(event(undefined))).rejects.toThrow('does not name its alert')
    await expect(subscriber.deliver(event('12'))).rejects.toThrow('does not name its alert')
    await expect(subscriber.deliver({ eventType: 'project.budget_alert', payload: {} })).rejects.toThrow(
      'does not name its alert',
    )
  })

  it('[unit] puts a recorded message on the queue under its own delivery id and the deployment sender', async () => {
    const enqueueExisting = vi.fn(async () => undefined)
    const queued: QueuedMailer = { enqueue: vi.fn(), enqueueExisting }
    const mailer = createDeploymentNotificationMailer('CONFLICT <notifications@example.test>', queued)

    expect(mailer.from).toEqual({ email: 'notifications@example.test', name: 'CONFLICT' })
    await mailer.enqueue(message(7, 'pia@example.test'))

    expect(queued.enqueue).not.toHaveBeenCalled()
    expect(enqueueExisting).toHaveBeenCalledWith(7, {
      from: { email: 'notifications@example.test', name: 'CONFLICT' },
      to: [{ email: 'pia@example.test', name: 'Pia Manager' }],
      template: 'budget_alert:v1',
      subject: 'Budget alert: Site survey has used 90% of its hours budget',
      text: 'Site survey has used 90% of its hours budget.',
      related: { type: 'project', id: 1 },
    })
  })

  it('[reliability] refuses a queue that cannot take an already-recorded message', async () => {
    const mailer = createDeploymentNotificationMailer('notifications@example.test', {
      enqueue: vi.fn(),
    })
    await expect(mailer.enqueue(message(7, 'pia@example.test'))).rejects.toThrow('unavailable')
  })
})
