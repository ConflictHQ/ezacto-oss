import {
  EncryptedPDFError,
  PDFDocument,
  PDFInvalidObject,
  StandardFonts,
  degrees,
  rgb,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib'

/**
 * The files that support an invoice, bound in behind it.
 *
 * Some accounts-payable departments book an invoice only when it arrives as
 * one document: the invoice on the first page, and whatever supports it -- a
 * purchase-order letter, most often -- behind it. To them a second attachment
 * is a second document to match, and an invoice that arrives without its
 * purchase order goes back.
 *
 * The binding is pdf-lib's, and it lives in the entry rather than in
 * `@ezacto/core`. The core renderer writes its own PDF so that it can stay
 * small (see its `pdf.ts`), but reading somebody else's PDF is a different
 * job: those files come from every generator there is, and parsing all of
 * them is exactly the general-purpose work a library is for. pdf-lib is plain
 * JavaScript, so it runs on a Worker as it does under Node.
 *
 * A file that cannot be bound in is reported, never thrown. The caller sends
 * it as an attachment of its own instead, so a purchase order is not lost
 * because it would not merge, and an invoice is not held back by a file
 * somebody else made.
 */

export interface AppendCandidate {
  /**
   * What the file is called. Nothing here reads it: the result names files by
   * their index, and the name travels with the bytes so a caller reporting a
   * skip has it to hand.
   */
  readonly name: string
  readonly bytes: Uint8Array
}

/**
 * Why a file was not bound in.
 *
 * - `encrypted`: it is protected, even if only against editing. pdf-lib cannot
 *   decrypt, so its pages could only be copied as ciphertext.
 * - `unreadable`: it is not a PDF, or not one pdf-lib can read whole.
 * - `empty`: it is a PDF with no pages, so there is nothing to bind in.
 */
export type AppendSkipReason = 'encrypted' | 'unreadable' | 'empty'

export interface AppendResult {
  /** The invoice pages followed by every appended file's pages, in order. */
  readonly bytes: Uint8Array
  /** Indices (into the candidates) whose pages were appended. */
  readonly appended: readonly number[]
  /** Candidates that could not be appended, and why. */
  readonly skipped: readonly { readonly index: number; readonly reason: AppendSkipReason }[]
}

/**
 * pdf-lib is compiled to ES5, where a subclass of Error does not keep its
 * prototype: what it throws for an encrypted file is a plain Error, and
 * `instanceof EncryptedPDFError` is never true. The message is what survives,
 * and taking it from the class rather than copying its text keeps the two in
 * step.
 */
const encryptedMessage = new EncryptedPDFError().message

/** A file's pages, copied into `target` but not yet placed, or why there are none. */
const copyPagesOf = async (
  target: PDFDocument,
  bytes: Uint8Array,
): Promise<PDFPage[] | AppendSkipReason> => {
  let source: PDFDocument
  try {
    // Encryption is honoured, and the parse is lenient. Honoured, because
    // pdf-lib copies a protected file's pages without decrypting them, and they
    // would arrive as pages that draw nothing in place of the purchase order.
    // Lenient, because a strict parse fails on an encrypted file's object
    // streams -- ciphertext too -- before it reaches the trailer that says the
    // file is encrypted, and a protected file would be reported as a damaged one.
    source = await PDFDocument.load(bytes, { updateMetadata: false })
  } catch (error) {
    return error instanceof Error && error.message === encryptedMessage ? 'encrypted' : 'unreadable'
  }
  try {
    // What the lenient parse could not read it kept as raw bytes, to be written
    // back out as they are. A page that refers to one could be missing what it
    // draws, and a page that is quietly incomplete is worse than a file sent on
    // its own, where the client's reader can make of it what it can.
    if (
      source.context
        .enumerateIndirectObjects()
        .some(([, object]) => object instanceof PDFInvalidObject)
    ) {
      return 'unreadable'
    }
    if (source.getPageCount() === 0) return 'empty'
    // A copy that fails part way leaves what it had already copied in the
    // output, unreferenced: that costs bytes, never a page, because nothing is
    // placed until every page of the file has been copied.
    return await target.copyPages(source, source.getPageIndices())
  } catch {
    return 'unreadable'
  }
}

/**
 * Stamps a page the way the invoice renderer stamps its own: the word large,
 * on the diagonal, centred, in a pale red that leaves what is under it
 * legible. Sized to the page, so a long word or a small page still fits.
 */
const stampPage = (page: PDFPage, text: string, font: PDFFont): void => {
  const { width, height } = page.getSize()
  const angle = Math.atan2(height, width)
  const span = Math.hypot(width, height) - 2 * 39
  const size = Math.min(120, span / Math.max(1, font.widthOfTextAtSize(text, 1)))
  const run = font.widthOfTextAtSize(text, size)
  const rise = font.heightAtSize(size, { descender: false }) * 0.72
  page.drawText(text, {
    x: width / 2 - (run / 2) * Math.cos(angle) + (rise / 2) * Math.sin(angle),
    y: height / 2 - (run / 2) * Math.sin(angle) - (rise / 2) * Math.cos(angle),
    size,
    font,
    rotate: degrees((angle * 180) / Math.PI),
    color: rgb(0.75, 0.12, 0.12),
    opacity: 0.15,
  })
}

export interface AppendOptions {
  /**
   * Draws this word across every appended page, as the preview stamps the
   * invoice's own pages: a preview's purchase order is no more the real thing
   * than its invoice is.
   */
  readonly stamp?: string
}

/**
 * The invoice's pages, then every page of each candidate in the order given.
 *
 * A file costs three to four times its size in memory while it is bound in:
 * the caller's bytes, the copy pdf-lib parses, the copy it binds in, and the
 * document it writes, with the first of pdf-lib's copies garbage before the
 * last is made. A purchase-order letter is nothing against a Worker's 128 MB.
 * A file near the 25 MB attachment limit needs most of it, and is better sent
 * on its own.
 */
export const appendPdfs = async (
  document: Uint8Array,
  candidates: readonly AppendCandidate[],
  options: AppendOptions = {},
): Promise<AppendResult> => {
  // The invoice is read strictly, and a failure to read it is the caller's to
  // handle. It is ezacto's own rendering, so a part pdf-lib cannot read is a
  // defect to surface rather than a document to send. Its metadata is left as
  // the renderer wrote it: the title is what a reader shows, and pdf-lib's own
  // producer and dates would make one invoice compose to different bytes on
  // every attempt.
  const merged = await PDFDocument.load(document, {
    throwOnInvalidObject: true,
    updateMetadata: false,
  })
  const appended: number[] = []
  const skipped: { index: number; reason: AppendSkipReason }[] = []
  const stamp = options.stamp?.trim() ?? ''
  let font: PDFFont | null = null
  for (const [index, candidate] of candidates.entries()) {
    const pages = await copyPagesOf(merged, candidate.bytes)
    if (typeof pages === 'string') {
      skipped.push({ index, reason: pages })
      continue
    }
    if (stamp !== '' && font === null) font = await merged.embedFont(StandardFonts.HelveticaBold)
    for (const page of pages) {
      merged.addPage(page)
      if (font !== null) stampPage(page, stamp, font)
    }
    appended.push(index)
  }
  // Nothing bound in, nothing rewritten: the invoice goes exactly as it was
  // rendered, which is what lets a stored copy be compared with a re-render.
  if (appended.length === 0) return { bytes: document, appended, skipped }
  return { bytes: await merged.save(), appended, skipped }
}
