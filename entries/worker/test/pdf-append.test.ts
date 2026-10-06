import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PDFArray,
  PDFDocument,
  PDFInvalidObject,
  PDFRawStream,
  PageSizes,
  StandardFonts,
  decodePDFRawStream,
  type PDFPage,
} from 'pdf-lib'
import { renderInvoiceDocument } from '@ezacto/core'
import { appendPdfs } from '../src/pdf-append.js'

/**
 * The supporting files bound in behind the invoice, for an accounts-payable
 * department that books an invoice only as one document: the invoice on the
 * first page, its purchase order after it. Every file is made here -- the
 * invoice by the renderer that sends it, the supporting files with pdf-lib,
 * and the ones that must not be bound in by hand -- so what is wrong with each
 * of those is written down where it is used.
 */

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

const latin1 = (text: string): Uint8Array => Uint8Array.from(text, (character) => character.charCodeAt(0))

/** `bytes` with the one occurrence of `from` replaced: a PDF's syntax is bytes below 256. */
const replaceOnce = (bytes: Uint8Array, from: string, to: string): Uint8Array => {
  const text = Array.from(bytes, (byte) => String.fromCharCode(byte)).join('')
  const at = text.indexOf(from)
  if (at < 0 || text.includes(from, at + 1)) throw new Error(`"${from}" is not in the file exactly once`)
  return latin1(text.slice(0, at) + to + text.slice(at + from.length))
}

/** Long enough notes to carry the invoice on to a second page, so "first" means all of it. */
const invoice = renderInvoiceDocument({
  number: '1315',
  companyName: 'Halcyon Studio',
  clientName: 'Kestrel Environmental',
  issueDate: '2026-09-12',
  dueDate: '2026-10-12',
  currency: 'USD',
  subject: 'Tracked work',
  lines: [
    { kind: 'Service', description: 'Advisory', quantity: 1, unitPriceCents: 250_000, amountCents: 250_000 },
  ],
  subtotalCents: 250_000,
  discountCents: 0,
  taxCents: 0,
  totalCents: 250_000,
  notes: Array.from({ length: 80 }, (_, line) => `Remittance reference ${String(line + 1)}`).join('\n'),
})

/** A supporting file as most generators write one: text, on pages of its own size. */
const letter = async (
  ...pages: readonly { readonly size: [number, number]; readonly text: string }[]
): Promise<PDFDocument> => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (const { size, text } of pages) {
    document.addPage(size).drawText(text, { font, size: 12, x: 72, y: size[1] - 72 })
  }
  return document
}

const purchaseOrder = async (): Promise<Uint8Array> =>
  (
    await letter(
      { size: PageSizes.A4, text: 'Purchase order 4500000001, page 1 of 2' },
      { size: PageSizes.A4, text: 'Purchase order 4500000001, page 2 of 2' },
    )
  ).save()

const deliveryNote = async (): Promise<Uint8Array> =>
  (await letter({ size: PageSizes.Legal, text: 'Delivery note DN-0042' })).save()

/**
 * A protected file as pdf-lib meets one. pdf-lib cannot encrypt, and it never
 * decrypts either, so what it sees of a real one is all there is to make: a
 * trailer naming a security handler, and object streams that are ciphertext it
 * cannot inflate. Files that qpdf really encrypted -- RC4 at 40 and 128 bits,
 * AES at 128 and 256, with and without a password to open them -- were checked
 * against this module and are refused the same way.
 */
const encrypted = async (): Promise<Uint8Array> => {
  const document = await letter({ size: PageSizes.A4, text: 'Purchase order 4500000003' })
  const { context } = document
  const ciphertext = Uint8Array.from({ length: 64 }, (_, index) => (index * 151 + 7) % 256)
  context.register(context.stream(ciphertext, { Type: 'ObjStm', N: 1, First: 4, Filter: 'FlateDecode' }))
  context.trailerInfo.Encrypt = context.register(
    context.obj({ Filter: 'Standard', V: 5, R: 6, Length: 256, P: -3392 }),
  )
  return document.save()
}

/**
 * A letter whose font dictionary is damaged. pdf-lib loads it anyway, with no
 * more than a warning, and would copy its page, which would arrive without its
 * words.
 */
const damaged = async (): Promise<Uint8Array> => {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  document.addPage(PageSizes.A4).drawText('Purchase order 4500000002', { font, size: 12, x: 72, y: 770 })
  await document.flush()
  document.context.assign(font.ref, PDFInvalidObject.of(latin1('<< /Type /Font /Subtype /Type1 ) >>')))
  return document.save()
}

const notAPdf = latin1('Kestrel Environmental remittance advice, sent as text')

const load = (bytes: Uint8Array): Promise<PDFDocument> => PDFDocument.load(bytes, { updateMetadata: false })

/** Everything a page draws, decoded: two pages draw the same only if this is equal. */
const drawn = (page: PDFPage): string => {
  const contents = page.node.Contents()
  const parts = contents instanceof PDFArray ? contents.asArray() : [contents]
  return parts
    .map((part) => {
      const stream = page.doc.context.lookup(part)
      if (!(stream instanceof PDFRawStream)) throw new Error('a page draws from a stream')
      return new TextDecoder('latin1').decode(decodePDFRawStream(stream).decode())
    })
    .join('\n')
}

const size = (page: PDFPage): [number, number] => {
  const { width, height } = page.getSize()
  return [width, height]
}

/** Every page of each document, in the order given. */
const pagesOf = async (...documents: readonly Uint8Array[]): Promise<PDFPage[]> =>
  (await Promise.all(documents.map(load))).flatMap((document) => document.getPages())

