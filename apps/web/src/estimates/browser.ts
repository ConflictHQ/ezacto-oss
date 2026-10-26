import { createEstimateComposer, type EstimateComposerApi } from './composer.js'
import { renderDataTable } from '../components/data-table.js'
import { loadedRowsSortNotice } from '../components/table-sort.js'
import { moneyText } from '../money-display.js'
import { EzactoApiError, type Estimate, type GeneralResource } from '@conflict-hq/ezacto-client'
import {
  estimateCanConvert,
  estimateConversionMessage,
  estimateConversionOutcome,
  estimateDueDate,
  estimateExpiryEditable,
  estimateExpiryMessage,
  estimateExpiryText,
  estimateIdentityCanWrite,
  estimateMoney,
  estimateResponseSummary,
  estimateResponseText,
  estimateStateLabel,
  type EstimateConversionRequest,
  type EstimateWorkspaceApi,
} from './model.js'
import type { Whoami } from '@conflict-hq/ezacto-client'
import { setRequestBusy } from '../request-feedback.js'

/**
 * The estimates workspace: what was quoted, what happened to it, and the one
 * button that turns an accepted quote into an invoice (issue 485).
 *
 * The list is what the screen was missing -- seven API paths served and nothing
 * calling them. The button is what makes it a screen rather than a report.
 */

const required = <ElementType extends Element>(selector: string): ElementType => {
  const item = document.querySelector<ElementType>(selector)
  if (item === null) throw new Error(`estimates element missing: ${selector}`)
  return item
}

const messageFor = (error: unknown): string => {
  if (error instanceof EzactoApiError && typeof error.body === 'object' && error.body !== null) {
    const detail = Reflect.get(error.body, 'error')
    if (typeof detail === 'object' && detail !== null) {
      const message = Reflect.get(detail, 'message')
      if (typeof message === 'string' && message.trim() !== '') return message
    }
  }
  return error instanceof Error ? error.message : 'Something went wrong.'
}

export interface EstimateWorkspaceController {
  activate(
    identity: Whoami,
    signal: AbortSignal,
    onSessionFailure: (error: unknown) => boolean,
  ): Promise<void>
}

