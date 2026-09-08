import { renderDataTable } from '../components/data-table.js'
import {
  EzactoApiError,
  type GeneralResource,
  type Retainer,
  type RetainerLedgerEntry,
  type Whoami,
} from '@ezacto/client'
import {
  retainerAmount,
  retainerBalanceLabel,
  retainerBasisLabel,
  retainerClientLabel,
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
      const message = Reflect.get(detail, 'message')
      if (typeof message === 'string' && message.trim() !== '') return message
    }
    if (error.status === 401) return 'Your session ended. Sign in again to continue.'
    if (error.status === 403) return 'You do not have access to retainers.'
    if (error.status === 404) return 'That retainer no longer exists.'
  }
  return error instanceof Error ? error.message : 'The retainer request could not be completed.'
}

const text = (selector: string, value: string): void => {
  required<HTMLElement>(selector).textContent = value
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

  const current = (): ActiveSession | null =>
    activeSession === null || activeSession.signal.aborted ? null : activeSession

  const collect = async (
    load: (
      cursor?: string,
      signal?: AbortSignal,
    ) => Promise<{
      readonly data: readonly GeneralResource[]
      readonly page: { readonly next_cursor: string | null }
    }>,
    signal: AbortSignal,
  ): Promise<GeneralResource[]> => {
    const resources: GeneralResource[] = []
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
    list.replaceChildren()
    list.removeAttribute('aria-busy')
    ledger.replaceChildren()
    notes.replaceChildren()
    notes.hidden = true
    detailBody.hidden = true
    listStatus.textContent = 'Loading retainers…'
    detailStatus.textContent = 'Loading retainer…'
    loadMore.hidden = true
    listRetry.hidden = true
    detailRetry.hidden = true
    syncPending()
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
              retainerCommitmentLabel(retainer, retainerCurrency(retainer, clients)),
          },
          {
            key: 'balance',
            label: 'Remaining',
            numeric: true,
            render: (retainer) =>
              retainerBalanceLabel(retainer, retainerCurrency(retainer, clients)),
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
              retainerAmount(movement.entry.amount, movement.entry.unit, currency),
            // The ledger's own sum, which is the balance by invariant 10. It
            // reads beside the last running balance, so a total computed some
            // other way would be a visible contradiction rather than a hidden
            // one.
            total: (rows) =>
              retainerAmount(
                rows.reduce((sum, movement) => sum + movement.entry.amount, 0),
                unit,
                currency,
              ),
          },
          {
            key: 'running',
            label: 'Balance',
            numeric: true,
            render: (movement) => retainerAmount(movement.balance, unit, currency),
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
    text('[data-retainer-commitment]', retainerCommitmentLabel(retainer, currency))
    text('[data-retainer-deposited]', retainerAmount(summary.deposited, unit, currency))
    text('[data-retainer-drawn]', retainerAmount(summary.drawnDown, unit, currency))
    text('[data-retainer-expired]', retainerAmount(summary.expired, unit, currency))
    text('[data-retainer-adjusted]', retainerAmount(summary.adjusted, unit, currency))
    text('[data-retainer-remaining]', retainerBalanceLabel(retainer, currency))
    factRow('[data-retainer-share-row]', retainerRemainingShare(retainer) !== null)
    text('[data-retainer-share]', retainerRemainingShareLabel(retainer))
    const lockedValue = retainerLockedRateValueCents(retainer, retainer.balance)
    factRow('[data-retainer-locked-value-row]', lockedValue !== null)
    text(
      '[data-retainer-locked-value]',
      lockedValue === null ? '—' : retainerMoney(lockedValue, currency),
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
