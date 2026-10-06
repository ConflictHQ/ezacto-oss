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
              to: [{ name: 'Client', email: 'client@example.net' }],
              cc: [],
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

    await subscriber.deliver({ id: 'record-only-event', eventType: 'invoice.sent', aggregateId: 1 })
    expect(enqueuePersisted).not.toHaveBeenCalled()
    await subscriber.deliver({ id: 'delivered-event', eventType: 'invoice.sent', aggregateId: 1 })
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
      // No document port was supplied, so nothing is attached. Stated rather
      // than left off: the argument exists now, and a send that quietly grew
      // an attachment would be a change worth failing on.
      undefined,
    )
    // Nobody was copied, so the message carries no Cc header at all.
    expect((enqueuePersisted.mock.calls as unknown as unknown[][])[0]?.[2]).not.toHaveProperty('cc')
  })

  it('[unit] sends one email To accounts payable and Cc everyone copied', async () => {
    const enqueuePersisted = vi.fn(async () => undefined)
    const subscriber = createInvoiceEmailOutboxSubscriber(
      {
        listInvoiceDeliveryJobs: vi.fn(async () => [
          {
            deliveryId: 701,
            senderIdentityId: 91,
            senderIdentityVersion: 2,
            senderEvidenceVersion: 4,
            fromName: 'Billing',
            fromEmail: 'billing@example.com',
            replyToEmail: null,
            to: [{ name: 'Accounts Payable', email: 'ap@northwind.example' }],
            cc: [
              { name: 'Pat Example', email: 'pat@northwind.example' },
              { name: '', email: 'finance@example.com' },
            ],
            templateVersion: 3,
            subject: 'Invoice #4021 from Example Studio LLC',
            textBody: 'Amount Due: $12,500.00 USD',
            htmlBody: null,
            invoiceMessageId: 100,
          },
        ]),
      },
      { assertAvailable: vi.fn(), enqueue: vi.fn(), enqueuePersisted },
    )
    await subscriber.deliver({ id: 'e1', eventType: 'invoice.sent', aggregateId: 1 })
    expect(enqueuePersisted).toHaveBeenCalledTimes(1)
    expect(enqueuePersisted).toHaveBeenCalledWith(
      701,
      expect.anything(),
      expect.objectContaining({
        to: [{ email: 'ap@northwind.example', name: 'Accounts Payable' }],
        // A copy with no name is addressed by address alone.
        cc: [{ email: 'pat@northwind.example', name: 'Pat Example' }, { email: 'finance@example.com' }],
      }),
      undefined,
    )
  })
})

describe('the document that goes with an invoice message', () => {
  const job = (deliveryId: number, recipientEmail: string) => ({
    deliveryId,
    senderIdentityId: 91,
    senderIdentityVersion: 2,
    senderEvidenceVersion: 4,
    fromName: 'Billing',
    fromEmail: 'billing@example.com',
    replyToEmail: null,
    to: [{ name: 'Client', email: recipientEmail }],
    cc: [],
    templateVersion: 3,
    subject: 'Invoice INV-1',
    textBody: 'Amount $12.34',
    htmlBody: null,
    invoiceMessageId: 100,
  })

  const reference = {
    key: 'invoice-documents/1/100.pdf',
    filename: 'invoice-1315.pdf',
    contentType: 'application/pdf',
  }

  const harness = (prepare: ReturnType<typeof vi.fn>) => {
    const enqueuePersisted = vi.fn(async () => undefined)
    const subscriber = createInvoiceEmailOutboxSubscriber(
      {
        listInvoiceDeliveryJobs: vi.fn(async () => [
          job(701, 'one@example.net'),
          job(702, 'two@example.net'),
        ]),
      },
      { assertAvailable: vi.fn(), enqueue: vi.fn(), enqueuePersisted },
      { prepare: prepare as never },
    )
    return { subscriber, enqueuePersisted }
  }

  it('[unit] prepares it once for a message with several emails', async () => {
    // A message sent before copies existed wrote one email per recipient, and
    // every one of them carries the message's single document. Rendering per
    // email would put several identical objects in the bucket for one send.
    const prepare = vi.fn(async () => [reference])
    const { subscriber, enqueuePersisted } = harness(prepare)
    await subscriber.deliver({ id: 'e1', eventType: 'invoice.sent', aggregateId: 1 })
    expect(prepare).toHaveBeenCalledTimes(1)
    expect(prepare).toHaveBeenCalledWith({ invoiceId: 1, invoiceMessageId: 100 })
    expect(enqueuePersisted).toHaveBeenCalledTimes(2)
    // The mock is declared with no parameters, so its recorded calls are typed
    // as an empty tuple; the arguments are still there to read.
    for (const call of enqueuePersisted.mock.calls as unknown as unknown[][]) {
      expect(call[3]).toEqual([reference])
    }
  })

  it('[unit] attaches nothing when the port says so, and still sends', async () => {
    // `null` is the ordinary answer whenever the preference is off. The message
    // must still go.
    const { subscriber, enqueuePersisted } = harness(vi.fn(async () => []))
    await subscriber.deliver({ id: 'e1', eventType: 'invoice.sent', aggregateId: 1 })
    expect(enqueuePersisted).toHaveBeenCalledTimes(2)
    expect((enqueuePersisted.mock.calls as unknown as unknown[][])[0]?.[3]).toBeUndefined()
  })

  it('[unit] passes the invoice the event is about, not the message id', async () => {
    // The two are different numbers and confusing them would render somebody
    // else's invoice.
    const prepare = vi.fn(async () => [reference])
    const { subscriber } = harness(prepare)
    await subscriber.deliver({ id: 'e1', eventType: 'invoice.sent', aggregateId: 4242 })
    expect(prepare).toHaveBeenCalledWith({ invoiceId: 4242, invoiceMessageId: 100 })
  })
})
