import { describe, expect, it, vi } from 'vitest'
import { createInvoiceEmailOutboxSubscriber } from '../src/money-resources.js'

describe('invoice email outbox subscriber', () => {
  it('[unit] enqueues each persisted recipient with its exact receipt id and ignores record-only sends', async () => {
    const enqueuePersisted = vi.fn(async () => undefined)
    const listInvoiceDeliveryJobs = vi.fn(async (eventId: string) =>
      eventId === 'delivered-event'
        ? [
            {
              deliveryId: 701,
              senderIdentityId: 91,
              senderIdentityVersion: 2,
              senderEvidenceVersion: 4,
              fromName: 'Billing',
              fromEmail: 'billing@example.com',
              replyToEmail: null,
              recipientName: 'Client',
              recipientEmail: 'client@example.net',
              templateVersion: 3,
              subject: 'Invoice INV-1',
              textBody: 'Amount $12.34',
              htmlBody: null,
              invoiceMessageId: 100,
            },
          ]
        : [],
    )
    const subscriber = createInvoiceEmailOutboxSubscriber(
      { listInvoiceDeliveryJobs },
      { assertAvailable: vi.fn(), enqueue: vi.fn(), enqueuePersisted },
    )

    await subscriber.deliver({ id: 'record-only-event', eventType: 'invoice.sent' })
    expect(enqueuePersisted).not.toHaveBeenCalled()
    await subscriber.deliver({ id: 'delivered-event', eventType: 'invoice.sent' })
    expect(enqueuePersisted).toHaveBeenCalledWith(
      701,
      expect.objectContaining({
        senderIdentityId: 91,
        senderIdentityVersion: 2,
        senderEvidenceVersion: 4,
      }),
      expect.objectContaining({
        to: [{ email: 'client@example.net', name: 'Client' }],
        template: 'invoice:3',
      }),
    )
  })
})
