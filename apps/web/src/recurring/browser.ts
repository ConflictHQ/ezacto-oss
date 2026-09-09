import { renderDataTable } from '../components/data-table.js'
import {
  EzactoApiError,
  type GeneralResource,
  type RecurringFixedLine,
  type RecurringInvoice,
  type Whoami,
} from '@ezacto/client'
import {
  recurringAmountLabel,
  recurringBasisLabel,
  recurringCadenceLabel,
  recurringClientLabel,
  recurringCurrency,
  recurringDueLabel,
  recurringDueState,
  recurringGenerationOutcome,
  recurringIssuedMessage,
  recurringListOrder,
  recurringMatchesSearch,
  recurringMoney,
  recurringProjectLabel,
  recurringSelectionFromUrl,
  recurringWorkspaceUrl,
  type RecurringWorkspaceApi,
} from './model.js'

const required = <ElementType extends Element>(selector: string): ElementType => {
  const item = document.querySelector<ElementType>(selector)
  if (item === null) throw new Error(`recurring element missing: ${selector}`)
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
    if (error.status === 403) return 'You do not have access to recurring invoices.'
    if (error.status === 404) return 'That recurring definition no longer exists.'
  }
  return error instanceof Error ? error.message : 'The request could not be completed.'
}

const text = (selector: string, value: string): void => {
  required<HTMLElement>(selector).textContent = value
}

interface ActiveSession {
  readonly identity: Whoami
  readonly signal: AbortSignal
  readonly onSessionFailure: (error: unknown) => boolean
}

export interface RecurringWorkspaceController {
  activate(
    identity: Whoami,
    signal: AbortSignal,
    onSessionFailure: (error: unknown) => boolean,
  ): Promise<void>
}

/**
 * The recurring-invoices workspace: a list of standing instructions, and one
 * button that acts on them.
 *
 * The list is what the screen was missing; the button is what makes it a
 * screen. `POST /recurring-invoices/:id/generations` was wired to the engine
 * and nothing called it, so a definition sat at its `next_issue_on` date
 * forever with no way in the product to move it.
 *
 * Issuing is confirmed rather than immediate. A recurring invoice becomes a
 * document addressed to a client; a single stray click should not raise one.
 * And when the server refuses, the four refusals stay apart -- "not due yet"
 * and "already issued" are the definition working, not failing, and reading
 * them as errors is what sends someone off to fix a definition that was right.
 */
