import { createInvoiceTimeRelease } from './time-release.js'
import type { GeneralResource, Invoice, Whoami } from '@conflict-hq/ezacto-client'
import { markMoney } from '../money-display.js'
import { leavePageNotice } from '../page-notice.js'
import {
  invoiceApiErrorCode,
  invoiceApiMessage,
  invoiceBlankLineDraft,
  invoiceCanEditLines,
  invoiceConflictCodes,
  invoiceDraft,
  invoiceDraftRebase,
  invoiceEditFocusFromHash,
  invoiceEditPlan,
  invoiceEditStepKey,
  invoiceIdentityCanRead,
  invoiceIdentityCanWrite,
  invoiceLineValues,
  invoicePagePath,
  invoiceReferenceFromPathname,
  invoiceReferencePath,
  type InvoiceDraft,
  type InvoiceHoursReview,
  type InvoiceEditStep,
  type InvoiceEditorApi,
  type InvoiceLineDraft,
  type InvoicePageReference,
} from './model.js'

const required = <ElementType extends Element>(selector: string): ElementType => {
  const element = document.querySelector<ElementType>(selector)
  if (element === null) throw new Error(`invoice editor element missing: ${selector}`)
  return element
}

const money = (cents: number, currency: string): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100)

type LineControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement

const lineControl = (row: HTMLElement, field: string): LineControl => {
  const control = row.querySelector<LineControl>(`[data-invoice-edit-line-field="${field}"]`)
  if (control === null) throw new Error(`invoice line field missing: ${field}`)
  return control
}

const lineCheck = (row: HTMLElement, field: 'taxed' | 'taxed2'): HTMLInputElement =>
  lineControl(row, field) as HTMLInputElement

/** The idempotency-key prefix each command has carried since the dialogs. */
const commandPrefix = (step: InvoiceEditStep): string => {
  switch (step.kind) {
    case 'header':
      return 'web.invoice.header'
    case 'rates':
      return 'web.invoice.financials'
    case 'line-create':
      return 'web.invoice.line.create'
    case 'line-update':
      return 'web.invoice.line.update'
    case 'line-delete':
      return 'web.invoice.line.delete'
  }
}

interface ActiveSession {
  readonly identity: Whoami
  readonly signal: AbortSignal
  readonly onSessionFailure: (error: unknown) => boolean
}

export interface InvoiceEditorController {
  activate(
    identity: Whoami,
    signal: AbortSignal,
    onSessionFailure: (error: unknown) => boolean,
  ): Promise<void>
}

/**
 * The invoice edit page (`/invoices/:number/edit`): the document and its lines,
 * saved together.
 *
 * The API takes one edit per command, so Save is a sequence -- the document,
 * the rates, then each removed, changed and new line -- sent one at a time on
 * rising versions. Each command holds its own key until it lands, so a retry
 * after a dropped connection replays what the server may already have taken
 * rather than applying it twice; and after each one the rest is planned again
 * against the invoice the server answered with, so a retry sends only what is
 * left. Changing a field drops the held key of the part it belongs to, as the
 * dialogs did: a different request is a different command.
 *
 * A version conflict reloads the invoice and carries the page's edits onto it
 * (`invoiceDraftRebase`), so nothing typed is lost and nothing untouched is
 * sent back over what somebody else just saved.
 */
