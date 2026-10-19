import { brandEmailHtml, type EmailBrand } from '@ezacto/core'
import type { EmailQueue } from '@ezacto/mailer'
import { brandAssetPath, type StoredBrandAsset } from './brand-assets.js'

/**
 * What an entry hands over to dress outgoing HTML mail (#1011): the stored
 * marks, the palette overrides, the organisation name and the instance origin
 * the logo URL is made absolute against. Read through the same surfaces the
 * shell reads, so the email and the page cannot disagree about the brand.
 */
export interface EmailBrandSource {
  assets: readonly StoredBrandAsset[]
  palette: Readonly<Record<string, string>> | null
  organizationName: string
}

/** The brand an email wears, or null when the instance has set none. */
export const emailBrandFrom = (
  source: EmailBrandSource,
  origin: string,
): EmailBrand | null => {
  const logo = source.assets.find((asset) => asset.slot === 'wordmark_light')
  const accent = source.palette?.['action']
  const brand: EmailBrand = {
    accentColor: accent ?? null,
    logoUrl:
      logo === undefined
        ? null
        : new URL(brandAssetPath('wordmark_light', logo.contentHash), origin).toString(),
    name: source.organizationName,
  }
  return brand.accentColor === null && brand.logoUrl === null ? null : brand
}

/**
 * The outgoing queue, wearing the instance header on the HTML part of each
 * message that has one.
 *
 * One seam rather than a call in each template: every mailer, whether it is
 * invoice, reminder, thank-you, sign-in, verification or test mail, ends at the
 * queue, so a mail path added later is branded without anyone remembering to.
 * The plain-text part, the sender and everything below the header are left as
 * composed.
 *
 * Read failure is "no brand". Mail is the thing that must still go out, and a
 * message without a header is the message the instance sent before this
 * existed.
 */
export const withEmailBrand = (
  queue: EmailQueue,
  brand: () => Promise<EmailBrand | null>,
): EmailQueue => ({
  async send(job) {
    const html = job.message.html
    if (html === undefined) return queue.send(job)
    let current: EmailBrand | null
    try {
      current = await brand()
    } catch {
      return queue.send(job)
    }
    const branded = brandEmailHtml(html, current)
    return queue.send(
      branded === html ? job : { ...job, message: { ...job.message, html: branded } },
    )
  },
})
