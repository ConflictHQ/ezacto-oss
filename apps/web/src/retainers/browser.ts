import { renderDataTable, type CellContent } from '../components/data-table.js'
import { markMoney, moneyText } from '../money-display.js'
import {
  EzactoApiError,
  type GeneralResource,
  type Invoice,
  type Retainer,
  type RetainerDrawdownInput,
  type RetainerInput,
  type RetainerLedgerEntry,
  type RetainerLedgerInput,
  type Whoami,
} from '@ezacto/client'
// Retainers are served under the invoice scopes -- `requireWrite` on
// `/api/v1/retainers` asks for `invoices:write` -- so the screen asks the same
// question of the identity that the invoice screen does rather than inventing a
// second answer to it.
import { invoiceIdentityCanWrite } from '../invoices/model.js'
import {
  retainerAmount,
  retainerAmountFromForm,
  retainerClientCurrency,
  retainerCreateInput,
  retainerInvoiceLabel,
  retainerLedgerKindIsSigned,
  retainerLedgerKindNeedsInvoice,
  retainerLedgerKindNeedsNotes,
  retainerLedgerRequestAmount,
  retainerLinkedInvoices,
  retainerPolicyPatch,
  retainerProjectedBalance,
  retainerWouldOverdraw,
  type RetainerLedgerDirection,
  type RetainerLedgerFormKind,
  retainerBalanceLabel,
  retainerBasisLabel,
  retainerClientLabel,
  retainerCommitment,
  retainerCommitmentLabel,
  retainerCurrency,
  retainerDenominationUnit,
  retainerExhaustionLabel,
  retainerLedgerHistory,
  retainerLedgerKindLabel,
  retainerLedgerNotes,
  retainerLedgerSummary,
  retainerLockedRateValueCents,
  retainerMatchesFilter,
  retainerMoney,
  retainerProjectLabel,
  retainerRemainingShare,
  retainerRemainingShareLabel,
  retainerRolloverLabel,
  retainerScopeConflict,
  retainerSelectionFromUrl,
  retainerStateLabel,
  retainerStatusFilterFromUrl,
  retainerWorkspaceUrl,
  type RetainerMovement,
  type RetainerStatusFilter,
  type RetainerWorkspaceApi,
} from './model.js'

const required = <ElementType extends Element>(selector: string): ElementType => {
  const item = document.querySelector<ElementType>(selector)
  if (item === null) throw new Error(`retainer element missing: ${selector}`)
  return item
}

const messageFor = (error: unknown): string => {
  if (error instanceof EzactoApiError && typeof error.body === 'object' && error.body !== null) {
    const detail = Reflect.get(error.body, 'error')
    if (typeof detail === 'object' && detail !== null) {
      // The field message before the envelope's. A 422 always carries at least
      // one field error and its envelope message is the fixed "The request
      // contains invalid fields." -- which was a fair summary while this screen
      // only read, and is useless to someone who has just typed an amount the
      // ledger refused.
      const fields = Reflect.get(detail, 'fields')
      if (Array.isArray(fields)) {
        const first = fields.find(
          (field: unknown) =>
            typeof field === 'object' &&
            field !== null &&
            typeof Reflect.get(field, 'message') === 'string',
        )
        if (first !== undefined) return String(Reflect.get(first, 'message'))
      }
      const message = Reflect.get(detail, 'message')
      if (typeof message === 'string' && message.trim() !== '') return message
    }
    if (error.status === 401) return 'Your session ended. Sign in again to continue.'
    if (error.status === 403) return 'You do not have access to retainers.'
    if (error.status === 404) return 'That retainer no longer exists.'
  }
  return error instanceof Error ? error.message : 'The retainer request could not be completed.'
}

const apiErrorCode = (error: unknown): string | null => {
  if (!(error instanceof EzactoApiError) || typeof error.body !== 'object' || error.body === null) {
    return null
  }
  const detail = Reflect.get(error.body, 'error')
  if (typeof detail !== 'object' || detail === null) return null
  const code = Reflect.get(detail, 'code')
  return typeof code === 'string' ? code : null
}

/**
 * Today where the operator is. A movement's `occurred_on` is a calendar date
 * the person is asserting, so it comes from their clock rather than from UTC:
 * west of Greenwich after 5pm, `toISOString().slice(0, 10)` is tomorrow.
 */
const localDate = (): string => {
  const now = new Date()
  return new Date(now.valueOf() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10)
}

const text = (selector: string, value: string): void => {
  required<HTMLElement>(selector).textContent = value
}

/**
 * A retainer is denominated in money or in hours, and the same column, fact and
 * ledger row carries whichever this one is. So the money marker follows the
 * denomination of the row rather than the heading above it -- marking the column
 * would mask an hours retainer's ledger, which is not money and not the reader's
 * to lose.
 */
const denominated = (value: string, isMoney: boolean): CellContent =>
  isMoney ? moneyText(value) : value

const denominatedText = (selector: string, value: string, isMoney: boolean): void => {
  const element = required<HTMLElement>(selector)
  element.textContent = value
  markMoney(element, isMoney)
}

const factRow = (selector: string, visible: boolean): void => {
  required<HTMLElement>(selector).hidden = !visible
}

interface ActiveSession {
  readonly identity: Whoami
  readonly signal: AbortSignal
  readonly onSessionFailure: (error: unknown) => boolean
}

export interface RetainerWorkspaceController {
  activate(
    identity: Whoami,
    signal: AbortSignal,
    onSessionFailure: (error: unknown) => boolean,
  ): Promise<void>
}