export const createInvoiceEditorController = (
  api: Partial<InvoiceEditorApi>,
): InvoiceEditorController => {
  const isPage = document.documentElement.dataset.appView === 'invoice-edit'
  const page = required<HTMLElement>('[data-invoice-edit-page]')
  const title = required<HTMLElement>('[data-invoice-edit-title]')
  const back = required<HTMLAnchorElement>('[data-invoice-edit-back]')
  const status = required<HTMLElement>('[data-invoice-edit-status]')
  const retry = required<HTMLButtonElement>('[data-invoice-edit-retry]')
  const form = required<HTMLFormElement>('[data-invoice-edit-form]')
  const client = required<HTMLElement>('[data-invoice-edit-client]')
  const subject = required<HTMLInputElement>('[data-invoice-edit-subject]')
  const purchaseOrder = required<HTMLInputElement>('[data-invoice-edit-purchase-order]')
  const issueDate = required<HTMLInputElement>('[data-invoice-edit-issue-date]')
  const dueDate = required<HTMLInputElement>('[data-invoice-edit-due-date]')
  const paymentTerms = required<HTMLSelectElement>('[data-invoice-edit-payment-terms]')
  const tax = required<HTMLInputElement>('[data-invoice-edit-tax]')
  const tax2 = required<HTMLInputElement>('[data-invoice-edit-tax2]')
  const discount = required<HTMLInputElement>('[data-invoice-edit-discount]')
  const notes = required<HTMLTextAreaElement>('[data-invoice-edit-notes]')
  const lineList = required<HTMLElement>('[data-invoice-edit-line-list]')
  const lineTemplate = required<HTMLTemplateElement>('[data-invoice-edit-line-template]')
  const rateHeading = required<HTMLElement>('[data-invoice-edit-rate-heading]')
  const addLine = required<HTMLButtonElement>('[data-invoice-edit-add-line]')
  const subtotal = required<HTMLElement>('[data-invoice-edit-subtotal]')
  const cancel = required<HTMLAnchorElement>('[data-invoice-edit-cancel]')
  const result = required<HTMLElement>('[data-invoice-edit-result]')
  const hoursWarning = required<HTMLElement>('[data-invoice-edit-hours-warning]')
  const headerFields: readonly (HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)[] = [
    subject,
    purchaseOrder,
    issueDate,
    dueDate,
    paymentTerms,
    notes,
  ]
  const rateFields: readonly HTMLInputElement[] = [tax, tax2, discount]
  page.hidden = !isPage

  let active: ActiveSession | null = null
  /** The address the page was opened at; the invoice it names is read on load. */
  let reference: InvoicePageReference | null = null
  /** The invoice as the server last answered: what the page is planned against. */
  let invoice: Invoice | null = null
  let projects: readonly GeneralResource[] = []
  let hoursReview: InvoiceHoursReview | null = null
  let hoursFailed = false
  let pending = false
  /** Whether this visit has already saved something, so "nothing left" is a finish. */
  let committed = false
  let loadGeneration = 0
  let newRows = 0
  const commandIds = new Map<string, string>()

  const current = (): ActiveSession | null =>
    active === null || active.signal.aborted ? null : active

  const say = (message: string, outcome: 'error' | 'pending' | null): void => {
    result.textContent = message
    if (outcome === null) delete result.dataset.outcome
    else result.dataset.outcome = outcome
  }

  const rows = (): HTMLElement[] => [
    ...lineList.querySelectorAll<HTMLElement>('[data-invoice-edit-line]'),
  ]

  const readRow = (row: HTMLElement): InvoiceLineDraft => ({
    key: row.dataset.lineKey ?? '',
    lineId: row.dataset.lineId === undefined ? null : Number(row.dataset.lineId),
    kind: lineControl(row, 'kind').value,
    description: lineControl(row, 'description').value,
    quantity: lineControl(row, 'quantity').value,
    rate: lineControl(row, 'rate').value,
    taxed: lineCheck(row, 'taxed').checked,
    taxed2: lineCheck(row, 'taxed2').checked,
    projectId: lineControl(row, 'projectId').value,
    removed: row.hasAttribute('data-removed'),
  })

  const readDraft = (): InvoiceDraft => ({
    subject: subject.value,
    purchaseOrder: purchaseOrder.value,
    notes: notes.value,
    issueDate: issueDate.value,
    dueDate: dueDate.value,
    paymentTerms: paymentTerms.value,
    tax: tax.value,
    tax2: tax2.value,
    discount: discount.value,
    lines: rows().map(readRow),
  })

  /**
   * The client's projects, plus whatever a line already links to that the list
   * did not return: a select that cannot show its value falls back to its first
   * option, and the next save would quietly unlink the line.
   */
  const fillProjects = (select: HTMLSelectElement, selected: string): void => {
    const option = (label: string, value: string): HTMLOptionElement => {
      const item = document.createElement('option')
      item.value = value
      item.textContent = label
      return item
    }
    const items = [
      option('No project', ''),
      ...projects.map((project) => {
        const name =
          typeof project.name === 'string' && project.name.trim() !== ''
            ? project.name.trim()
            : `Project #${project.id}`
        return option(project.is_active === false ? `${name} (archived)` : name, String(project.id))
      }),
    ]
    if (selected !== '' && !items.some((item) => item.value === selected)) {
      items.push(option(`Project #${selected}`, selected))
    }
    select.replaceChildren(...items)
    select.value = selected
  }

  const release = createInvoiceTimeRelease(api, {
    context: () => {
      const session = current()
      return session ? { signal: session.signal, pending } : null
    },
    busy: (value) => { pending = value; syncPending() },
    reload: async () => {
      const session = current()
      if (session) await load(session)
    },
    saveForReview: () => save(true),
    error: invoiceApiMessage,
  })
  const syncPending = (): void => {
    for (const fieldset of form.querySelectorAll<HTMLFieldSetElement>('[data-invoice-time-release]'))
      fieldset.disabled = pending
    for (const control of form.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement
    >('input, select, textarea, button')) {
      if (control.closest('[data-invoice-time-release]')) continue
      const removedRow = control.closest('[data-removed]') !== null
      const keepsWorking = control.matches('[data-invoice-edit-line-restore]')
      control.disabled = pending || (removedRow && !keepsWorking)
    }
  }

  const syncRows = (): void => {
    const currency = invoice?.currency ?? 'USD'
    rows().forEach((row, index) => {
      // Numbered from 1, as the plan's messages number them: "Line 2: Enter an
      // item type." has to point at the row the reader counts as the second.
      const position = index + 1
      const legend = row.querySelector<HTMLElement>('[data-invoice-edit-line-position]')
      if (legend !== null) legend.textContent = `Line ${position}`
      const number = row.querySelector<HTMLElement>('[data-invoice-edit-line-number]')
      if (number !== null) number.textContent = String(position)
      const rateLabel = row.querySelector<HTMLElement>('[data-invoice-edit-line-rate-label]')
      if (rateLabel !== null) rateLabel.textContent = `Unit price (${currency})`
      const removed = row.hasAttribute('data-removed')
      row.querySelector<HTMLElement>('[data-invoice-edit-line-removed]')!.hidden = !removed
      row.querySelector<HTMLElement>('[data-invoice-edit-line-remove]')!.hidden = removed
    })
    rateHeading.textContent = `Unit price (${currency})`
    syncPending()
  }

  const syncHours = (): void => {
    hoursWarning.textContent = ''
    hoursWarning.hidden = true
    for (const row of rows()) {
      const hint = row.querySelector<HTMLElement>(
        '[data-invoice-edit-linked-hours]',
      )!
      hint.hidden = true
      hint.textContent = ''
    }
    if (!api.getInvoiceHoursReconciliation) return
    if (
      !hoursReview ||
      (invoice &&
        hoursReview.invoice_version !== null &&
        hoursReview.invoice_version !== invoice.version)
    ) {
      for (const row of rows()) release.sync(row, null, undefined, false, null)
      if (hoursFailed || hoursReview) {
        hoursWarning.hidden = false
        hoursWarning.textContent =
          'Linked hours could not be compared with this version. Reload the invoice to review them.'
      }
      return
    }
    if (hoursReview.entries.length === 0) {
      for (const row of rows()) release.sync(row, null, undefined, false, null)
      return
    }
    const byLine = new Map(
      hoursReview.lines.map((line) => [line.line_id, line]),
    )
    let dirty: boolean
    try { dirty = invoice !== null && invoiceEditPlan(invoice, readDraft()).length > 0 }
    catch { dirty = true }
    for (const row of rows()) {
      let billed: number | null
      try {
        billed = Math.round(invoiceLineValues(
          lineControl(row, 'quantity').value, lineControl(row, 'rate').value,
        ).quantity * 3600)
      } catch { billed = null }
      release.sync(row, hoursReview, byLine.get(Number(row.dataset.lineId)), dirty, billed)
    }
    let mismatches = 0,
      removedLinked = false,
      billedSeconds = 0,
      valid = true
    for (const row of rows()) {
      const source = byLine.get(Number(row.dataset.lineId))
      if (!source) continue
      if (row.hasAttribute('data-removed')) {
        if (source.linked_seconds !== 0) removedLinked = true
        continue
      }
      let billed: number
      try {
        billed = Math.round(
          invoiceLineValues(
            lineControl(row, 'quantity').value,
            lineControl(row, 'rate').value,
          ).quantity * 3600,
        )
      } catch {
        valid = false
        continue
      }
      billedSeconds += billed
      if (
        Math.abs(billed - source.linked_seconds) <=
        hoursReview.tolerance_seconds
      )
        continue
      mismatches++
      const hint = row.querySelector<HTMLElement>(
        '[data-invoice-edit-linked-hours]',
      )!
      hint.textContent = `Linked: ${(source.linked_seconds / 3600).toFixed(2)} h · billed: ${(billed / 3600).toFixed(2)} h. Changing quantity does not release linked time.`
      hint.hidden = false
    }
    const messages: string[] = []
    if (mismatches && valid)
      messages.push(
        `Hours report and invoice quantities differ. Linked: ${(hoursReview.linked_seconds / 3600).toFixed(2)} h · compared lines bill: ${(billedSeconds / 3600).toFixed(2)} h. Review linked time before previewing or sending.`,
      )
    if (removedLinked)
      messages.push(
        'Removed lines still have time linked to this invoice. Removing a line does not release its entries.',
      )
    if (!hoursReview.comparison_complete)
      messages.push(
        'Some linked time cannot be compared with a billed hours quantity. Review the hours report; fee and expense quantities are not treated as hours.',
      )
    hoursWarning.textContent = messages.join(' ')
    hoursWarning.hidden = messages.length === 0
  }

  /**
   * Each line's amount as it will be saved, in exact cents, and the lines'
   * total. A line that does not parse yet shows a dash and the total waits for
   * it, rather than adding up the lines that happen to.
   */
  const syncAmounts = (): void => {
    const currency = invoice?.currency ?? 'USD'
    let sum = 0
    let complete = true
    let counted = 0
    for (const row of rows()) {
      const amount = row.querySelector<HTMLElement>('[data-invoice-edit-line-amount]')!
      let cents: number | null
      try {
        cents = invoiceLineValues(
          lineControl(row, 'quantity').value,
          lineControl(row, 'rate').value,
        ).amountCents
      } catch {
        cents = null
      }
      amount.textContent = cents === null ? '—' : money(cents, currency)
      markMoney(amount, cents !== null)
      if (row.hasAttribute('data-removed')) continue
      counted += 1
      if (cents === null) complete = false
      else sum += cents
    }
    const known = complete && counted > 0
    subtotal.textContent = known ? money(sum, currency) : counted === 0 ? money(0, currency) : '—'
    markMoney(subtotal, known || counted === 0)
    syncHours()
  }

  const setRemoved = (row: HTMLElement, removed: boolean): void => {
    if (removed) row.setAttribute('data-removed', '')
    else row.removeAttribute('data-removed')
    syncRows()
    syncAmounts()
  }

  const renderRow = (draft: InvoiceLineDraft): HTMLElement => {
    const source = lineTemplate.content.firstElementChild
    if (source === null) throw new Error('invoice line template is empty')
    const row = source.cloneNode(true) as HTMLElement
    row.dataset.lineKey = draft.key
    if (draft.lineId !== null) {
      row.dataset.lineId = String(draft.lineId)
      row.id = `invoice-line-${draft.lineId}`
    }
    if (draft.removed) row.setAttribute('data-removed', '')
    lineControl(row, 'kind').value = draft.kind
    lineControl(row, 'description').value = draft.description
    lineControl(row, 'quantity').value = draft.quantity
    lineControl(row, 'rate').value = draft.rate
    lineCheck(row, 'taxed').checked = draft.taxed
    lineCheck(row, 'taxed2').checked = draft.taxed2
    fillProjects(lineControl(row, 'projectId') as HTMLSelectElement, draft.projectId)
    row.querySelector<HTMLButtonElement>('[data-invoice-edit-line-remove]')!.addEventListener(
      'click',
      () => {
        if (pending) return
        if (row.dataset.lineId === undefined) {
          // Never saved, so nothing to undo: it simply goes.
          const following = row.nextElementSibling
          row.remove()
          syncRows()
          syncAmounts()
          const landing =
            following?.querySelector<HTMLElement>('[data-invoice-edit-line-field="kind"]') ??
            addLine
          landing.focus()
          return
        }
        // A saved line is marked rather than dropped: removing it is the
        // irreversible half of the save, and until then it can be kept.
        setRemoved(row, true)
        row.querySelector<HTMLButtonElement>('[data-invoice-edit-line-restore]')!.focus()
      },
    )
    row.querySelector<HTMLButtonElement>('[data-invoice-edit-line-restore]')!.addEventListener(
      'click',
      () => {
        if (pending) return
        setRemoved(row, false)
        commandIds.delete(`line:${draft.key}`)
        row.querySelector<HTMLButtonElement>('[data-invoice-edit-line-remove]')!.focus()
      },
    )
    return row
  }

  const renderDraft = (draft: InvoiceDraft): void => {
    subject.value = draft.subject
    purchaseOrder.value = draft.purchaseOrder
    notes.value = draft.notes
    issueDate.value = draft.issueDate
    dueDate.value = draft.dueDate
    paymentTerms.value = draft.paymentTerms
    tax.value = draft.tax
    tax2.value = draft.tax2
    discount.value = draft.discount
    lineList.replaceChildren(...draft.lines.map(renderRow))
    syncRows()
    syncAmounts()
  }

  const appendBlankLine = (): HTMLElement => {
    newRows += 1
    const row = renderRow(invoiceBlankLineDraft(`new-${newRows}`))
    lineList.append(row)
    syncRows()
    syncAmounts()
    return row
  }

  const clearPrivatePresentation = (): void => {
    loadGeneration += 1
    invoice = null
    hoursReview = null
    hoursFailed = false
    hoursWarning.textContent = ''
    hoursWarning.hidden = true
    projects = []
    pending = false
    committed = false
    commandIds.clear()
    form.hidden = true
    form.reset()
    lineList.replaceChildren()
    client.textContent = '—'
    subtotal.textContent = '—'
    retry.hidden = true
    say('', null)
    status.textContent = 'Loading invoice…'
    // The number goes with the invoice; the page's own name stays.
    document.title = document.title.replace(/(\s—\sEdit invoice)\s.+$/u, '$1')
    syncPending()
  }

  /** The document is closed, or became so: say so, and offer nothing to type into. */
  const showClosed = (): void => {
    form.hidden = true
    status.textContent =
      'A closed invoice can no longer be edited. Reopen it from the invoice page to change it.'
  }

  const collectProjects = async (session: ActiveSession, clientId: number): Promise<void> => {
    const list = api.listInvoiceClientProjects
    if (list === undefined) return
    const loaded: GeneralResource[] = []
    let cursor: string | undefined
    do {
      const response = await list(clientId, cursor, session.signal)
      loaded.push(...response.data)
      cursor = response.page.next_cursor ?? undefined
    } while (cursor !== undefined)
    if (current() === session) projects = loaded
  }

  const focusFromHash = (): void => {
    const focus = invoiceEditFocusFromHash(globalThis.location.hash)
    if (focus === null) return
    const row =
      focus === 'new-line'
        ? appendBlankLine()
        : rows().find((candidate) => candidate.dataset.lineId === String(focus.line))
    if (row === undefined) return
    const target = lineControl(row, 'description')
    target.focus()
    row.scrollIntoView?.({ block: 'center' })
  }

  const load = async (session: ActiveSession): Promise<void> => {
    const opened = reference
    const getInvoice = api.getInvoice
    if (opened === null || getInvoice === undefined) return
    const generation = ++loadGeneration
    form.hidden = true
    retry.hidden = true
    status.textContent = 'Loading invoice…'
    try {
      // The address names the invoice until it has loaded; after that the page
      // is that invoice, and reading it again goes by id.
      const id =
        invoice?.id ??
        (opened.kind === 'id'
          ? opened.id
          : ((await api.findInvoiceByNumber!(opened.number, session.signal))?.id ?? null))
      if (current() !== session || generation !== loadGeneration) return
      if (id === null) {
        status.textContent = 'That invoice does not exist.'
        return
      }
      const loaded = await getInvoice(id, session.signal)
      if (current() !== session || generation !== loadGeneration) return
      // The name and the projects are niceties: a failure to read either still
      // leaves an invoice that can be edited, with an id where the name was.
      const [named, , hours] = await Promise.all([
        api.getDirectoryClient === undefined
          ? Promise.resolve(null)
          : api.getDirectoryClient(loaded.client_id, session.signal).catch(() => null),
        collectProjects(session, loaded.client_id).catch(() => undefined),
        api.getInvoiceHoursReconciliation?.(loaded.id, session.signal).catch(() => null) ?? Promise.resolve(null),
      ])
      if (current() !== session || generation !== loadGeneration) return
      invoice = loaded
      hoursReview = hours
      hoursFailed = Boolean(api.getInvoiceHoursReconciliation && !hours)
      // Opened by id, the page lands on the number, as the detail page does,
      // and the way back leads to the invoice's own address.
      const canonical = invoicePagePath(loaded, 'edit')
      if (globalThis.location.pathname !== canonical) {
        globalThis.history.replaceState(
          globalThis.history.state,
          '',
          `${canonical}${globalThis.location.search}${globalThis.location.hash}`,
        )
      }
      back.href = invoicePagePath(loaded)
      cancel.href = invoicePagePath(loaded)
      client.textContent =
        named !== null && typeof named.name === 'string' && named.name.trim() !== ''
          ? named.name.trim()
          : `Client #${loaded.client_id}`
      title.textContent = `Edit invoice ${loaded.number}`
      document.title = document.title.replace(
        /\s—\sEdit invoice.*$/u,
        ` — Edit invoice ${loaded.number}`,
      )
      if (!invoiceCanEditLines(loaded)) {
        showClosed()
        return
      }
      renderDraft(invoiceDraft(loaded))
      status.textContent = ''
      form.hidden = false
      focusFromHash()
    } catch (error) {
      if (current() !== session || generation !== loadGeneration) return
      if (session.onSessionFailure(error)) return
      status.textContent = invoiceApiMessage(error)
      retry.hidden = false
    }
  }

  const send = (
    step: InvoiceEditStep,
    on: Invoice,
    commandId: string,
    signal: AbortSignal,
  ): Promise<Invoice> => {
    switch (step.kind) {
      case 'header':
      case 'rates':
        return api.updateInvoice!(
          on.id,
          commandId,
          { expected_version: on.version, ...step.edit },
          signal,
        )
      case 'line-delete':
        return api.deleteInvoiceLine!(
          on.id,
          step.line.id,
          commandId,
          { expected_version: on.version, expected_updated_at: step.line.updated_at },
          signal,
        )
      case 'line-update':
        return api.updateInvoiceLine!(
          on.id,
          step.line.id,
          commandId,
          {
            expected_version: on.version,
            expected_updated_at: step.line.updated_at,
            position: step.line.position,
            ...step.edit,
          },
          signal,
        )
      case 'line-create': {
        const { project_id: projectId, ...line } = step.edit
        return api.createInvoiceLine!(
          on.id,
          commandId,
          {
            expected_version: on.version,
            position: step.position,
            ...line,
            ...(projectId === null ? {} : { project_id: projectId }),
          },
          signal,
        )
      }
    }
  }

  /**
   * After a create lands, the row learns which line it became, so the next
   * plan sees a saved line rather than one still to create. The new line is the
   * one the answer has that the invoice before it did not.
   */
  const adoptCreated = (key: string, position: number, before: Invoice, after: Invoice): void => {
    const known = new Set(before.line_items.map((line) => line.id))
    const fresh = after.line_items.filter((line) => !known.has(line.id))
    const created =
      fresh.find((line) => line.position === position) ??
      (fresh.length === 1 ? fresh[0] : undefined)
    const row = rows().find((candidate) => candidate.dataset.lineKey === key)
    if (created === undefined || row === undefined) return
    row.dataset.lineId = String(created.id)
    row.id = `invoice-line-${created.id}`
  }

  const finish = (saved: Invoice): void => {
    leavePageNotice(invoicePagePath(saved), 'Invoice saved.')
    say('Invoice saved. Opening it…', 'pending')
    globalThis.location.assign(invoicePagePath(saved))
  }

  const reloadAfterConflict = async (session: ActiveSession, before: Invoice): Promise<void> => {
    try {
      const latest = await api.getInvoice!(before.id, session.signal)
      if (current() !== session) return
      const draft = invoiceDraftRebase(readDraft(), before, latest)
      invoice = latest
      hoursReview = await api.getInvoiceHoursReconciliation?.(latest.id, session.signal).catch(() => null) ?? null
      if (current() !== session) return
      hoursFailed = Boolean(api.getInvoiceHoursReconciliation && !hoursReview)
      if (!invoiceCanEditLines(latest)) {
        showClosed()
        return
      }
      renderDraft(draft)
      say(
        'The invoice changed elsewhere. Latest values are loaded with your changes kept; review and save again.',
        'error',
      )
    } catch (error) {
      if (current() !== session) return
      if (session.onSessionFailure(error)) return
      say(
        'The invoice changed elsewhere and the latest values could not be loaded. Retry the invoice.',
        'error',
      )
      retry.hidden = false
    }
  }

  const save = async (stayForHours = false): Promise<void> => {
    const session = current()
    const start = invoice
    if (
      session === null ||
      start === null ||
      pending ||
      !invoiceIdentityCanWrite(session.identity) ||
      !invoiceCanEditLines(start) ||
      api.updateInvoice === undefined ||
      api.createInvoiceLine === undefined ||
      api.updateInvoiceLine === undefined ||
      api.deleteInvoiceLine === undefined
    ) {
      return
    }
    const complete = async () => {
      if (stayForHours) {
        await load(session)
        say('Invoice saved. Choose linked time to release explicitly.', null)
      } else finish(start)
    }
    let steps: readonly InvoiceEditStep[]
    try {
      steps = invoiceEditPlan(start, readDraft())
    } catch (error) {
      // Checked before anything is sent, so a bad line costs nothing.
      say(invoiceApiMessage(error), 'error')
      return
    }
    if (steps.length === 0) {
      if (committed || stayForHours) await complete()
      else say('Nothing changed.', null)
      return
    }
    pending = true
    syncPending()
    say('Saving invoice…', 'pending')
    try {
      while (steps.length > 0) {
        const step = steps[0]!
        const before = invoice!
        const key = invoiceEditStepKey(step)
        let commandId = commandIds.get(key)
        if (commandId === undefined) {
          commandId = `${commandPrefix(step)}:${globalThis.crypto.randomUUID()}`
          commandIds.set(key, commandId)
        }
        const after = await send(step, before, commandId, session.signal)
        if (current() !== session) return
        // Landed: its key is spent, and from here the page is planned against
        // what the server holds now, not what it held when the page opened.
        commandIds.delete(key)
        invoice = after
        committed = true
        if (step.kind === 'line-create') adoptCreated(step.key, step.position, before, after)
        if (step.kind === 'line-delete') {
          rows()
            .find((row) => row.dataset.lineKey === step.key)
            ?.remove()
          syncRows()
        }
        steps = invoiceEditPlan(after, readDraft())
      }
      await complete()
    } catch (error) {
      if (current() !== session) return
      if (session.onSessionFailure(error)) return
      const code = invoiceApiErrorCode(error)
      if (code !== null && invoiceConflictCodes.has(code)) {
        // A different version is a different request, so every held key goes.
        commandIds.clear()
        await reloadAfterConflict(session, invoice!)
        return
      }
      // Anything else keeps its key: the step may have landed and its answer
      // been lost, and saving again has to replay it, not repeat it.
      say(
        committed
          ? `${invoiceApiMessage(error)} What saved before this stays saved; save again to send the rest.`
          : invoiceApiMessage(error),
        'error',
      )
    } finally {
      if (current() === session) {
        pending = false
        syncPending()
      }
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void save()
  })
  form.addEventListener('input', (event) => {
    if (pending) return
    say('', null)
    const target = event.target
    if (!(target instanceof Element)) return
    if ((headerFields as readonly Element[]).includes(target)) commandIds.delete('header')
    if ((rateFields as readonly Element[]).includes(target)) commandIds.delete('rates')
    const row = target.closest<HTMLElement>('[data-invoice-edit-line]')
    if (row !== null) {
      commandIds.delete(`line:${row.dataset.lineKey ?? ''}`)
      syncAmounts()
    }
  })
  addLine.addEventListener('click', () => {
    if (pending) return
    lineControl(appendBlankLine(), 'kind').focus()
  })
  retry.addEventListener('click', () => {
    const session = current()
    if (session === null) return
    say('', null)
    void load(session)
  })

  return {
    async activate(identity, signal, onSessionFailure) {
      if (!isPage) return
      const session: ActiveSession = { identity, signal, onSessionFailure }
      active = session
      clearPrivatePresentation()
      reference = invoiceReferenceFromPathname(globalThis.location.pathname, 'edit')
      signal.addEventListener(
        'abort',
        () => {
          if (active !== session) return
          active = null
          clearPrivatePresentation()
          status.textContent = 'Sign in to edit this invoice.'
        },
        { once: true },
      )
      if (reference === null) {
        status.textContent = 'That invoice does not exist.'
        return
      }
      // Back to the page this one was opened from, until the invoice has
      // loaded and its own address replaces it.
      back.href = invoiceReferencePath(reference)
      cancel.href = invoiceReferencePath(reference)
      if (!invoiceIdentityCanRead(identity)) {
        status.textContent =
          identity.authentication.kind === 'token'
            ? 'This API token does not grant invoice read access.'
            : 'Your profile does not have access to invoices.'
        return
      }
      if (!invoiceIdentityCanWrite(identity)) {
        status.textContent =
          'You have read-only invoice access. Editing an invoice requires the invoices:write scope.'
        return
      }
      if (
        api.getInvoice === undefined ||
        (reference.kind === 'number' && api.findInvoiceByNumber === undefined) ||
        api.updateInvoice === undefined ||
        api.createInvoiceLine === undefined ||
        api.updateInvoiceLine === undefined ||
        api.deleteInvoiceLine === undefined
      ) {
        status.textContent = 'Invoice editing is unavailable in this build.'
        return
      }
      await load(session)
    },
  }
}
