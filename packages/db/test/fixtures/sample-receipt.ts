import { readFile } from 'node:fs/promises'

/** The fixture file itself, for callers that need to copy it rather than read it. */
export const sampleReceiptPath = new URL('sample-receipt.pdf', import.meta.url)

/**
 * The receipt bytes the expense-attachment fixtures hash, store and copy into a
 * snapshot.
 *
 * `sample-receipt.pdf` is the smallest structurally valid PDF -- a header, one
 * empty catalog object and an EOF marker, 51 bytes with no content stream and
 * nothing to read. It stands in for a receipt binary so the attachment path can
 * be exercised end to end; it is not anybody's receipt, and the name says so.
 */
export const sampleReceiptBytes = async (): Promise<Buffer> => readFile(sampleReceiptPath)