export const createEstimateWorkspaceController = (
  api: Partial<EstimateWorkspaceApi & EstimateComposerApi>,
): EstimateWorkspaceController => {
  const composer = createEstimateComposer(api)
  const isPage = document.documentElement.dataset.appView === 'invoice-estimates'
  const page = required<HTMLElement>('[data-invoice-estimates-page]')
  const listView = required<HTMLElement>('[data-estimate-list-view]')
  const listStatus = required<HTMLElement>('[data-estimate-list-status]')
  const list = required<HTMLElement>('[data-estimate-list]')
  const search = required<HTMLInputElement>('[data-estimate-search]')
  const loadMore = required<HTMLButtonElement>('[data-estimate-load-more]')
  const listRetry = required<HTMLButtonElement>('[data-estimate-list-retry]')
  const detailView = required<HTMLElement>('[data-estimate-detail-view]')
  const detailStatus = required<HTMLElement>('[data-estimate-detail-status]')
  const detailRetry = required<HTMLButtonElement>('[data-estimate-detail-retry]')
  const detailBody = required<HTMLElement>('[data-estimate-detail-body]')
  const lines = required<HTMLElement>('[data-estimate-lines]')
  const convertSection = required<HTMLElement>('[data-estimate-convert-section]')
  const convert = required<HTMLButtonElement>('[data-estimate-convert]')
  const convertForm = required<HTMLFormElement>('[data-estimate-convert-form]')
  const convertNumber = required<HTMLInputElement>('[data-estimate-convert-number]')
  const convertIssued = required<HTMLInputElement>('[data-estimate-convert-issued]')
  const convertDue = required<HTMLInputElement>('[data-estimate-convert-due]')
  const convertTerms = required<HTMLSelectElement>('[data-estimate-convert-terms]')
  const convertResult = required<HTMLElement>('[data-estimate-convert-result]')
  const expiryForm = required<HTMLFormElement>('[data-estimate-expiry-form]')
  const expiryDate = required<HTMLInputElement>('[data-estimate-expiry-date]')
  const expiryClear = required<HTMLButtonElement>('[data-estimate-expiry-clear]')
  const expirySave = required<HTMLButtonElement>('[data-estimate-expiry-save]')
  const expiryResult = required<HTMLElement>('[data-estimate-expiry-result]')

  const text = (selector: string, value: string): void => {
    required<HTMLElement>(selector).textContent = value
  }

  let loaded: Estimate[] = []
  let cursor: string | null = null
  let clients = new Map<number, string>()
  let writable = false
  let converting = false
  let savingExpiry = false
  let shown: Estimate | null = null
  let activeSignal: AbortSignal | null = null
  let detailGeneration = 0
  let listGeneration = 0
  let listPending = false
  const currentSession = (signal: AbortSignal) => activeSignal === signal && !signal.aborted

  const clientName = (estimate: Estimate): string =>
    clients.get(estimate.client_id) ?? `Client #${String(estimate.client_id)}`

  /**
   * A local filter over what has been loaded, like the recurring pane's. The
   * API has no estimate search, and a box that silently searched one page while
   * looking like it searched the book would be worse than one that says so.
   */
  const matching = (): Estimate[] => {
    const query = search.value.trim().toLowerCase()
    if (query === '') return loaded
    return loaded.filter((estimate) =>
      [estimate.number, estimate.subject ?? '', clientName(estimate)]
        .join(' ')
        .toLowerCase()
        .includes(query),
    )
  }

  const renderList = (): void => {
    const rows = matching()
    list.replaceChildren(
      renderDataTable<Estimate>({
        caption: 'Estimates',
        table: 'estimates',
        defaultSort: { column: 'number', direction: 'ascending' },
        rows,
        rowKey: (estimate) => String(estimate.id),
        empty:
          loaded.length === 0
            ? 'No estimates yet.'
            : 'No estimates match that search.',
        columns: [
          {
            key: 'number',
            fit: true,
            label: 'Number',
            sortValue: (estimate) => estimate.number,
            render: (estimate) => {
              const link = document.createElement('a')
              link.href = `/invoices/estimates?estimate=${String(estimate.id)}`
              link.dataset.estimateOpen = String(estimate.id)
              link.textContent = estimate.number
              return link
            },
          },
          {
            key: 'client',
            label: 'Client',
            render: (estimate) => clientName(estimate),
            sortValue: (estimate) => clientName(estimate),
          },
          {
            key: 'subject',
            label: 'Subject',
            render: (estimate) => estimate.subject ?? '—',
            sortValue: (estimate) => estimate.subject?.trim() || null,
          },
          {
            key: 'state',
            fit: true,
            label: 'Status',
            render: (estimate) => estimateStateLabel(estimate.state),
            sortValue: (estimate) => estimateStateLabel(estimate.state),
          },
          {
            key: 'issued',
            label: 'Issued',
            fit: true,
            render: (estimate) => estimate.issue_date ?? '—',
            sortValue: (estimate) => estimate.issue_date,
          },
          {
            key: 'amount',
            label: 'Total',
            numeric: true,
            sortValue: (estimate) => [estimate.currency, estimate.amount_cents],
            render: (estimate) =>
              moneyText(estimateMoney(estimate.amount_cents, estimate.currency)),
          },
        ],
      }),
    )
  }

  const showList = (): void => {
    detailGeneration++
    shown = null
    savingExpiry = false
    converting = false
    for (const region of [detailStatus, expiryResult, convertResult]) setRequestBusy(region, false)
    listView.hidden = false
    detailView.hidden = true
  }

  const renderDetail = (estimate: Estimate): void => {
    text('[data-estimate-detail-client]', clientName(estimate))
    text('[data-estimate-detail-title]', `Estimate ${estimate.number}`)
    text('[data-estimate-client]', clientName(estimate))
    text('[data-estimate-number]', estimate.number)
    text('[data-estimate-state]', estimateStateLabel(estimate.state))
    text('[data-estimate-issued]', estimate.issue_date ?? '—')
    text('[data-estimate-amount]', estimateMoney(estimate.amount_cents, estimate.currency))
    shown = estimate
    text('[data-estimate-expiry]', estimateExpiryText(estimate))
    expiryForm.hidden = !(
      writable &&
      api.setEstimateExpiry !== undefined &&
      estimateExpiryEditable(estimate)
    )
    expiryDate.value = estimate.expires_on ?? ''
    expiryClear.hidden = estimate.expires_on === null
    const purchaseOrderRow = required<HTMLElement>('[data-estimate-purchase-order-row]')
    const purchaseOrder = estimate.purchase_order ?? ''
    purchaseOrderRow.hidden = purchaseOrder.trim() === ''
    text('[data-estimate-purchase-order]', purchaseOrder)

    lines.replaceChildren(
      renderDataTable<Estimate['line_items'][number]>({
        caption: `Lines on estimate ${estimate.number}`,
        rows: estimate.line_items,
        rowKey: (line) => String(line.id),
        empty: 'This estimate quotes no lines.',
        columns: [
          { key: 'kind', label: 'Kind', render: (line) => line.kind },
          {
            key: 'description',
            label: 'Description',
            render: (line) => line.description ?? '—',
          },
          {
            key: 'quantity',
            label: 'Quantity',
            numeric: true,
            render: (line) => String(line.quantity),
          },
          {
            key: 'unit',
            label: 'Unit price',
            numeric: true,
            render: (line) =>
              moneyText(estimateMoney(line.unit_price_cents, estimate.currency)),
          },
          {
            key: 'amount',
            label: 'Amount',
            numeric: true,
            render: (line) => moneyText(estimateMoney(line.amount_cents, estimate.currency)),
          },
        ],
      }),
    )

    // Offered only where it can work. The API decides; this stops the button
    // being present on a draft somebody then has to be told about.
    const convertible = estimateCanConvert(estimate) && api.convertEstimate !== undefined
    convertSection.hidden = !estimateCanConvert(estimate)
    convert.hidden = !(convertible && writable)
    convert.disabled = converting
    convert.dataset.estimateId = String(estimate.id)
    convertForm.dataset.estimateVersion = String(estimate.version)
    // Filled in rather than blank: the issue date is today and the due date is
    // what the chosen terms imply, so the common case is one click after
    // choosing a number.
    if (convertIssued.value === '') {
      convertIssued.value = new Date().toISOString().slice(0, 10)
    }
    if (convertDue.value === '') {
      convertDue.value = estimateDueDate(convertIssued.value, convertTerms.value)
    }
    if (estimateCanConvert(estimate) && api.convertEstimate === undefined) {
      convertResult.textContent = estimateConversionMessage({ kind: 'unavailable' })
    }
    detailBody.hidden = false
    detailStatus.textContent = ''
  }

  /**
   * The answer on file, loaded beside the estimate. Its failure is a line of
   * text rather than a failed screen: the quote itself is what was asked for.
   */
  const showResponse = async (estimate: Estimate, signal: AbortSignal): Promise<void> => {
    const own = detailGeneration
    const target = required<HTMLElement>('[data-estimate-response]')
    if (estimate.state !== 'accepted' && estimate.state !== 'declined') {
      target.textContent = estimateResponseText(null)
      return
    }
    if (api.listEstimateMessages === undefined) {
      target.textContent = 'This deployment does not serve estimate correspondence.'
      return
    }
    target.textContent = 'Loading response…'
    try {
      const messages = await api.listEstimateMessages(estimate.id, signal)
      if (!currentSession(signal) || own !== detailGeneration || shown?.id !== estimate.id) return
      target.textContent = estimateResponseText(estimateResponseSummary(estimate.state, messages))
    } catch {
      if (!currentSession(signal) || own !== detailGeneration || shown?.id !== estimate.id) return
      target.textContent = 'The response on file could not be loaded.'
    }
  }

  const openDetail = async (id: number, signal: AbortSignal): Promise<void> => {
    if (!currentSession(signal)) return
    const own = ++detailGeneration
    const current = () => currentSession(signal) && own === detailGeneration
    shown = null
    savingExpiry = false
    converting = false
    expiryDate.disabled = false
    expirySave.disabled = false
    expiryClear.disabled = false
    convert.disabled = false
    setRequestBusy(expiryResult, false)
    setRequestBusy(convertResult, false)
    listView.hidden = true
    detailView.hidden = false
    detailBody.hidden = true
    detailRetry.hidden = true
    convertResult.textContent = ''
    expiryResult.textContent = ''
    detailStatus.textContent = 'Loading estimate…'
    setRequestBusy(detailStatus, true)
    if (api.getEstimate === undefined) {
      detailStatus.textContent = 'This deployment does not serve estimates.'
      setRequestBusy(detailStatus, false)
      return
    }
    try {
      const estimate = await api.getEstimate(id, signal)
      if (!current()) return
      renderDetail(estimate)
      void showResponse(estimate, signal)
    } catch (error) {
      if (!current()) return
      detailStatus.textContent = messageFor(error)
      detailRetry.hidden = false
      detailRetry.dataset.estimateId = String(id)
    } finally {
      if (current()) setRequestBusy(detailStatus, false)
    }
  }

  const loadPage = async (signal: AbortSignal, append: boolean): Promise<void> => {
    if (!currentSession(signal) || (append && listPending)) return
    if (api.listEstimates === undefined) {
      listStatus.textContent = 'This deployment does not serve estimates.'
      return
    }
    listStatus.textContent = append ? 'Loading more estimates…' : 'Loading estimates…'
    const own = ++listGeneration
    const current = () => currentSession(signal) && own === listGeneration
    listPending = true
    loadMore.disabled = true
    listRetry.disabled = true
    setRequestBusy(listStatus, true)
    listRetry.hidden = true
    try {
      const page_ = await api.listEstimates(append ? (cursor ?? undefined) : undefined, signal)
      if (!current()) return
      loaded = append ? [...loaded, ...page_.data] : [...page_.data]
      cursor = page_.page.next_cursor
      loadMore.hidden = cursor === null
      listStatus.textContent =
        loaded.length === 0
          ? 'No estimates yet.'
          : `${String(loaded.length)} loaded.${cursor === null ? '' : loadedRowsSortNotice}`
      renderList()
    } catch (error) {
      if (!current()) return
      listStatus.textContent = messageFor(error)
      listRetry.hidden = false
    } finally {
      if (current()) {
        listPending = false
        loadMore.disabled = false
        listRetry.disabled = false
        setRequestBusy(listStatus, false)
      }
    }
  }

  const loadClients = async (signal: AbortSignal): Promise<void> => {
    if (api.listEstimateClients === undefined) return
    try {
      const page_ = await api.listEstimateClients(undefined, signal)
      if (!currentSession(signal)) return
      clients = new Map<number, string>(
        page_.data.map((client: GeneralResource) => [
          client.id,
          typeof client.name === 'string' ? client.name : '',
        ]),
      )
      renderList()
    } catch {
      // A missing client name is a row reading "Client #14", not a failed
      // screen. The estimates themselves are what this page is for.
    }
  }

  const estimateIdFrom = (value: string | undefined): number | null => {
    const id = Number(value ?? '')
    return Number.isSafeInteger(id) && id > 0 ? id : null
  }

  return {
    async activate(identity, signal, onSessionFailure) {
      if (!isPage || signal.aborted) return
      activeSignal = signal
      detailGeneration++
      listGeneration++
      listPending = false
      loaded = []
      cursor = null
      clients.clear()
      shown = null
      savingExpiry = false
      converting = false
      signal.addEventListener('abort', () => {
        if (activeSignal !== signal) return
        activeSignal = null
        detailGeneration++
        listGeneration++
        listPending = false
        shown = null
        loaded = []
        clients.clear()
        page.hidden = true
        list.replaceChildren()
        detailBody.hidden = true
        for (const status of [listStatus, detailStatus, expiryResult, convertResult]) {
          status.textContent = ''
          setRequestBusy(status, false)
        }
      }, { once: true })
      page.hidden = false
      writable = estimateIdentityCanWrite(identity)
      void composer.activate(identity, signal, onSessionFailure)

      search.addEventListener('input', renderList)
      loadMore.addEventListener('click', () => void loadPage(signal, true))
      listRetry.addEventListener('click', () => void loadPage(signal, false))
      detailRetry.addEventListener('click', () => {
        const id = estimateIdFrom(detailRetry.dataset.estimateId)
        if (id !== null) void openDetail(id, signal)
      })
      list.addEventListener('click', (event) => {
        const anchor = (event.target as HTMLElement | null)?.closest<HTMLAnchorElement>(
          '[data-estimate-open]',
        )
        if (anchor === null || anchor === undefined) return
        const id = estimateIdFrom(anchor.dataset.estimateOpen)
        if (id === null) return
        event.preventDefault()
        window.history.pushState({}, '', anchor.href)
        void openDetail(id, signal)
      })
      required<HTMLAnchorElement>('[data-estimate-back]').addEventListener('click', (event) => {
        event.preventDefault()
        window.history.pushState({}, '', '/invoices/estimates')
        showList()
      })

      // The due date follows the terms until somebody says otherwise. Choosing
      // `custom` is saying the default is wrong, so it stops being recomputed.
      const syncDue = (): void => {
        if (convertTerms.value === 'custom') return
        convertDue.value = estimateDueDate(convertIssued.value, convertTerms.value)
      }
      const saveExpiry = (expiresOn: string | null): void => {
        if (!currentSession(signal)) return
        const current = shown
        if (current === null || savingExpiry || api.setEstimateExpiry === undefined) return
        if (expiresOn === '') {
          expiryResult.textContent = 'Choose a day, or use the default.'
          return
        }
        savingExpiry = true
        const own = detailGeneration
        const isCurrent = () => currentSession(signal) && own === detailGeneration && shown?.id === current.id
        expirySave.disabled = true
        expiryClear.disabled = true
        expiryDate.disabled = true
        expiryResult.textContent = 'Saving…'
        setRequestBusy(expiryResult, true)
        void api
          .setEstimateExpiry(
            current.id,
            { expected_version: current.version, expires_on: expiresOn },
            signal,
          )
          .then((updated) => {
            if (!isCurrent()) return
            renderDetail(updated)
            expiryResult.textContent =
              expiresOn === null ? 'Expiry cleared.' : 'Expiry saved.'
          })
          .catch((error: unknown) => {
            if (!isCurrent()) return
            if (onSessionFailure(error)) return
            expiryResult.textContent = estimateExpiryMessage(error)
          })
          .finally(() => {
            if (!isCurrent()) return
            savingExpiry = false
            expirySave.disabled = false
            expiryClear.disabled = false
            expiryDate.disabled = false
            setRequestBusy(expiryResult, false)
          })
      }
      expiryForm.addEventListener('submit', (event) => {
        event.preventDefault()
        saveExpiry(expiryDate.value)
      })
      expiryClear.addEventListener('click', () => saveExpiry(null))

      convertTerms.addEventListener('change', syncDue)
      convertIssued.addEventListener('change', syncDue)

      convertForm.addEventListener('submit', (event) => {
        event.preventDefault()
        if (!currentSession(signal)) return
        const id = estimateIdFrom(convert.dataset.estimateId)
        const version = Number(convertForm.dataset.estimateVersion ?? '')
        if (id === null || converting || api.convertEstimate === undefined) return
        if (!Number.isSafeInteger(version)) return
        if (convertNumber.value.trim() === '') {
          convertResult.textContent = 'An invoice needs a number.'
          return
        }
        // Confirmed: this raises a document that goes to a client, and a button
        // that does so without asking is one somebody presses by accident.
        if (!window.confirm('Raise an invoice for what this estimate quoted?')) return
        converting = true
        const own = detailGeneration
        const isCurrent = () => currentSession(signal) && own === detailGeneration && shown?.id === id
        convert.disabled = true
        convertResult.textContent = 'Converting…'
        setRequestBusy(convertResult, true)
        void api
          .convertEstimate(
            id,
            {
              expected_version: version,
              number: convertNumber.value.trim(),
              issue_date: convertIssued.value,
              due_date: convertDue.value,
              payment_terms: convertTerms.value as EstimateConversionRequest['payment_terms'],
            },
            `estimate-convert-${String(id)}-${convertNumber.value.trim()}`,
            signal,
          )
          .then((result) => {
            if (!isCurrent()) return
            convertResult.textContent = estimateConversionMessage({
              kind: 'converted',
              invoiceId: result.invoice.id,
            })
            void openDetail(id, signal)
          })
          .catch((error: unknown) => {
            if (!isCurrent()) return
            if (onSessionFailure(error)) return
            convertResult.textContent = estimateConversionMessage(
              estimateConversionOutcome(error),
            )
          })
          .finally(() => {
            if (!isCurrent()) return
            converting = false
            convert.disabled = false
            setRequestBusy(convertResult, false)
          })
      })

      await Promise.all([loadPage(signal, false), loadClients(signal)])
      if (!currentSession(signal)) return
      const opening = estimateIdFrom(
        new URL(window.location.href).searchParams.get('estimate') ?? undefined,
      )
      if (opening !== null) await openDetail(opening, signal)
      else showList()
    },
  }
}
