import { readFileSync } from 'node:fs'
import type { InvoiceEditInput } from './money.js'
type EditFlag =
  | 'subject'
  | 'notes-file'
  | 'issue-date'
  | 'due-date'
  | 'terms'
  | 'line'
  | 'quantity'
  | 'rate'
  | 'description'
export const invoiceEditInput = (
  number: string,
  values: Partial<Record<EditFlag, string | undefined>>,
): InvoiceEditInput => {
  let line: number | undefined
  if (values.line !== undefined) {
    line = Number(values.line)
    if (!/^[1-9]\d*$/.test(values.line) || !Number.isSafeInteger(line))
      throw new Error(`invalid --line: ${values.line}; use 1 for the first line`)
  }
  return {
    number,
    ...(values.subject === undefined ? {} : { subject: values.subject }),
    ...(values['notes-file'] === undefined
      ? {}
      : { notes: readFileSync(values['notes-file'], 'utf8') }),
    ...(values['issue-date'] === undefined ? {} : { issueDate: values['issue-date'] }),
    ...(values['due-date'] === undefined ? {} : { dueDate: values['due-date'] }),
    ...(values.terms === undefined ? {} : { terms: values.terms }),
    ...(line === undefined ? {} : { line }),
    ...(values.quantity === undefined ? {} : { quantity: values.quantity }),
    ...(values.rate === undefined ? {} : { rate: values.rate }),
    ...(values.description === undefined ? {} : { description: values.description }),
  }
}
export const invoiceTimeSelection = (raw: string | undefined): number[] => {
  if (raw === undefined) throw new Error('ez invoice unlink-time requires --entries')
  const ids = raw.split(',').map((part) => {
    const value = Number(part.trim())
    if (!/^[1-9]\d*$/.test(part.trim()) || !Number.isSafeInteger(value))
      throw new Error(`invalid time entry id: ${part}`)
    return value
  })
  if (ids.length < 1 || ids.length > 1000) throw new Error('Choose 1–1000 time entry IDs.')
  return [...new Set(ids)]
}