export const createRecurringWorkspaceController = (
  api: Partial<RecurringWorkspaceApi>,
  now: () => string = () => new Date().toISOString(),
): RecurringWorkspaceController => {
  const isPage = document.documentElement.dataset.appView === 'invoice-recurring'
  const page = required<HTMLElement>('[data-invoice-recurring-page]')
  const listView = required<HTMLElement>('[data-recurring-list-view]')
  const listStatus = required<HTMLElement>('[data-recurring-list-status]')
  const list = required<HTMLElement>('[data-recurring-list]')
  const search = required<HTMLInputElement>('[data-recurring-search]')
  const loadMore = required<HTMLButtonElement>('[data-recurring-load-more]')
  const listRetry = required<HTMLButtonElement>('[data-recurring-list-retry]')
  const detailView = required<HTMLElement>('[data-recurring-detail-view]')
  const detailStatus = required<HTMLElement>('[data-recurring-detail-status]')
  const detailRetry = required<HTMLButtonElement>('[data-recurring-detail-retry]')
  const detailBody = required<HTMLElement>('[data-recurring-detail-body]')
  const detailBack = required<HTMLAnchorElement>('[data-recurring-back]')
  const config = required<HTMLElement>('[data-recurring-config]')
  const issue = required<HTMLButtonElement>('[data-recurring-issue]')
  const issueResult = required<HTMLElement>('[data-recurring-issue-result]')
  const issuedLink = required<HTMLAnchorElement>('[data-recurring-issued-link]')
  const confirmDialog = required<HTMLDialogElement>('[data-recurring-confirm]')
  const confirmForm = required<HTMLFormElement>('[data-recurring-confirm-form]')
  const confirmBody = required<HTMLElement>('[data-recurring-confirm-body]')
  const confirmSubmit = required<HTMLButtonElement>('[data-recurring-confirm-submit]')
  page.hidden = !isPage

  let activeSession: ActiveSession | null = null
  let selection: number | null = null
  let definitions: readonly RecurringInvoice[] = []
  let clients: readonly GeneralResource[] = []
  let projects: readonly GeneralResource[] = []
  let nextCursor: string | null = null
  let listGeneration = 0
  let detailGeneration = 0
  let listPending = false
  let issuePending = false
  let catalog: Promise<void> | null = null
  /**
   * Held across a retry so a network failure the caller did not see cannot
   * raise a second invoice. The server treats the key as the command identity;
   * a fresh one on retry would be a fresh command.
   */
  let issueKey: string | null = null

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
   * views. A deep link straight to `?definition=2` has no list load to
   * piggyback on, so sharing one promise is what stops the detail painting
   * "Client #5" and USD before the names land.
   */
  const loadCatalog = (session: ActiveSession): Promise<void> => {
    catalog ??= (async () => {
      const [loadedClients, loadedProjects] = await Promise.all([
        api.listRecurringClients === undefined
          ? Promise.resolve<GeneralResource[]>([])
          : collect(api.listRecurringClients, session.signal),
        api.listRecurringProjects === undefined
          ? Promise.resolve<GeneralResource[]>([])
          : collect(api.listRecurringProjects, session.signal),
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

  const syncPending = (): void => {
    loadMore.disabled = listPending
    listRetry.disabled = listPending
  }

  const syncView = (): void => {
    listView.hidden = selection !== null
    detailView.hidden = selection === null
    detailBack.href = recurringWorkspaceUrl()
  }

  const clearPrivatePresentation = (): void => {
    listGeneration += 1
    detailGeneration += 1
    definitions = []
    clients = []
    projects = []
    nextCursor = null
    listPending = false
    issuePending = false
    issueKey = null
    catalog = null
    list.replaceChildren()
    list.removeAttribute('aria-busy')
    config.replaceChildren()
    detailBody.hidden = true
    issueResult.textContent = ''
    delete issueResult.dataset.outcome
    issuedLink.hidden = true
    issue.disabled = true
    listStatus.textContent = 'Loading recurring invoices…'
    detailStatus.textContent = 'Loading recurring invoice…'
    loadMore.hidden = true
    listRetry.hidden = true
    detailRetry.hidden = true
    syncPending()
  }

  const visible = (): readonly RecurringInvoice[] =>
    recurringListOrder(
      definitions.filter((definition) =>
        recurringMatchesSearch(definition, clients, search.value),
      ),
    )

  const openDetail = (id: number): void => {
    globalThis.history.pushState(null, '', recurringWorkspaceUrl(id))
    selection = id
    syncView()
    void loadDetail()
  }

  const renderList = (): void => {
    const rows = visible()
    const today = now()
    if (rows.length === 0) {
      list.replaceChildren()
      listStatus.textContent =
        definitions.length === 0
          ? 'No recurring invoices yet. A definition bills a client on a cadence without anyone remembering to.'
          : 'No recurring invoices match that search.'
      return
    }
    list.replaceChildren(
      renderDataTable<RecurringInvoice>({
        caption: 'Recurring invoices',
        rows,
        rowKey: (definition) => String(definition.id),
        groupBy: (definition) => recurringClientLabel(definition, clients),
        columns: [
          {
            key: 'subject',
            label: 'Subject',
            render: (definition) => definition.subject_template,
          },
          { key: 'cadence', label: 'Cadence', render: recurringCadenceLabel },
          {
            key: 'next',
            label: 'Next issue',
            render: (definition) => definition.next_issue_on,
          },
          {
            key: 'due',
            label: 'Status',
            render: (definition) => {
              const state = recurringDueState(definition, today)
              const pill = document.createElement('span')
              pill.className = 'invoice-state'
              pill.dataset.recurringDue = state
              pill.textContent = recurringDueLabel(state)
              return pill
            },
          },
          { key: 'basis', label: 'Bills', render: recurringBasisLabel },
          {
            key: 'amount',
            label: 'Amount',
            numeric: true,
            render: (definition) =>
              recurringAmountLabel(definition, recurringCurrency(definition, clients)),
          },
        ],
        actions: (definition) => [
          { label: 'Open', primary: true, onSelect: () => openDetail(definition.id) },
        ],
      }),
    )
    listStatus.textContent = `${rows.length} ${rows.length === 1 ? 'definition' : 'definitions'} loaded${nextCursor === null ? '.' : '; more are available.'}`
  }

  const renderConfig = (definition: Readonly<RecurringInvoice>, currency: string): void => {
    const amountConfig = definition.amount_config
    const hint = required<HTMLElement>('[data-recurring-config-hint]')
    if (amountConfig.type === 'fixed_lines') {
      hint.textContent =
        'The same lines every period, at the same prices. The invoice is the same size whatever the month held.'
      config.replaceChildren(
        // Wrapped with their position because a fixed line has no id and two
        // identical lines are legal -- the position is the only thing that
        // tells them apart, and it is what the generated invoice orders by.
        renderDataTable<{ readonly position: number; readonly line: RecurringFixedLine }>({
          caption: 'Fixed lines',
          rows: amountConfig.line_items.map((line, position) => ({ position, line })),
          rowKey: (row) => String(row.position),
          empty: 'This definition has no lines, so it would raise an empty invoice.',
          columns: [
            { key: 'kind', label: 'Kind', render: (row) => row.line.kind },
            {
              key: 'description',
              label: 'Description',
              render: (row) => row.line.description ?? '—',
            },
            {
              key: 'project',
              label: 'Project',
              render: (row) =>
                row.line.project_id === null
                  ? '—'
                  : recurringProjectLabel(row.line.project_id, projects),
            },
            {
              key: 'quantity',
              label: 'Quantity',
              numeric: true,
              render: (row) => String(row.line.quantity),
            },
            {
              key: 'unit',
              label: 'Unit price',
              numeric: true,
              render: (row) => recurringMoney(row.line.unit_price_cents, currency),
            },
            {
              key: 'amount',
              label: 'Amount',
              numeric: true,
              render: (row) =>
                recurringMoney(
                  Math.round(row.line.quantity * row.line.unit_price_cents),
                  currency,
                ),
              total: (rows) =>
                recurringMoney(
                  rows.reduce(
                    (sum, row) =>
                      sum + Math.round(row.line.quantity * row.line.unit_price_cents),
                    0,
                  ),
                  currency,
                ),
            },
          ],
        }),
      )
      return
    }
    hint.textContent =
      'Whatever is uninvoiced on these projects when the day comes. The amount is not known until it runs.'
    config.replaceChildren(
      renderDataTable<number>({
        caption: 'Projects swept',
        rows: amountConfig.project_ids,
        rowKey: (projectId) => String(projectId),
        empty: 'No projects are named, so this definition would sweep nothing.',
        columns: [
          {
            key: 'project',
            label: 'Project',
            render: (projectId) => recurringProjectLabel(projectId, projects),
          },
        ],
      }),
    )
  }

  const renderDetail = (definition: Readonly<RecurringInvoice>): void => {
    const currency = recurringCurrency(definition, clients)
    const state = recurringDueState(definition, now())
    text('[data-recurring-detail-client]', recurringClientLabel(definition, clients))
    text('[data-recurring-detail-title]', definition.subject_template)
    text('[data-recurring-client]', recurringClientLabel(definition, clients))
    text('[data-recurring-cadence]', recurringCadenceLabel(definition))
    text('[data-recurring-next]', definition.next_issue_on)
    text('[data-recurring-due]', recurringDueLabel(state))
    text('[data-recurring-basis]', recurringBasisLabel(definition))
    text('[data-recurring-amount]', recurringAmountLabel(definition, currency))
    text('[data-recurring-subject]', definition.subject_template)
    text('[data-recurring-notes]', definition.notes_template.trim() === '' ? '—' : definition.notes_template)
    const retainerRow = required<HTMLElement>('[data-recurring-retainer-row]')
    retainerRow.hidden = definition.can_draw_from_retainer_id === null
    text(
      '[data-recurring-retainer]',
      definition.can_draw_from_retainer_id === null
        ? '—'
        : `Retainer #${String(definition.can_draw_from_retainer_id)}`,
    )
    renderConfig(definition, currency)
    // Offered whatever the date says. The server decides whether it is due, and
    // it has the authoritative clock; a button disabled by the browser's idea of
    // today is a button that lies on the wrong side of midnight.
    issue.disabled = api.generateRecurringInvoice === undefined
    text(
      '[data-recurring-issue-hint]',
      api.generateRecurringInvoice === undefined
        ? 'This build cannot issue recurring invoices.'
        : 'Raises the invoice this definition is due for and moves the cadence on. The invoice is a draft; nothing is sent to the client.',
    )
    detailBody.hidden = false
    detailStatus.textContent = `${recurringDueLabel(state)} — next on ${definition.next_issue_on}.`
  }

  const runIssue = async (): Promise<void> => {
    const session = current()
    const id = selection
    if (session === null || id === null || issuePending) return
    if (api.generateRecurringInvoice === undefined) return
    issueKey ??= globalThis.crypto.randomUUID()
    issuePending = true
    issue.disabled = true
    issuedLink.hidden = true
    issueResult.dataset.outcome = 'pending'
    issueResult.textContent = 'Issuing…'
    try {
      const result = await api.generateRecurringInvoice(id, issueKey, session.signal)
      if (current() !== session) return
      issueKey = null
      issueResult.dataset.outcome = 'issued'
      issueResult.textContent = recurringIssuedMessage(result.generation)
      issuedLink.href = `/invoices/${String(result.invoice.id)}`
      issuedLink.hidden = false
      // The cadence moved, so the list and the facts above are now stale.
      await Promise.all([loadList(true), loadDetail()])
    } catch (error) {
      if (current() !== session) return
      if (session.onSessionFailure(error)) return
      const outcome = recurringGenerationOutcome(error)
      // The outcome is on the element, not only in the sentence. "Not due yet"
      // and "already issued" are the definition working as instructed, and a
      // person scanning the page should not have to read the words to know
      // that nothing went wrong.
      issueResult.dataset.outcome = outcome.kind
      issueResult.textContent = outcome.message
      // A refusal that means "the definition is working" leaves the key spent:
      // retrying it would ask the same question and get the same answer.
      if (outcome.kind === 'not_due' || outcome.kind === 'already_generated') issueKey = null
    } finally {
      if (current() === session) {
        issuePending = false
        issue.disabled = api.generateRecurringInvoice === undefined
      }
    }
  }

  const loadDetail = async (): Promise<void> => {
    const session = current()
    const id = selection
    if (session === null || id === null) return
    const generation = ++detailGeneration
    if (api.getRecurringInvoice === undefined) {
      detailBody.hidden = true
      detailStatus.textContent = 'Recurring invoices are unavailable in this build.'
      detailRetry.hidden = true
      return
    }
    detailBody.hidden = true
    detailRetry.hidden = true
    detailStatus.textContent = 'Loading recurring invoice…'
    try {
      const [, definition] = await Promise.all([
        loadCatalog(session),
        api.getRecurringInvoice(id, session.signal),
      ])
      if (current() !== session || generation !== detailGeneration) return
      renderDetail(definition)
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
    if (api.listRecurringInvoices === undefined) {
      list.replaceChildren()
      list.removeAttribute('aria-busy')
      listStatus.textContent = 'Recurring invoices are unavailable in this build.'
      loadMore.hidden = true
      listRetry.hidden = true
      return
    }
    const generation = reset ? ++listGeneration : listGeneration
    const cursor = reset ? undefined : (nextCursor ?? undefined)
    if (!reset && nextCursor === null) return
    if (reset) {
      definitions = []
      nextCursor = null
      list.replaceChildren()
    }
    listPending = true
    list.setAttribute('aria-busy', 'true')
    listStatus.textContent = reset
      ? 'Loading recurring invoices…'
      : 'Loading more recurring invoices…'
    loadMore.hidden = true
    listRetry.hidden = true
    syncPending()
    try {
      const [response] = await Promise.all([
        api.listRecurringInvoices(cursor, session.signal),
        loadCatalog(session),
      ])
      if (current() !== session || generation !== listGeneration) return
      const merged = new Map<number, RecurringInvoice>()
      for (const definition of reset ? response.data : [...definitions, ...response.data]) {
        merged.set(definition.id, definition)
      }
      definitions = [...merged.values()]
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
    selection = recurringSelectionFromUrl(new URL(globalThis.location.href))
    syncView()
    if (selection === null) {
      renderList()
      return
    }
    void loadDetail()
  }

  search.addEventListener('input', () => {
    if (current() === null || selection !== null) return
    renderList()
  })

  detailBack.addEventListener('click', (event) => {
    if (current() === null) return
    event.preventDefault()
    globalThis.history.pushState(null, '', recurringWorkspaceUrl())
    selection = null
    issueResult.textContent = ''
    delete issueResult.dataset.outcome
    issuedLink.hidden = true
    issueKey = null
    syncView()
    renderList()
  })

  issue.addEventListener('click', () => {
    if (current() === null || selection === null || issuePending) return
    const definition = definitions.find((candidate) => candidate.id === selection)
    confirmBody.textContent =
      definition === undefined
        ? 'This raises a draft invoice and moves the cadence on.'
        : `This raises a draft invoice for ${recurringClientLabel(definition, clients)} and moves the cadence on from ${definition.next_issue_on}.`
    confirmSubmit.disabled = false
    confirmDialog.showModal()
  })

  confirmForm.addEventListener('submit', () => {
    confirmDialog.close()
    void runIssue()
  })

  for (const cancel of document.querySelectorAll<HTMLButtonElement>(
    '[data-recurring-confirm-cancel]',
  )) {
    cancel.addEventListener('click', () => {
      confirmDialog.close()
    })
  }

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
      selection = recurringSelectionFromUrl(new URL(globalThis.location.href))
      clearPrivatePresentation()
      syncView()
      globalThis.addEventListener('popstate', applyLocation, { signal })
      signal.addEventListener(
        'abort',
        () => {
          if (activeSession !== session) return
          activeSession = null
          clearPrivatePresentation()
          listStatus.textContent = 'Sign in to view recurring invoices.'
          detailStatus.textContent = 'Sign in to view recurring invoices.'
        },
        { once: true },
      )
      await Promise.all([loadList(true), loadDetail()])
    },
  }
}