describe('binding the supporting files in behind the invoice', () => {
  it('[money] puts every page of the invoice first, then each file in the order given', async () => {
    const [order, note] = [await purchaseOrder(), await deliveryNote()]
    const result = await appendPdfs(invoice, [
      { name: 'PO 4500000001.pdf', bytes: order },
      { name: 'Delivery note DN-0042.pdf', bytes: note },
    ])

    expect(result.appended).toEqual([0, 1])
    expect(result.skipped).toEqual([])
    const invoicePages = (await load(invoice)).getPageCount()
    expect(invoicePages).toBeGreaterThan(1)
    const merged = (await load(result.bytes)).getPages()
    expect(merged).toHaveLength(invoicePages + 2 + 1)
    // Each page draws exactly what its own page drew, so the invoice's are as
    // rendered and the rest are where they belong -- and no two pages draw the
    // same, so the comparison could not pass by accident.
    const expected = await pagesOf(invoice, order, note)
    expect(merged.map(drawn)).toEqual(expected.map(drawn))
    expect(new Set(merged.map(drawn)).size).toBe(merged.length)
    expect(merged.map(size)).toEqual([
      ...Array.from({ length: invoicePages }, () => PageSizes.Letter),
      PageSizes.A4,
      PageSizes.A4,
      PageSizes.Legal,
    ])
  })

  it('[unit] keeps the title the renderer gave the invoice', async () => {
    const result = await appendPdfs(invoice, [{ name: 'PO 4500000001.pdf', bytes: await purchaseOrder() }])
    expect((await load(result.bytes)).getTitle()).toBe('Invoice 1315')
  })

  it('[money] sends the invoice exactly as rendered when there is nothing to bind in', async () => {
    const alone = await appendPdfs(invoice, [])
    expect(alone).toEqual({ bytes: invoice, appended: [], skipped: [] })
    expect((await load(alone.bytes)).getPageCount()).toBe((await load(invoice)).getPageCount())

    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const refused = await appendPdfs(invoice, [{ name: 'Locked PO.pdf', bytes: await encrypted() }])
    expect(refused.bytes).toEqual(invoice)
    expect(refused.skipped).toEqual([{ index: 0, reason: 'encrypted' }])
  })

  it('[money] composes the same bytes from the same files, so a retried send matches the first', async () => {
    const candidates = [
      { name: 'PO 4500000001.pdf', bytes: await purchaseOrder() },
      { name: 'Delivery note DN-0042.pdf', bytes: await deliveryNote() },
    ]
    // A retry comes later. Only the clock is faked: pdf-lib's parser yields to
    // real timers as it goes.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-12T09:00:00Z'))
    const first = await appendPdfs(invoice, candidates)
    vi.setSystemTime(new Date('2026-10-12T09:05:00Z'))
    const second = await appendPdfs(invoice, candidates)
    expect(second.bytes).toEqual(first.bytes)
  })

  it('[unit] throws when the invoice itself cannot be read whole', async () => {
    const order = [{ name: 'PO 4500000001.pdf', bytes: await purchaseOrder() }]
    await expect(appendPdfs(notAPdf, order)).rejects.toThrow()
    // One of the renderer's font dictionaries, damaged. Read leniently, it
    // would be carried through, and the invoice sent set in a font that is
    // not there.
    const damagedInvoice = replaceOnce(invoice, '/BaseFont /Courier /Encoding', '/BaseFont ) Courier /Encoding')
    await expect(appendPdfs(damagedInvoice, order)).rejects.toThrow()
  })
})

describe('the files that are not bound in', () => {
  it('[unit] skips an encrypted file and one that is not a PDF, and still binds in the rest', async () => {
    // pdf-lib warns about the ciphertext it could not inflate.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const [order, note] = [await purchaseOrder(), await deliveryNote()]
    const result = await appendPdfs(invoice, [
      { name: 'Remittance advice.pdf', bytes: notAPdf },
      { name: 'PO 4500000001.pdf', bytes: order },
      { name: 'Locked PO.pdf', bytes: await encrypted() },
      { name: 'Delivery note DN-0042.pdf', bytes: note },
    ])

    expect(result.appended).toEqual([1, 3])
    expect(result.skipped).toEqual([
      { index: 0, reason: 'unreadable' },
      { index: 2, reason: 'encrypted' },
    ])
    const merged = (await load(result.bytes)).getPages()
    expect(merged.map(drawn)).toEqual((await pagesOf(invoice, order, note)).map(drawn))
  })

  it('[unit] refuses a file pdf-lib could read only in part, rather than send pages missing what they draw', async () => {
    // pdf-lib warns about the object it could not parse.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const broken = await damaged()
    // pdf-lib alone would take it: the refusal is this module's.
    expect((await load(broken)).getPageCount()).toBe(1)
    const order = await purchaseOrder()
    const truncated = order.slice(0, Math.floor(order.byteLength / 2))

    const result = await appendPdfs(invoice, [
      { name: 'Damaged PO.pdf', bytes: broken },
      { name: 'Half an upload.pdf', bytes: truncated },
    ])
    expect(result.skipped).toEqual([
      { index: 0, reason: 'unreadable' },
      { index: 1, reason: 'unreadable' },
    ])
    expect(result.bytes).toEqual(invoice)
  })

  it('[unit] reports a PDF with no pages as empty', async () => {
    const blank = await (await PDFDocument.create()).save({ addDefaultPage: false })
    const result = await appendPdfs(invoice, [
      { name: 'Cover sheet.pdf', bytes: blank },
      { name: 'PO 4500000001.pdf', bytes: await purchaseOrder() },
    ])
    expect(result.skipped).toEqual([{ index: 0, reason: 'empty' }])
    expect(result.appended).toEqual([1])
  })
})
