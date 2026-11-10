import type { EmailLogRecord, EmailLogStore, MailgunMailer } from '@ezacto/mailer'
import type { InvoiceFeedbackRecoveryLedger } from '@ezacto/db'

interface HeldAttempt {
  record: EmailLogRecord
  attemptId: string
  claimedAt: string
}

/** One bounded page. The caller must persist/advance its cursor and retry later. */
export const reconcileHeldMailgunReminders = async (input: {
  afterId: number
  list: (afterId: number, limit: number) => Promise<HeldAttempt[]>
  lookup: Pick<MailgunMailer, 'findReminderReceipt'>
  log: Pick<EmailLogStore, 'get' | 'markSent'> & {
    recordReminderFeedback(deliveryId: number, attemptId: string, messageId: string,
      feedback: readonly { eventId: string; recipient: string; type: 'failed' | 'complained' }[]): Promise<boolean>
  }
}): Promise<{ nextId: number | null; examined: number; reconciled: number; deferred: number }> => {
  const page = await input.list(input.afterId, 10)
  let reconciled = 0
  let deferred = 0
  for (const { record, attemptId, claimedAt } of page) {
    const claimed = Date.parse(claimedAt)
    if (!Number.isFinite(claimed) ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(attemptId)) {
      deferred += 1
      continue
    }
    const begin = Math.floor(claimed / 1000) - 300
    let receipt: Awaited<ReturnType<MailgunMailer['findReminderReceipt']>>
    try {
      receipt = await input.lookup.findReminderReceipt({
        deliveryId: record.id, attemptId, recipients: [...record.to, ...record.cc].map(person => person.email),
        begin, end: begin + 86_400,
      })
    } catch {
      // Never log provider responses, credentials or recipient data. Keep the
      // held claim for a later pass; an error is not evidence of non-delivery.
      deferred += 1
      continue
    }
    if (receipt === null) {
      deferred += 1
      continue
    }
    if (receipt.feedback !== undefined) {
      if (await input.log.recordReminderFeedback(record.id, attemptId, receipt.messageId, receipt.feedback)) reconciled += 1
      else deferred += 1
      continue
    }
    try {
      await input.log.markSent(record.id, 'mailgun', receipt, attemptId)
      reconciled += 1
    } catch (error) {
      // A concurrent provider response or webhook can win the same CAS. If
      // the claim is still held, surface the failure for the scheduler to retry.
      const current = await input.log.get(record.id)
      if (current?.status === 'queued') throw error
      deferred += 1
    }
  }
  return { nextId: page.length === 10 ? page[page.length - 1]!.record.id : null,
    examined: page.length, reconciled, deferred }
}

/** Claim one page durably; a crash leaves the same page retryable after the lease. */
export const runReminderReconciliation = async (input: {
  store: Pick<EmailLogStore, 'get' | 'markSent'> & {
    recordReminderFeedback(deliveryId: number, attemptId: string, messageId: string,
      feedback: readonly { eventId: string; recipient: string; type: 'failed' | 'complained' }[]): Promise<boolean>
    heldReminderAttempts(afterId: number, limit: number): Promise<HeldAttempt[]>
    claimReminderSweep(token: string): Promise<number | null>
    finishReminderSweep(token: string, afterId: number, more: boolean): Promise<boolean>
  }
  lookup: Pick<MailgunMailer, 'findReminderReceipt'>
  token?: string
}): Promise<void> => {
  const token = input.token ?? crypto.randomUUID()
  const afterId = await input.store.claimReminderSweep(token)
  if (afterId === null) return
  const result = await reconcileHeldMailgunReminders({ afterId, list: input.store.heldReminderAttempts,
    lookup: input.lookup, log: input.store })
  await input.store.finishReminderSweep(token, result.nextId ?? 0, result.nextId !== null)
}

/** Revisit recorded invoice feedback without sending mail. An unsuccessful
 * lookup is never treated as proof that the provider event did not happen. */
export const runInvoiceFeedbackRecovery = async (input: {
  ledger: InvoiceFeedbackRecoveryLedger
  lookup: Pick<MailgunMailer, 'inspectInvoiceFeedback'>
  now?: () => string
  token?: string
}): Promise<void> => {
  const now = input.now ?? (() => new Date().toISOString())
  const token = input.token ?? crypto.randomUUID()
  const afterId = await input.ledger.claimInvoiceFeedbackSweep(token, now())
  if (afterId === null) return
  const page = await input.ledger.unverifiedInvoiceFeedback(afterId, 10)
  for (const item of page) {
    const received = Math.floor(Date.parse(item.receivedAt) / 1000)
    if (!Number.isSafeInteger(received)) continue
    let verified = false
    try {
      verified = await input.lookup.inspectInvoiceFeedback({ eventId: item.eventId, messageId: item.messageId,
        recipient: item.recipient, eventType: item.eventType, begin: received - 86_100, end: received + 300 })
    } catch {
      // Keep this exact record unverified; do not log provider or recipient data.
    }
    if (verified) await input.ledger.recordInvoiceEvidence(item.eventId, now())
  }
  const more = page.length === 10
  await input.ledger.finishInvoiceFeedbackSweep(token, more ? page[page.length - 1]!.eventId : '', more, now())
}
