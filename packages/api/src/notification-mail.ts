import {
  configuredEmailSender,
  type EmailMessage,
  type EmailSender,
  type QueuedMailer,
} from '@ezacto/mailer'

/**
 * Mail ezacto sends to its own people (issues 934, 935): budget alerts and
 * time reminders. It goes out on the deployment sender, like the sign-in and
 * erasure notices, because it is the instance talking to the people who run it
 * and not an organization writing to a client.
 *
 * The message is always a row the ledger has already recorded. This only puts
 * that row on the queue, so a queue that is down costs a retry and never a
 * second message.
 */
export interface NotificationMessage {
  readonly deliveryId: number
  readonly from: EmailSender
  readonly to: { readonly email: string; readonly name: string }
  readonly template: string
  readonly subject: string
  readonly text: string
  readonly related?: { readonly type: string; readonly id: number }
}

export interface NotificationMailer {
  /** The deployment sender the ledger records as the message's From. */
  readonly from: EmailSender
  enqueue(message: Readonly<NotificationMessage>): Promise<void>
}

export const createDeploymentNotificationMailer = (
  from: string,
  queued: QueuedMailer,
): NotificationMailer => {
  const sender = configuredEmailSender(from)
  return {
    from: sender,
    async enqueue(message) {
      if (queued.enqueueExisting === undefined) {
        throw new Error('notification durable enqueue is unavailable')
      }
      const body: EmailMessage = {
        from: message.from,
        to: [
          message.to.name === ''
            ? { email: message.to.email }
            : { email: message.to.email, name: message.to.name },
        ],
        template: message.template,
        subject: message.subject,
        text: message.text,
        ...(message.related === undefined ? {} : { related: message.related }),
      }
      await queued.enqueueExisting(message.deliveryId, body)
    },
  }
}

export interface BudgetAlertOutboxEvent {
  readonly eventType: string
  readonly payload: Readonly<Record<string, unknown>>
}

export interface BudgetAlertPort {
  /**
   * Decides, renders and records, and returns what to queue: empty for every
   * ordinary reason there is nothing to send.
   */
  prepare(alertId: number): Promise<readonly NotificationMessage[]>
}

const alertIdOf = (event: Readonly<BudgetAlertOutboxEvent>): number => {
  const project = event.payload.project
  const id =
    typeof project === 'object' && project !== null
      ? (project as Record<string, unknown>).alert_id
      : undefined
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) {
    throw new Error('project.budget_alert event does not name its alert')
  }
  return id
}

/**
 * Sends the mail for a budget crossing (issue 934). An outbox subscriber, as
 * the thank-you is, for the same reason: the outbox retries, so a queue that is
 * briefly unavailable costs a retry and not the alert, and the port's ledger
 * means a retry never costs anybody a second one.
 *
 * Throws rather than staying quiet when the queue is unavailable. The messages
 * are already recorded, so silence would leave the book saying a manager was
 * told when nothing was queued; throwing returns the event to the outbox.
 */
export const createBudgetAlertSubscriber = (
  port: BudgetAlertPort,
  mailer: Pick<NotificationMailer, 'enqueue'>,
): {
  readonly id: 'budget_alert_mail'
  deliver(event: Readonly<BudgetAlertOutboxEvent>): Promise<void>
} => ({
  id: 'budget_alert_mail',
  async deliver(event) {
    if (event.eventType !== 'project.budget_alert') return
    const messages = await port.prepare(alertIdOf(event))
    for (const message of messages) await mailer.enqueue(message)
  },
})

export interface TimeReminderPort {
  /**
   * One pass: decides who is due a reminder in their own local time, records
   * each decision, and returns the messages to queue -- the ones just recorded
   * and any recorded earlier that never left the queue.
   */
  prepare(now: string): Promise<readonly NotificationMessage[]>
}

export interface TimeReminderSummary {
  readonly queued: number
}

/**
 * The time reminders and the week-end submission reminders (issue 935), run on
 * a clock: the Worker's minute cron, the container's outbox tick.
 *
 * A message that cannot be queued does not stop the others, and the failure is
 * thrown once all have been tried so the caller reports it. The message is
 * already recorded, so the next pass queues it again from the record.
 */
export const createTimeReminderService = (
  port: TimeReminderPort,
  mailer: Pick<NotificationMailer, 'enqueue'>,
): { processDue(now: string): Promise<TimeReminderSummary> } => ({
  async processDue(now) {
    const messages = await port.prepare(now)
    let queued = 0
    let failure: unknown
    for (const message of messages) {
      try {
        await mailer.enqueue(message)
        queued += 1
      } catch (error) {
        failure ??= error
      }
    }
    if (failure !== undefined) throw failure
    return { queued }
  },
})
