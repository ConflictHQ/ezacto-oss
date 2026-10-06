import type { InvoiceRecipient } from '@conflict-hq/ezacto-client'
import { invoiceEmailPattern } from '@ezacto/core'

/**
 * Invoice email addresses as somebody types them into a box: one per line,
 * `email@example.com` or `Name <email@example.com>`.
 *
 * The line format is the invoice Send dialog's (`invoiceRecipients` in
 * `invoices/model.ts`), and so is its one forgiving rule -- an address listed
 * twice is kept once -- so a list typed on a client or in the company settings
 * is typed the way the dialog it fills is typed. Mirrored rather than imported
 * because the standing lists answer to the route's limits, not the dialog's:
 * the pattern and the lengths are `normalizeInvoiceAddresses` in @ezacto/core,
 * and each list has its own cap. Checking them here is what turns the server's
 * `to[2]` into a sentence that names the line which is wrong.
 */

/** One address as a line of the box, the inverse of the parser below. */
export const invoiceAddressLine = (address: Readonly<InvoiceRecipient>): string =>
  address.name.trim() === '' ? address.email : `${address.name} <${address.email}>`

export const invoiceAddressLines = (addresses: readonly Readonly<InvoiceRecipient>[]): string =>
  addresses.map(invoiceAddressLine).join('\n')

/**
 * A box of lines, as addresses. `list` names the box in the messages ("To",
 * "Cc"). An empty box is no addresses, which is an answer for every list --
 * whether one is required, and how many fit, is the caller's to say.
 */
export const parseInvoiceAddressLines = (raw: string, list: string): InvoiceRecipient[] => {
  const addresses: InvoiceRecipient[] = []
  const seen = new Set<string>()
  for (const line of raw.split(/\r?\n/u).map((entry) => entry.trim())) {
    if (line === '') continue
    const named = /^(.*?)\s*<([^<>]+)>$/u.exec(line)
    const name = named === null ? '' : named[1]!.trim()
    const email = (named === null ? line : named[2]!).trim()
    if (email.length > 254 || !invoiceEmailPattern.test(email)) {
      throw new Error(
        `${list}: “${line}” is not an email address. Write email@example.com or Name <email@example.com>.`,
      )
    }
    if (name.length > 200 || /\p{Cc}/u.test(name)) {
      throw new Error(`${list}: the name in “${line}” must be plain text of at most 200 characters.`)
    }
    const key = email.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    addresses.push({ name, email })
  }
  return addresses
}

/** The route's cap on one list, said before the request rather than after it. */
export const assertInvoiceAddressCount = (
  addresses: readonly InvoiceRecipient[],
  list: string,
  maximum: number,
): void => {
  if (addresses.length > maximum) {
    throw new Error(`${list} can hold at most ${maximum} addresses.`)
  }
}