export const createRetainerWorkspaceController = (
  api: Partial<RetainerWorkspaceApi>,
): RetainerWorkspaceController => {
  const isPage = document.documentElement.dataset.appView === 'invoice-retainers'
  const page = required<HTMLElement>('[data-invoice-retainers-page]')
  const listView = required<HTMLElement>('[data-retainer-list-view]')
  const listStatus = required<HTMLElement>('[data-retainer-list-status]')
  const list = required<HTMLElement>('[data-retainer-list]')
  const loadMore = required<HTMLButtonElement>('[data-retainer-load-more]')
  const listRetry = required<HTMLButtonElement>('[data-retainer-list-retry]')
  const detailView = required<HTMLElement>('[data-retainer-detail-view]')
  const detailStatus = required<HTMLElement>('[data-retainer-detail-status]')
  const detailRetry = required<HTMLButtonElement>('[data-retainer-detail-retry]')
  const detailBody = required<HTMLElement>('[data-retainer-detail-body]')
  const detailBack = required<HTMLAnchorElement>('[data-retainer-back]')
  const notes = required<HTMLElement>('[data-retainer-notes]')
  const ledger = required<HTMLElement>('[data-retainer-ledger]')
  const filterButtons = [
    ...document.querySelectorAll<HTMLButtonElement>('[data-retainer-filter]'),
  ]
  const createTrigger = required<HTMLButtonElement>('[data-retainer-create]')
  const writeActions = required<HTMLElement>('[data-retainer-write-actions]')
  const writeStatus = required<HTMLElement>('[data-retainer-write-status]')
  const drawdownTrigger = required<HTMLButtonElement>('[data-retainer-drawdown]')
  const movementTrigger = required<HTMLButtonElement>('[data-retainer-movement]')
  // `-edit`, because the policy facts list is already `data-retainer-policy`.
  // Two elements under one hook resolve by document order, which is a working
  // selector today and a silent swap the first time either moves.
  const policyTrigger = required<HTMLButtonElement>('[data-retainer-policy-edit]')
  const createDialog = required<HTMLDialogElement>('[data-retainer-create-dialog]')
  const createForm = required<HTMLFormElement>('[data-retainer-create-form]')
  const createClient = required<HTMLSelectElement>('[data-retainer-create-client]')
  const createProject = required<HTMLSelectElement>('[data-retainer-create-project]')
  const createBasis = required<HTMLSelectElement>('[data-retainer-create-basis]')
  const createAmount = required<HTMLInputElement>('[data-retainer-create-amount]')
  const createAmountLabel = required<HTMLElement>('[data-retainer-create-amount-label]')
  const createRate = required<HTMLInputElement>('[data-retainer-create-rate]')
  const createRateRow = required<HTMLElement>('[data-retainer-create-rate-row]')
  const createRateLabel = required<HTMLElement>('[data-retainer-create-rate-label]')
  const createPeriod = required<HTMLInputElement>('[data-retainer-create-period]')
  const createRollover = required<HTMLSelectElement>('[data-retainer-create-rollover]')
  const createExpires = required<HTMLInputElement>('[data-retainer-create-expires]')
  const createExhaustion = required<HTMLSelectElement>('[data-retainer-create-exhaustion]')
  const createResult = required<HTMLElement>('[data-retainer-create-result]')
  const createSubmit = required<HTMLButtonElement>('[data-retainer-create-submit]')
  const drawdownDialog = required<HTMLDialogElement>('[data-retainer-drawdown-dialog]')
  const drawdownForm = required<HTMLFormElement>('[data-retainer-drawdown-form]')
  const drawdownInvoice = required<HTMLSelectElement>('[data-retainer-drawdown-invoice]')
  const drawdownAmount = required<HTMLInputElement>('[data-retainer-drawdown-amount]')
  const drawdownAmountLabel = required<HTMLElement>('[data-retainer-drawdown-amount-label]')
  const drawdownDate = required<HTMLInputElement>('[data-retainer-drawdown-date]')
  const drawdownNotes = required<HTMLTextAreaElement>('[data-retainer-drawdown-notes]')
  const drawdownProjection = required<HTMLElement>('[data-retainer-drawdown-projection]')
  const drawdownResult = required<HTMLElement>('[data-retainer-drawdown-result]')
  const drawdownSubmit = required<HTMLButtonElement>('[data-retainer-drawdown-submit]')
  const movementDialog = required<HTMLDialogElement>('[data-retainer-movement-dialog]')
  const movementForm = required<HTMLFormElement>('[data-retainer-movement-form]')
  const movementKind = required<HTMLSelectElement>('[data-retainer-movement-kind]')
  const movementInvoice = required<HTMLSelectElement>('[data-retainer-movement-invoice]')
  const movementInvoiceLabel = required<HTMLElement>('[data-retainer-movement-invoice-label]')
  const movementDirection = required<HTMLSelectElement>('[data-retainer-movement-direction]')
  const movementDirectionLabel = required<HTMLElement>('[data-retainer-movement-direction-label]')
  const movementAmount = required<HTMLInputElement>('[data-retainer-movement-amount]')
  const movementAmountLabel = required<HTMLElement>('[data-retainer-movement-amount-label]')
  const movementDate = required<HTMLInputElement>('[data-retainer-movement-date]')
  const movementNotes = required<HTMLTextAreaElement>('[data-retainer-movement-notes]')
  const movementNotesLabel = required<HTMLElement>('[data-retainer-movement-notes-label]')
  const movementProjection = required<HTMLElement>('[data-retainer-movement-projection]')
  const movementHint = required<HTMLElement>('[data-retainer-movement-hint]')
  const movementResult = required<HTMLElement>('[data-retainer-movement-result]')
  const movementSubmit = required<HTMLButtonElement>('[data-retainer-movement-submit]')
  const policyDialog = required<HTMLDialogElement>('[data-retainer-policy-dialog]')
  const policyForm = required<HTMLFormElement>('[data-retainer-policy-form]')
  const policyState = required<HTMLSelectElement>('[data-retainer-policy-state]')
  const policyPeriod = required<HTMLInputElement>('[data-retainer-policy-period]')
  const policyRollover = required<HTMLSelectElement>('[data-retainer-policy-rollover]')
  const policyExpires = required<HTMLInputElement>('[data-retainer-policy-expires]')
  const policyExhaustion = required<HTMLSelectElement>('[data-retainer-policy-exhaustion]')
  const policyResult = required<HTMLElement>('[data-retainer-policy-result]')
  const policySubmit = required<HTMLButtonElement>('[data-retainer-policy-submit]')
  page.hidden = !isPage

  let activeSession: ActiveSession | null = null
  let filter: RetainerStatusFilter = 'ongoing'
  let selection: number | null = null
  let retainers: readonly Retainer[] = []
  let clients: readonly GeneralResource[] = []
  let projects: readonly GeneralResource[] = []
  let nextCursor: string | null = null
  let listGeneration = 0
  let detailGeneration = 0
  let listPending = false
  let catalog: Promise<void> | null = null
  /** The retainer the open detail is showing, so a dialog can read its balance. */
  let selected: Retainer | null = null
  let invoices: readonly Invoice[] = []
  let invoiceCatalog: Promise<void> | null = null
  let mutationPending = false
  /**
   * One command id per dialog, held from the first submit until that command is
   * known to have committed. A network failure leaves the outcome unknown, and
   * a fresh key on the retry would be a second command: a second retainer, or a
   * second drawdown against the same invoice. The server dedupes on the key --
   * `resource_create_commands` for the create, a ledger-entry id digested from
   * the key for the two movements -- so a retry under the same key replays
   * rather than repeats.
   */
  let createCommandId: string | null = null
  let drawdownCommandId: string | null = null
  let movementCommandId: string | null = null

  const current = (): ActiveSession | null =>
    activeSession === null || activeSession.signal.aborted ? null : activeSession

  const collect = async <Resource>(
    load: (
      cursor?: string,
      signal?: AbortSignal,
    ) => Promise<{
      readonly data: readonly Resource[]
      readonly page: { readonly next_cursor: string | null }
    }>,
    signal: AbortSignal,
  ): Promise<Resource[]> => {
    const resources: Resource[] = []
    let cursor: string | undefined
    do {
      signal.throwIfAborted()
      const response = await load(cursor, signal)
      resources.push(...response.data)
      cursor = response.page.next_cursor ?? undefined
    } while (cursor !== undefined)
    return resources
  }

  /**
   * Client and project names, loaded once per session and awaited by both
   * screens. The detail needs them as much as the list does — the client is
   * where a retainer's currency comes from — and a deep link straight to
   * `?retainer=2` has no list load to piggyback on, so sharing one promise is
   * what stops the detail painting "Client #5" and USD before the names land.
   * A failure clears the promise so the next retry actually retries.
   */
  const loadCatalog = (session: ActiveSession): Promise<void> => {
    catalog ??= (async () => {
      const [loadedClients, loadedProjects] = await Promise.all([
        api.listRetainerClients === undefined
          ? Promise.resolve<GeneralResource[]>([])
          : collect(api.listRetainerClients, session.signal),
        api.listRetainerProjects === undefined
          ? Promise.resolve<GeneralResource[]>([])
          : collect(api.listRetainerProjects, session.signal),
      ])
      if (current() !== session) return
      clients = loadedClients
      projects = loadedProjects
    })().catch((error: unknown) => {
      catalog = null
      throw error
    })
    return catalog
  }

  /**
   * The invoices, loaded the first time a dialog needs to name one and kept for
   * the session. Separate from `loadCatalog` because only two of the four
   * dialogs ask for it and neither is the common case: a deposit and a drawdown
   * must name an invoice `retainer_ledger_invoice_client_guard` will accept,
   * and an adjustment -- the movement the cutover actually needs -- must not
   * name one at all. Paying for a full invoice sweep on every visit to a
   * read-only page would be paying for the rarer half.
   */
  const loadInvoices = (session: ActiveSession): Promise<void> => {
    invoiceCatalog ??= (async () => {
      const loaded =
        api.listRetainerInvoices === undefined
          ? []
          : await collect(api.listRetainerInvoices, session.signal)
      if (current() !== session) return
      invoices = loaded
    })().catch((error: unknown) => {
      invoiceCatalog = null
      throw error
    })
    return invoiceCatalog
  }

  const canWrite = (): boolean => {
    const session = current()
    return session !== null && invoiceIdentityCanWrite(session.identity)
  }

  const syncWriteControls = (): void => {
    const writable = canWrite()
    createTrigger.hidden = !writable
    createTrigger.disabled = !writable || mutationPending || api.createRetainer === undefined
    writeActions.hidden = !writable || selected === null
    const busy = !writable || selected === null || mutationPending
    drawdownTrigger.disabled = busy || api.drawDownRetainer === undefined
    movementTrigger.disabled = busy || api.appendRetainerLedger === undefined
    policyTrigger.disabled = busy || api.updateRetainer === undefined
    createSubmit.disabled = mutationPending
    // An empty invoice list is the drawdown dialog's own stop condition, and it
    // outlives a submit: re-enabling on the way out of a failed write would
    // offer a button that has nothing to name.
    drawdownSubmit.disabled = mutationPending || drawdownInvoice.options.length === 0
    movementSubmit.disabled = mutationPending
    policySubmit.disabled = mutationPending
  }

  const syncFilters = (): void => {
    for (const button of filterButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.retainerFilter === filter))
    }
  }

  const syncPending = (): void => {
    loadMore.disabled = listPending
    listRetry.disabled = listPending
  }

  const syncView = (): void => {
    listView.hidden = selection !== null
    detailView.hidden = selection === null
    detailBack.href = retainerWorkspaceUrl(filter)
    // Leaving a detail leaves the retainer its dialogs were about, so the write
    // actions have nothing to act on until the next one is loaded.
    if (selection === null) selected = null
    syncWriteControls()
  }

  const clearPrivatePresentation = (): void => {
    listGeneration += 1
    detailGeneration += 1
    retainers = []
    clients = []
    projects = []
    nextCursor = null
    listPending = false
    catalog = null
    selected = null
    invoices = []
    invoiceCatalog = null
    mutationPending = false
    createCommandId = null
    drawdownCommandId = null
    movementCommandId = null
    list.replaceChildren()
    list.removeAttribute('aria-busy')
    ledger.replaceChildren()
    notes.replaceChildren()
    notes.hidden = true
    detailBody.hidden = true
    listStatus.textContent = 'Loading retainers…'
    detailStatus.textContent = 'Loading retainer…'
    writeStatus.textContent = ''
    loadMore.hidden = true
    listRetry.hidden = true
    detailRetry.hidden = true
    // A dialog left open across a sign-out would keep a client list and an
    // invoice number on screen after the shell has been told to forget them.
    for (const dialog of [createDialog, drawdownDialog, movementDialog, policyDialog]) {
      if (dialog.open) dialog.close()
    }
    createForm.reset()
    drawdownForm.reset()
    movementForm.reset()
    policyForm.reset()
    createClient.replaceChildren()
    createProject.replaceChildren()
    drawdownInvoice.replaceChildren()
    movementInvoice.replaceChildren()
    createResult.textContent = ''
    drawdownResult.textContent = ''
    movementResult.textContent = ''
    policyResult.textContent = ''
    syncPending()
    syncWriteControls()
  }

  const visible = (): readonly Retainer[] =>
    retainers
      .filter((retainer) => retainerMatchesFilter(retainer, filter))
      // The band groups by client, and `renderDataTable` groups a run rather
      // than reordering, so a row order that disagreed with the grouping would
      // repeat the band per row. Sorting by the same label it groups by is what
      // makes one band one client.
      .slice()
      .sort((left, right) => {
        const byClient = retainerClientLabel(left, clients).localeCompare(
          retainerClientLabel(right, clients),
          'en-US',
        )
        return byClient === 0 ? left.id - right.id : byClient
      })

  const openDetail = (id: number): void => {
    globalThis.history.pushState(null, '', retainerWorkspaceUrl(filter, id))
    selection = id
    selected = null
    writeStatus.textContent = ''
    syncView()
    void loadDetail()
  }

  const renderList = (): void => {
    const rows = visible()
    if (rows.length === 0) {
      list.replaceChildren()
      listStatus.textContent =
        filter === 'ongoing'
          ? 'No ongoing retainers. Choose All to include closed ones.'
          : 'No retainers have been created or imported yet.'
      return
    }
    list.replaceChildren(
      renderDataTable<Retainer>({
        caption: 'Retainers',
        rows,
        rowKey: (retainer) => String(retainer.id),
        groupBy: (retainer) => retainerClientLabel(retainer, clients),
        columns: [
          {
            key: 'project',
            label: 'Scope',
            render: (retainer) => retainerProjectLabel(retainer, projects),
          },
          { key: 'basis', label: 'Basis', render: retainerBasisLabel },
          {
            key: 'commitment',
            label: 'On retainer',
            numeric: true,
            render: (retainer) =>
              denominated(
                retainerCommitmentLabel(retainer, retainerCurrency(retainer, clients)),
                // "Not recorded" is not an amount, whatever the denomination.
                retainerDenominationUnit(retainer) === 'cents' &&
                  retainerCommitment(retainer) !== null,
              ),
          },
          {
            key: 'balance',
            label: 'Remaining',
            numeric: true,
            render: (retainer) =>
              denominated(
                retainerBalanceLabel(retainer, retainerCurrency(retainer, clients)),
                retainerDenominationUnit(retainer) === 'cents',
              ),
          },
          {
            key: 'share',
            label: 'Remaining share',
            numeric: true,
            render: retainerRemainingShareLabel,
          },
          {
            key: 'state',
            label: 'State',
            render: (retainer) => {
              const pill = document.createElement('span')
              pill.className = 'invoice-state'
              pill.textContent = retainerStateLabel(retainer)
              return pill
            },
          },
        ],
        actions: (retainer) => [
          {
            label: 'Open',
            primary: true,
            onSelect: () => openDetail(retainer.id),
          },
        ],
      }),
    )
    listStatus.textContent = `${rows.length} ${rows.length === 1 ? 'retainer' : 'retainers'} loaded${nextCursor === null ? '.' : '; more are available.'}`
  }

  const renderLedger = (
    retainer: Readonly<Retainer>,
    history: readonly RetainerMovement[],
    currency: string,
  ): void => {
    const unit = retainerDenominationUnit(retainer)
    ledger.replaceChildren(
      renderDataTable<RetainerMovement>({
        caption: 'Retainer ledger',
        rows: history,
        rowKey: (movement) => movement.entry.id,
        empty: 'No movements recorded yet.',
        columns: [
          { key: 'date', label: 'Date', render: (movement) => movement.entry.occurred_on },
          {
            key: 'kind',
            label: 'Movement',
            render: (movement) => retainerLedgerKindLabel(movement.entry.kind),
          },
          {
            key: 'invoice',
            label: 'Invoice',
            render: (movement) => {
              if (movement.entry.invoice_id === null) return '—'
              const link = document.createElement('a')
              link.href = `/invoices/${String(movement.entry.invoice_id)}`
              link.textContent = `#${String(movement.entry.invoice_id)}`
              return link
            },
          },
          { key: 'note', label: 'Reason', render: (movement) => movement.entry.notes ?? '—' },
          {
            key: 'amount',
            label: 'Amount',
            numeric: true,
            render: (movement) =>
              denominated(
                retainerAmount(movement.entry.amount, movement.entry.unit, currency),
                movement.entry.unit === 'cents',
              ),
            // The ledger's own sum, which is the balance by invariant 10. It
            // reads beside the last running balance, so a total computed some
            // other way would be a visible contradiction rather than a hidden
            // one.
            total: (rows) =>
              denominated(
                retainerAmount(
                  rows.reduce((sum, movement) => sum + movement.entry.amount, 0),
                  unit,
                  currency,
                ),
                unit === 'cents',
              ),
          },
          {
            key: 'running',
            label: 'Balance',
            numeric: true,
            render: (movement) =>
              denominated(retainerAmount(movement.balance, unit, currency), unit === 'cents'),
          },
        ],
      }),
    )
  }

  const renderDetail = (
    retainer: Readonly<Retainer>,
    entries: readonly RetainerLedgerEntry[],
  ): void => {
    const currency = retainerCurrency(retainer, clients)
    const unit = retainerDenominationUnit(retainer)
    const summary = retainerLedgerSummary(entries)
    text('[data-retainer-detail-client]', retainerClientLabel(retainer, clients))
    text('[data-retainer-detail-title]', `Retainer #${String(retainer.id)}`)
    const inMoney = unit === 'cents'
    denominatedText(
      '[data-retainer-commitment]',
      retainerCommitmentLabel(retainer, currency),
      inMoney && retainerCommitment(retainer) !== null,
    )
    denominatedText(
      '[data-retainer-deposited]',
      retainerAmount(summary.deposited, unit, currency),
      inMoney,
    )
    denominatedText(
      '[data-retainer-drawn]',
      retainerAmount(summary.drawnDown, unit, currency),
      inMoney,
    )
    denominatedText(
      '[data-retainer-expired]',
      retainerAmount(summary.expired, unit, currency),
      inMoney,
    )
    denominatedText(
      '[data-retainer-adjusted]',
      retainerAmount(summary.adjusted, unit, currency),
      inMoney,
    )
    denominatedText(
      '[data-retainer-remaining]',
      retainerBalanceLabel(retainer, currency),
      inMoney,
    )
    factRow('[data-retainer-share-row]', retainerRemainingShare(retainer) !== null)
    text('[data-retainer-share]', retainerRemainingShareLabel(retainer))
    const lockedValue = retainerLockedRateValueCents(retainer, retainer.balance)
    factRow('[data-retainer-locked-value-row]', lockedValue !== null)
    // Always money whatever the denomination: it is an hours retainer's
    // balance priced at the rate the retainer locked.
    denominatedText(
      '[data-retainer-locked-value]',
      lockedValue === null ? '—' : retainerMoney(lockedValue, currency),
      lockedValue !== null,
    )
    text(
      '[data-retainer-scope]',
      `${retainerClientLabel(retainer, clients)} · ${retainerProjectLabel(retainer, projects)}`,
    )
    text('[data-retainer-basis]', retainerBasisLabel(retainer))
    text('[data-retainer-state]', retainerStateLabel(retainer))
    text('[data-retainer-period]', retainer.period ?? 'No period')
    text('[data-retainer-rollover]', retainerRolloverLabel(retainer.rollover))
    text('[data-retainer-expires]', retainer.expires_at ?? 'No expiry')
    text('[data-retainer-exhaustion]', retainerExhaustionLabel(retainer.on_exhaustion))
    const lines = [
      ...retainerLedgerNotes(retainer, summary),
      ...(retainerScopeConflict(retainer, projects)
        ? [
            'This retainer names a project belonging to a different client, so a drawdown against it would bill the wrong client.',
          ]
        : []),
    ]
    notes.replaceChildren(
      ...lines.map((line) => {
        const item = document.createElement('li')
        item.textContent = line
        return item
      }),
    )
    notes.hidden = lines.length === 0
    renderLedger(retainer, retainerLedgerHistory(entries), currency)
    detailBody.hidden = false
    detailStatus.textContent = `${summary.movements} ${summary.movements === 1 ? 'movement' : 'movements'} in this ledger.`
    // The retainer the dialogs will read their balance, denomination and policy
    // from is the one just painted, so the numbers a dialog projects against are
    // the numbers on screen behind it.
    selected = retainer
    syncWriteControls()
  }

  const loadDetail = async (): Promise<void> => {
    const session = current()
    const id = selection
    if (session === null || id === null) return
    const generation = ++detailGeneration
    if (api.getRetainerDetail === undefined || api.listRetainerLedger === undefined) {
      detailBody.hidden = true
      detailStatus.textContent = 'Retainers are unavailable in this build.'
      detailRetry.hidden = true
      return
    }
    detailBody.hidden = true
    detailRetry.hidden = true
    detailStatus.textContent = 'Loading retainer…'
    // Nothing may be written against a retainer whose current state is in
    // flight; `renderDetail` restores the controls with the values they act on.
    selected = null
    syncWriteControls()
    try {
      const [, retainer, entries] = await Promise.all([
        loadCatalog(session),
        api.getRetainerDetail(id, session.signal),
        api.listRetainerLedger(id, session.signal),
      ])
      if (current() !== session || generation !== detailGeneration) return
      renderDetail(retainer, entries)
    } catch (error) {
      if (current() !== session || generation !== detailGeneration) return
      if (session.onSessionFailure(error)) return
      detailBody.hidden = true
      detailStatus.textContent = messageFor(error)
      detailRetry.hidden = false
    }
  }

  const loadList = async (reset: boolean): Promise<void> => {
    const session = current()
    if (session === null) return
    if (api.listRetainers === undefined) {
      list.replaceChildren()
      list.removeAttribute('aria-busy')
      listStatus.textContent = 'Retainers are unavailable in this build.'
      loadMore.hidden = true
      listRetry.hidden = true
      return
    }
    const generation = reset ? ++listGeneration : listGeneration
    const cursor = reset ? undefined : (nextCursor ?? undefined)
    if (!reset && nextCursor === null) return
    if (reset) {
      retainers = []
      nextCursor = null
      list.replaceChildren()
    }
    listPending = true
    list.setAttribute('aria-busy', 'true')
    listStatus.textContent = reset ? 'Loading retainers…' : 'Loading more retainers…'
    loadMore.hidden = true
    listRetry.hidden = true
    syncPending()
    try {
      const [response] = await Promise.all([
        api.listRetainers(cursor, session.signal),
        loadCatalog(session),
      ])
      if (current() !== session || generation !== listGeneration) return
      const merged = new Map<number, Retainer>()
      for (const retainer of reset ? response.data : [...retainers, ...response.data]) {
        merged.set(retainer.id, retainer)
      }
      retainers = [...merged.values()]
      nextCursor = response.page.next_cursor
      renderList()
      loadMore.hidden = nextCursor === null
    } catch (error) {
      if (current() !== session || generation !== listGeneration) return
      if (session.onSessionFailure(error)) return
      list.replaceChildren()
      listStatus.textContent = messageFor(error)
      listRetry.hidden = false
      loadMore.hidden = true
    } finally {
      if (current() === session && generation === listGeneration) {
        listPending = false
        list.removeAttribute('aria-busy')
        syncPending()
      }
    }
  }

  const applyLocation = (): void => {
    if (current() === null) return
    const url = new URL(globalThis.location.href)
    const nextFilter = retainerStatusFilterFromUrl(url)
    const nextSelection = retainerSelectionFromUrl(url)
    const filterChanged = nextFilter !== filter
    filter = nextFilter
    selection = nextSelection
    syncFilters()
    syncView()
    if (filterChanged) renderList()
    if (selection === null) return
    void loadDetail()
  }

  for (const button of filterButtons) {
    button.addEventListener('click', () => {
      const next = button.dataset.retainerFilter
      if (next !== 'ongoing' && next !== 'all') return
      // Choosing a status leaves any open detail: the filter is a property of
      // the list, and staying on a detail while the list behind it changed is
      // how a Back link starts lying about where it goes.
      if (next !== filter || selection !== null) {
        globalThis.history.pushState(null, '', retainerWorkspaceUrl(next))
      }
      filter = next
      selection = null
      syncFilters()
      syncView()
      renderList()
    })
  }

  detailBack.addEventListener('click', (event) => {
    if (current() === null) return
    event.preventDefault()
    globalThis.history.pushState(null, '', retainerWorkspaceUrl(filter))
    selection = null
    syncView()
    renderList()
  })

  loadMore.addEventListener('click', () => {
    if (!listPending) void loadList(false)
  })
  listRetry.addEventListener('click', () => {
    if (!listPending) void loadList(true)
  })
  detailRetry.addEventListener('click', () => {
    void loadDetail()
  })

  const commandId = (kind: 'create' | 'drawdown' | 'movement'): string =>
    `web.retainer.${kind}:${globalThis.crypto.randomUUID()}`

  /**
   * The three codes `translateMoneyError` turns a retainer conflict into: a key
   * already bound to a different command, a trigger that refused the row, a
   * related resource that moved. All three mean the same thing to the operator
   * -- what is on screen is not what the database now holds -- and none of them
   * is retryable under the same key.
   */
  const conflictCodes = new Set(['command_id_reused', 'trigger_row_conflict', 'resource_conflict'])

  const handleWriteFailure = async (
    error: unknown,
    session: ActiveSession,
    result: HTMLElement,
  ): Promise<void> => {
    if (current() !== session) return
    if (session.onSessionFailure(error)) return
    const code = apiErrorCode(error)
    if (code !== null && conflictCodes.has(code)) {
      // The key is spent on a command the server has already decided about, so
      // the next submit has to be a new command against the state that actually
      // exists. Reload before saying so, or the operator retries against the
      // balance that lost.
      createCommandId = null
      drawdownCommandId = null
      movementCommandId = null
      result.textContent =
        'This retainer changed elsewhere. The current balance is loading; check it and try again.'
      await Promise.all([loadDetail(), loadList(true)])
      return
    }
    result.textContent = messageFor(error)
  }

  const optionalId = (value: string): number | null => {
    if (value === '') return null
    const id = Number(value)
    return Number.isSafeInteger(id) && id > 0 ? id : null
  }

  const option = (label: string, value: string): HTMLOptionElement => {
    const element = document.createElement('option')
    element.textContent = label
    element.value = value
    return element
  }

  const fillResources = (
    select: HTMLSelectElement,
    resources: readonly GeneralResource[],
    blank: string,
  ): void => {
    select.replaceChildren(
      option(blank, ''),
      ...resources.map((resource) => {
        const name = resource.name
        return option(
          typeof name === 'string' && name.trim() !== '' ? name.trim() : `#${String(resource.id)}`,
          String(resource.id),
        )
      }),
    )
  }

  /**
   * The invoices this retainer's ledger will accept, or the reason there are
   * none. A drawdown with nothing to bill it against is not an error the
   * operator caused, so it is stated in the dialog rather than left to a 409.
   */
  const fillInvoices = (select: HTMLSelectElement, retainer: Readonly<Retainer>): number => {
    const linked = retainerLinkedInvoices(retainer, invoices)
    select.replaceChildren(
      ...linked.map((invoice) => option(retainerInvoiceLabel(invoice), String(invoice.id))),
    )
    // Said outright rather than left to the UA's selectedness rules. These
    // options are inserted after the dialog's `form.reset()`, and a select that
    // has been reset does not re-select on insertion in every DOM
    // implementation — leaving a drawdown that names no invoice and refuses to
    // submit, on the one field the operator cannot type their way past.
    select.selectedIndex = linked.length === 0 ? -1 : 0
    return linked.length
  }

  const amountFieldLabel = (retainer: Readonly<Retainer>, currency: string): string =>
    retainer.denomination === 'money' ? `Amount (${currency})` : 'Hours'

  const syncCreateBasis = (): void => {
    const money = createBasis.value !== 'hours'
    const currency = retainerClientCurrency(optionalId(createClient.value), clients)
    createAmountLabel.textContent = money ? `Agreed amount (${currency})` : 'Agreed hours'
    // The rate lock exists only on an hours retainer, and only at creation.
    createRateRow.hidden = money
    createRate.disabled = money
    createRateLabel.textContent = `Lock the hourly rate at (${currency}, optional)`
  }

  const openCreateDialog = (): void => {
    if (!canWrite() || mutationPending || api.createRetainer === undefined) return
    createCommandId = null
    createForm.reset()
    fillResources(createClient, clients, 'No client')
    fillResources(createProject, projects, 'All projects')
    createBasis.value = 'money'
    createRollover.value = ''
    createExhaustion.value = 'block'
    createResult.textContent = ''
    syncCreateBasis()
    syncWriteControls()
    createDialog.showModal()
    createClient.focus()
  }

  const drawdownProjectionText = (): void => {
    const retainer = selected
    if (retainer === null) return
    const currency = retainerCurrency(retainer, clients)
    const unit = retainerDenominationUnit(retainer)
    try {
      const amount = retainerAmountFromForm(drawdownAmount.value, unit)
      const projected = retainerProjectedBalance(retainer.balance, 'drawdown', amount)
      drawdownProjection.textContent = `${retainerAmount(projected, unit, currency)}${
        retainerWouldOverdraw(retainer, projected) ? ' — more than this retainer holds' : ''
      }`
    } catch {
      drawdownProjection.textContent = '—'
    }
  }

  const openDrawdownDialog = (): void => {
    const session = current()
    const retainer = selected
    if (
      session === null ||
      retainer === null ||
      !canWrite() ||
      mutationPending ||
      api.drawDownRetainer === undefined
    ) {
      return
    }
    drawdownCommandId = null
    drawdownForm.reset()
    drawdownInvoice.replaceChildren()
    drawdownAmountLabel.textContent = amountFieldLabel(retainer, retainerCurrency(retainer, clients))
    drawdownDate.value = localDate()
    drawdownProjection.textContent = '—'
    drawdownResult.textContent = 'Loading the invoices linked to this retainer…'
    syncWriteControls()
    drawdownDialog.showModal()
    void loadInvoices(session)
      .then(() => {
        if (current() !== session || selected !== retainer || !drawdownDialog.open) return
        const linked = fillInvoices(drawdownInvoice, retainer)
        syncWriteControls()
        drawdownResult.textContent =
          linked === 0
            ? 'No invoice is linked to this retainer, and a drawdown has to name one. Link an invoice to the retainer first.'
            : ''
        if (linked > 0) drawdownAmount.focus()
      })
      .catch((error: unknown) => {
        if (current() !== session || !drawdownDialog.open) return
        if (session.onSessionFailure(error)) return
        drawdownResult.textContent = messageFor(error)
      })
  }

  const movementFormKind = (): RetainerLedgerFormKind => {
    const value = movementKind.value
    return value === 'deposit' || value === 'expiry' || value === 'reset' ? value : 'adjustment'
  }

  const movementDirectionValue = (): RetainerLedgerDirection =>
    movementDirection.value === 'decrease' ? 'decrease' : 'increase'

  const movementProjectionText = (): void => {
    const retainer = selected
    if (retainer === null) return
    const kind = movementFormKind()
    const currency = retainerCurrency(retainer, clients)
    const unit = retainerDenominationUnit(retainer)
    try {
      const request = retainerLedgerRequestAmount(
        kind,
        retainerAmountFromForm(movementAmount.value, unit),
        movementDirectionValue(),
      )
      const projected = retainerProjectedBalance(retainer.balance, kind, request)
      movementProjection.textContent = `${retainerAmount(projected, unit, currency)}${
        retainerWouldOverdraw(retainer, projected) ? ' — more than this retainer holds' : ''
      }`
    } catch {
      movementProjection.textContent = '—'
    }
  }

  const syncMovementKind = (): void => {
    const session = current()
    const retainer = selected
    if (retainer === null) return
    const kind = movementFormKind()
    const needsInvoice = retainerLedgerKindNeedsInvoice(kind)
    movementInvoiceLabel.hidden = !needsInvoice
    movementInvoice.disabled = !needsInvoice
    movementDirectionLabel.hidden = !retainerLedgerKindIsSigned(kind)
    movementDirection.disabled = !retainerLedgerKindIsSigned(kind)
    movementNotesLabel.textContent = retainerLedgerKindNeedsNotes(kind)
      ? 'Reason (required)'
      : 'Reason'
    movementHint.textContent =
      kind === 'deposit'
        ? 'A deposit records money put on retainer through an invoice, so it names the invoice it arrived on.'
        : kind === 'expiry'
          ? 'An expiry takes an unused balance off the retainer at a boundary. State how much is expiring; it comes off the balance.'
          : kind === 'reset'
            ? 'A reset restates the balance at a period boundary. It can go either way, so say which.'
            : 'An adjustment is the correction of record, and the only movement the ledger requires a reason for. An opening balance carried over from another system arrives this way.'
    movementProjectionText()
    if (!needsInvoice || session === null) return
    movementInvoice.replaceChildren()
    movementResult.textContent = 'Loading the invoices linked to this retainer…'
    void loadInvoices(session)
      .then(() => {
        if (current() !== session || selected !== retainer || !movementDialog.open) return
        if (!retainerLedgerKindNeedsInvoice(movementFormKind())) return
        const linked = fillInvoices(movementInvoice, retainer)
        movementResult.textContent =
          linked === 0
            ? 'No invoice is linked to this retainer, and a deposit has to name one. Record it as an adjustment, or link an invoice first.'
            : ''
      })
      .catch((error: unknown) => {
        if (current() !== session || !movementDialog.open) return
        if (session.onSessionFailure(error)) return
        movementResult.textContent = messageFor(error)
      })
  }

  const openMovementDialog = (): void => {
    const retainer = selected
    if (
      retainer === null ||
      !canWrite() ||
      mutationPending ||
      api.appendRetainerLedger === undefined
    ) {
      return
    }
    movementCommandId = null
    movementForm.reset()
    movementInvoice.replaceChildren()
    // Adjustment first, and preselected: it is the movement the cutover left
    // undone -- the opening balance of retainer 12345 was one -- and the only
    // one that needs no invoice to exist first.
    movementKind.value = 'adjustment'
    movementDirection.value = 'increase'
    movementAmountLabel.textContent = amountFieldLabel(retainer, retainerCurrency(retainer, clients))
    movementDate.value = localDate()
    movementProjection.textContent = '—'
    movementResult.textContent = ''
    syncMovementKind()
    syncWriteControls()
    movementDialog.showModal()
    movementAmount.focus()
  }

  const openPolicyDialog = (): void => {
    const retainer = selected
    if (retainer === null || !canWrite() || mutationPending || api.updateRetainer === undefined) {
      return
    }
    policyForm.reset()
    policyState.value = retainer.state
    policyPeriod.value = retainer.period ?? ''
    policyRollover.value = retainer.rollover ?? ''
    policyExpires.value = retainer.expires_at ?? ''
    policyExhaustion.value = retainer.on_exhaustion
    policyResult.textContent = ''
    syncWriteControls()
    policyDialog.showModal()
    policyState.focus()
  }

  /** One place for the post-mutation reload, because every write needs both:
   *  the detail carries the ledger and the new balance, the list carries the
   *  same balance in its Remaining column. */
  const refreshAfterWrite = async (): Promise<void> => {
    await Promise.all([loadDetail(), loadList(true)])
  }

  createTrigger.addEventListener('click', openCreateDialog)
  drawdownTrigger.addEventListener('click', openDrawdownDialog)
  movementTrigger.addEventListener('click', openMovementDialog)
  policyTrigger.addEventListener('click', openPolicyDialog)

  createBasis.addEventListener('change', syncCreateBasis)
  createClient.addEventListener('change', syncCreateBasis)
  createForm.addEventListener('input', () => {
    // An edited field is a different command. Dropping the key while a request
    // is in flight would let its retry commit twice, so the key only moves when
    // nothing is pending.
    if (!mutationPending) createCommandId = null
    createResult.textContent = ''
  })
  drawdownForm.addEventListener('input', () => {
    if (!mutationPending) drawdownCommandId = null
    drawdownResult.textContent = ''
    drawdownProjectionText()
  })
  movementKind.addEventListener('change', syncMovementKind)
  movementForm.addEventListener('input', () => {
    if (!mutationPending) movementCommandId = null
    movementResult.textContent = ''
    movementProjectionText()
  })

  createForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const session = current()
    const create = api.createRetainer
    if (session === null || create === undefined || mutationPending || !canWrite()) return
    let input: RetainerInput
    try {
      input = retainerCreateInput(
        {
          clientId: optionalId(createClient.value),
          projectId: optionalId(createProject.value),
          denomination: createBasis.value === 'hours' ? 'hours' : 'money',
          amount: createAmount.value,
          lockedRate: createRate.value,
          period: createPeriod.value,
          rollover:
            createRollover.value === 'carry' ||
            createRollover.value === 'expire' ||
            createRollover.value === 'cap'
              ? createRollover.value
              : '',
          expiresAt: createExpires.value,
          onExhaustion:
            createExhaustion.value === 'warn' || createExhaustion.value === 'overflow'
              ? createExhaustion.value
              : 'block',
        },
        new Date().toISOString(),
      )
    } catch (error) {
      createResult.textContent = messageFor(error)
      createAmount.focus()
      return
    }
    createCommandId ??= commandId('create')
    const activeCommand = createCommandId
    mutationPending = true
    createResult.textContent = 'Creating retainer…'
    syncWriteControls()
    void create(activeCommand, input, session.signal)
      .then(async (created) => {
        if (current() !== session) return
        createCommandId = null
        createResult.textContent = ''
        createDialog.close()
        await loadList(true)
        if (current() !== session) return
        openDetail(created.id)
        writeStatus.textContent = `Retainer #${String(created.id)} created. Its balance is zero until a movement is recorded.`
      })
      .catch((error: unknown) => handleWriteFailure(error, session, createResult))
      .finally(() => {
        if (current() !== session) return
        mutationPending = false
        syncWriteControls()
      })
  })

  drawdownForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const session = current()
    const retainer = selected
    const drawDown = api.drawDownRetainer
    if (
      session === null ||
      retainer === null ||
      drawDown === undefined ||
      mutationPending ||
      !canWrite()
    ) {
      return
    }
    const unit = retainerDenominationUnit(retainer)
    const currency = retainerCurrency(retainer, clients)
    const invoiceId = optionalId(drawdownInvoice.value)
    if (invoiceId === null) {
      drawdownResult.textContent = 'Choose the invoice this drawdown is billed on.'
      drawdownInvoice.focus()
      return
    }
    let amount: number
    try {
      amount = retainerAmountFromForm(drawdownAmount.value, unit)
    } catch (error) {
      drawdownResult.textContent = messageFor(error)
      drawdownAmount.focus()
      return
    }
    if (amount === 0) {
      // `amount_cents` has a minimum of 1 on an unsigned kind, so this is the
      // 422 the API would return, said before a money endpoint is called at
      // all. The movement dialog stops its own zero for the same reason.
      drawdownResult.textContent = 'A drawdown of zero changes nothing and the ledger refuses it.'
      drawdownAmount.focus()
      return
    }
    const projected = retainerProjectedBalance(retainer.balance, 'drawdown', amount)
    if (retainerWouldOverdraw(retainer, projected)) {
      // The same refusal `retainer_ledger_balance_guard` would make, made here
      // so it reads as a number rather than as "resource conflict".
      drawdownResult.textContent = `This retainer holds ${retainerAmount(retainer.balance, unit, currency)}. Drawing down ${retainerAmount(amount, unit, currency)} would overdraw it, which its exhaustion policy does not allow.`
      drawdownAmount.focus()
      return
    }
    const notes = drawdownNotes.value.trim() === '' ? null : drawdownNotes.value.trim()
    const occurredOn = drawdownDate.value
    const body = (
      unit === 'cents'
        ? { invoice_id: invoiceId, amount_cents: amount, occurred_on: occurredOn, notes }
        : { invoice_id: invoiceId, seconds: amount, occurred_on: occurredOn, notes }
    ) as RetainerDrawdownInput
    drawdownCommandId ??= commandId('drawdown')
    const activeCommand = drawdownCommandId
    mutationPending = true
    drawdownResult.textContent = 'Recording drawdown…'
    syncWriteControls()
    void drawDown(retainer.id, activeCommand, body, session.signal)
      .then(async (mutation) => {
        if (current() !== session) return
        drawdownCommandId = null
        drawdownResult.textContent = ''
        drawdownDialog.close()
        // The balance in the message is the server's, not this side's
        // arithmetic: the projection above was a forecast, and this is the
        // ledger's own answer after the row landed.
        writeStatus.textContent = `Drew down ${retainerAmount(amount, unit, currency)}. The balance is now ${retainerAmount(mutation.balance, mutation.denomination === 'money' ? 'cents' : 'seconds', currency)}.`
        await refreshAfterWrite()
      })
      .catch((error: unknown) => handleWriteFailure(error, session, drawdownResult))
      .finally(() => {
        if (current() !== session) return
        mutationPending = false
        syncWriteControls()
      })
  })

  movementForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const session = current()
    const retainer = selected
    const append = api.appendRetainerLedger
    if (
      session === null ||
      retainer === null ||
      append === undefined ||
      mutationPending ||
      !canWrite()
    ) {
      return
    }
    const kind = movementFormKind()
    const unit = retainerDenominationUnit(retainer)
    const currency = retainerCurrency(retainer, clients)
    const invoiceId = retainerLedgerKindNeedsInvoice(kind)
      ? optionalId(movementInvoice.value)
      : null
    if (retainerLedgerKindNeedsInvoice(kind) && invoiceId === null) {
      movementResult.textContent = 'Choose the invoice this deposit arrived on.'
      movementInvoice.focus()
      return
    }
    const notes = movementNotes.value.trim()
    if (retainerLedgerKindNeedsNotes(kind) && notes === '') {
      movementResult.textContent = 'An adjustment needs a reason. Say what it corrects.'
      movementNotes.focus()
      return
    }
    let request: number
    try {
      request = retainerLedgerRequestAmount(
        kind,
        retainerAmountFromForm(movementAmount.value, unit),
        movementDirectionValue(),
      )
    } catch (error) {
      movementResult.textContent = messageFor(error)
      movementAmount.focus()
      return
    }
    if (request === 0) {
      movementResult.textContent = 'A movement of zero changes nothing and the ledger refuses it.'
      movementAmount.focus()
      return
    }
    const projected = retainerProjectedBalance(retainer.balance, kind, request)
    if (retainerWouldOverdraw(retainer, projected)) {
      movementResult.textContent = `This retainer holds ${retainerAmount(retainer.balance, unit, currency)}. That movement would leave ${retainerAmount(projected, unit, currency)}, which its exhaustion policy does not allow.`
      movementAmount.focus()
      return
    }
    const occurredOn = movementDate.value
    const amountField = unit === 'cents' ? { amount_cents: request } : { seconds: request }
    const body = {
      kind,
      ...amountField,
      ...(invoiceId === null ? {} : { invoice_id: invoiceId }),
      occurred_on: occurredOn,
      notes: notes === '' ? null : notes,
    } as RetainerLedgerInput
    movementCommandId ??= commandId('movement')
    const activeCommand = movementCommandId
    mutationPending = true
    movementResult.textContent = 'Recording movement…'
    syncWriteControls()
    void append(retainer.id, activeCommand, body, session.signal)
      .then(async (mutation) => {
        if (current() !== session) return
        movementCommandId = null
        movementResult.textContent = ''
        movementDialog.close()
        writeStatus.textContent = `${retainerLedgerKindLabel(mutation.entry.kind)} of ${retainerAmount(mutation.entry.amount, mutation.entry.unit, currency)} recorded. The balance is now ${retainerAmount(mutation.balance, mutation.denomination === 'money' ? 'cents' : 'seconds', currency)}.`
        await refreshAfterWrite()
      })
      .catch((error: unknown) => handleWriteFailure(error, session, movementResult))
      .finally(() => {
        if (current() !== session) return
        mutationPending = false
        syncWriteControls()
      })
  })

  policyForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const session = current()
    const retainer = selected
    const update = api.updateRetainer
    if (
      session === null ||
      retainer === null ||
      update === undefined ||
      mutationPending ||
      !canWrite()
    ) {
      return
    }
    const patch = retainerPolicyPatch(retainer, {
      state: policyState.value === 'closed' ? 'closed' : 'ongoing',
      period: policyPeriod.value,
      rollover:
        policyRollover.value === 'carry' ||
        policyRollover.value === 'expire' ||
        policyRollover.value === 'cap'
          ? policyRollover.value
          : '',
      expiresAt: policyExpires.value,
      onExhaustion:
        policyExhaustion.value === 'warn' || policyExhaustion.value === 'overflow'
          ? policyExhaustion.value
          : 'block',
    })
    if (Object.keys(patch).length === 0) {
      policyResult.textContent = 'Nothing has changed.'
      return
    }
    mutationPending = true
    policyResult.textContent = 'Saving policy…'
    syncWriteControls()
    void update(retainer.id, patch, session.signal)
      .then(async () => {
        if (current() !== session) return
        policyResult.textContent = ''
        policyDialog.close()
        writeStatus.textContent = 'Retainer policy saved.'
        await refreshAfterWrite()
      })
      .catch((error: unknown) => handleWriteFailure(error, session, policyResult))
      .finally(() => {
        if (current() !== session) return
        mutationPending = false
        syncWriteControls()
      })
  })

  return {
    async activate(identity, signal, onSessionFailure) {
      if (!isPage) return
      const session = { identity, signal, onSessionFailure }
      activeSession = session
      const url = new URL(globalThis.location.href)
      filter = retainerStatusFilterFromUrl(url)
      selection = retainerSelectionFromUrl(url)
      clearPrivatePresentation()
      syncFilters()
      syncView()
      globalThis.addEventListener('popstate', applyLocation, { signal })
      signal.addEventListener(
        'abort',
        () => {
          if (activeSession !== session) return
          activeSession = null
          clearPrivatePresentation()
          listStatus.textContent = 'Sign in to view retainers.'
          detailStatus.textContent = 'Sign in to view retainers.'
        },
        { once: true },
      )
      await Promise.all([loadList(true), loadDetail()])
    },
  }
}
