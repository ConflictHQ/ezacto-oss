import { renderDataTable, type CellContent } from '../components/data-table.js'
import { markMoney, moneyText } from '../money-display.js'
import { invoicePagePath } from '../invoices/model.js'
import { leavePageNotice, takePageNotice } from '../page-notice.js'
import {
  EzactoApiError,
  type GeneralResource,
  type RecurringFixedLine,
  type RecurringInvoice,
  type RecurringInvoiceInput,
  type Whoami,
} from '@conflict-hq/ezacto-client'
import {
  recurringAmountLabel,
  recurringFixedTotalCents,
  recurringBasisLabel,
  recurringBlankFormValues,
  recurringBlankLine,
  recurringCadenceLabel,
  recurringClientLabel,
  recurringCurrency,
  recurringDefinitionInput,
  recurringDueLabel,
  recurringDueState,
  recurringEditorReturnUrl,
  recurringEditorTargetFromPathname,
  recurringEditorUrl,
  recurringFormValuesFromDefinition,
  recurringGenerationOutcome,
  recurringIdentityCanWrite,
  recurringIssuedMessage,
  recurringLineAmountCents,
  recurringListOrder,
  recurringMatchesSearch,
  recurringMoney,
  recurringProjectLabel,
  recurringSelectionFromUrl,
  recurringWorkspaceUrl,
  type RecurringDefinitionFormValues,
  type RecurringEditorTarget,
  type RecurringLineFormValues,
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

/**
 * A 409 on delete has one cause: the definition has raised at least one invoice,
 * and `invoices.recurring_invoice_id` is ON DELETE RESTRICT. Naming it beats the
 * generic financial-command message, which tells the reader nothing they can act
 * on. Null for anything else, so a genuinely unexpected failure still surfaces.
 */
const conflictOnDelete = (error: unknown): string | null =>
  error instanceof EzactoApiError && error.status === 409
    ? 'This definition has already raised an invoice, so it cannot be deleted. ' +
      'Edit it instead, or set its next issue date past the period you want to stop.'
    : null

/**
 * A definition that sweeps whatever is uninvoiced has no amount to state until
 * it runs, and "Set when it runs" is a sentence rather than a figure. Marking it
 * would put dots over an explanation.
 */
const amountIsKnown = (definition: Readonly<RecurringInvoice>): boolean =>
  recurringFixedTotalCents(definition) !== null

const text = (selector: string, value: string): void => {
  required<HTMLElement>(selector).textContent = value
}

type FormControl = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement

const lineField = (line: HTMLElement, field: string): FormControl => {
  const control = line.querySelector<FormControl>(`[data-recurring-line-field="${field}"]`)
  if (control === null) throw new Error(`recurring line field missing: ${field}`)
  return control
}

const option = (label: string, value: string): HTMLOptionElement => {
  const item = document.createElement('option')
  item.value = value
  item.textContent = label
  return item
}

/**
 * Options for one resource select, with whatever the definition already names
 * kept in the list even when the catalog did not return it.
 *
 * A definition outlives the client and the projects it points at, and the
 * catalog is one page-size away from being incomplete on a large account.
 * Dropping an id the select cannot show would silently rewrite the definition
 * on the next save -- the edit form would send whatever the select fell back
 * to, which is the first option.
 */
const fillOptions = (
  select: HTMLSelectElement,
  choices: readonly { readonly label: string; readonly value: string }[],
  selected: readonly string[],
  blank: string | null,
): void => {
  const values = new Set(choices.map((choice) => choice.value))
  const items = [
    ...(blank === null ? [] : [option(blank, '')]),
    ...choices.map((choice) => option(choice.label, choice.value)),
    ...selected
      .filter((value) => value !== '' && !values.has(value))
      .map((value) => option(`#${value}`, value)),
  ]
  select.replaceChildren(...items)
  for (const item of items) item.selected = selected.includes(item.value)
}

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
 *
 * New and Edit lead to the editor page (`createRecurringEditorController`
 * below), which comes back here with what it saved.
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
  const newLink = required<HTMLAnchorElement>('[data-recurring-new]')
  const editLink = required<HTMLAnchorElement>('[data-recurring-edit]')
  const deleteButton = required<HTMLButtonElement>('[data-recurring-delete]')
  const deleteDialog = required<HTMLDialogElement>('[data-recurring-delete-confirm]')
  const deleteForm = required<HTMLFormElement>('[data-recurring-delete-form]')
  const deleteBody = required<HTMLElement>('[data-recurring-delete-body]')
  const deleteResult = required<HTMLElement>('[data-recurring-delete-result]')
  const deleteSubmit = required<HTMLButtonElement>('[data-recurring-delete-submit]')
  page.hidden = !isPage
  newLink.href = recurringEditorUrl('new')

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
  /** The definition the detail view is currently showing; null while it is not showing one. */
  let detail: RecurringInvoice | null = null
  let mutationPending = false
  let deleting: number | null = null

  const current = (): ActiveSession | null =>
    activeSession === null || activeSession.signal.aborted ? null : activeSession

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

  const canWrite = (session = current()): boolean =>
    session !== null && recurringIdentityCanWrite(session.identity)

  const syncPending = (): void => {
    loadMore.disabled = listPending
    listRetry.disabled = listPending
    // Hidden rather than disabled where the build or the profile cannot write:
    // a permanently dead control is a thing an operator keeps trying. Disabled
    // is for the seconds a delete is in flight, which is a state that ends.
    newLink.hidden = !canWrite() || api.createRecurringInvoice === undefined
    editLink.hidden =
      !canWrite() ||
      api.updateRecurringInvoice === undefined ||
      api.getRecurringInvoice === undefined ||
      detail === null
    deleteButton.hidden =
      !canWrite() || api.deleteRecurringInvoice === undefined || detail === null
    for (const button of [deleteButton, deleteSubmit]) {
      button.disabled = mutationPending
    }
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
    detail = null
    deleting = null
    mutationPending = false
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
    editLink.href = recurringWorkspaceUrl()
    if (deleteDialog.open) deleteDialog.close()
    deleteResult.textContent = ''
    delete deleteResult.dataset.outcome
    syncPending()
  }

  const runDelete = async (): Promise<void> => {
    const session = current()
    const id = deleting
    if (session === null || id === null || mutationPending || !canWrite(session)) return
    if (api.deleteRecurringInvoice === undefined) return
    mutationPending = true
    syncPending()
    deleteResult.dataset.outcome = 'pending'
    deleteResult.textContent = 'Deleting…'
    try {
      await api.deleteRecurringInvoice(id, session.signal)
      if (current() !== session) return
      deleting = null
      deleteDialog.close()
      // The URL still names a definition that no longer exists, so the detail
      // is left rather than reloaded -- reloading it would answer 404 and read
      // as a failure of the delete that had just succeeded.
      globalThis.history.pushState(null, '', recurringWorkspaceUrl())
      selection = null
      detail = null
      syncView()
      await loadList(true)
      if (current() === session) listStatus.textContent = 'Definition deleted.'
    } catch (error) {
      if (current() !== session) return
      if (session.onSessionFailure(error)) return
      deleteResult.dataset.outcome = 'error'
      // The API answers a constraint refusal as an opaque `resource_conflict`,
      // deliberately -- it does not leak database text. On this operation there
      // is only one thing that conflicts, so the screen can say it rather than
      // showing the caller a sentence about financial commands.
      deleteResult.textContent = conflictOnDelete(error) ?? messageFor(error)
    } finally {
      if (current() === session) {
        mutationPending = false
        syncPending()
      }
    }
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
            render: (definition): CellContent => {
              const label = recurringAmountLabel(definition, recurringCurrency(definition, clients))
              return amountIsKnown(definition) ? moneyText(label) : label
            },
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
              render: (row) => moneyText(recurringMoney(row.line.unit_price_cents, currency)),
            },
            {
              key: 'amount',
              label: 'Amount',
              numeric: true,
              render: (row) =>
                moneyText(
                  recurringMoney(
                    Math.round(row.line.quantity * row.line.unit_price_cents),
                    currency,
                  ),
                ),
              total: (rows) =>
                moneyText(
                  recurringMoney(
                    rows.reduce(
                      (sum, row) =>
                        sum + Math.round(row.line.quantity * row.line.unit_price_cents),
                      0,
                    ),
                    currency,
                  ),
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
    const amountFact = required<HTMLElement>('[data-recurring-amount]')
    amountFact.textContent = recurringAmountLabel(definition, currency)
    markMoney(amountFact, amountIsKnown(definition))
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
    // The editor reads the definition back for itself rather than trusting this
    // copy or the list row: PATCH replaces the whole definition, and the list
    // may be a page behind. This is only what Edit and Delete act on.
    detail = definition
    editLink.href = recurringEditorUrl(definition.id)
    syncPending()
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
      issuedLink.href = invoicePagePath(result.invoice.id)
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
    // Editing what is not on screen is editing from memory, so Edit and Delete
    // go away until the definition behind them has been read back.
    detail = null
    syncPending()
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
      detail = null
      syncPending()
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
    detail = null
    syncView()
    syncPending()
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

  deleteButton.addEventListener('click', () => {
    const session = current()
    if (session === null || !canWrite(session) || detail === null || mutationPending) return
    deleting = detail.id
    deleteResult.textContent = ''
    delete deleteResult.dataset.outcome
    // Says only what is true. `invoices.recurring_invoice_id` is ON DELETE
    // RESTRICT, and a definition imported through the Harvest worksheet carries
    // a second guard besides, so a definition that has already raised an invoice
    // cannot be deleted at all -- the previous copy read as a reassurance that
    // it could, with the raised invoices left alone.
    deleteBody.textContent =
      `“${detail.subject_template}” stops billing ${recurringClientLabel(detail, clients)}. ` +
      'A definition that has already raised an invoice cannot be deleted.'
    deleteDialog.showModal()
  })
  deleteForm.addEventListener('submit', (event) => {
    event.preventDefault()
    void runDelete()
  })
  for (const cancel of document.querySelectorAll<HTMLButtonElement>(
    '[data-recurring-delete-cancel]',
  )) {
    cancel.addEventListener('click', () => {
      deleting = null
      deleteDialog.close()
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
      // What the editor saved, if this page is where it came back to. Taken
      // before the loads so a second activation cannot say it twice.
      const notice = takePageNotice(globalThis.location.pathname)
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
      if (notice === null || current() !== session) return
      // Said where the reader is looking, and only over a view that loaded: a
      // failed load's sentence is the more urgent of the two.
      if (selection !== null) {
        if (!detailBody.hidden) detailStatus.textContent = notice
      } else if (listRetry.hidden) {
        listStatus.textContent = notice
      }
    },
  }
}

export interface RecurringEditorController {
  activate(
    identity: Whoami,
    signal: AbortSignal,
    onSessionFailure: (error: unknown) => boolean,
  ): Promise<void>
}

/**
 * The definition editor page (`/invoices/recurring/new`,
 * `/invoices/recurring/:id/edit`).
 *
 * `POST`, `PATCH` and `DELETE` on this resource had been served since the API
 * shipped and no screen called any of them, so the first live definitions were
 * loaded by a script and one was corrected by hand-written SQL. This writes all
 * of a definition, the two keys migrations 0041 and 0044 added included.
 *
 * It reads the definition back itself rather than taking the workspace's copy:
 * PATCH is a replace, so a form seeded from anything stale would send the stale
 * half back as though somebody had chosen it. Saving returns to the definition
 * with what was saved said there; Cancel returns without a word.
 */
export const createRecurringEditorController = (
  api: Partial<RecurringWorkspaceApi>,
  now: () => string = () => new Date().toISOString(),
): RecurringEditorController => {
  const isPage = document.documentElement.dataset.appView === 'invoice-recurring-editor'
  const page = required<HTMLElement>('[data-recurring-editor-page]')
  const eyebrow = required<HTMLElement>('[data-recurring-editor-eyebrow]')
  const title = required<HTMLElement>('[data-recurring-editor-title]')
  const back = required<HTMLAnchorElement>('[data-recurring-editor-back]')
  const status = required<HTMLElement>('[data-recurring-editor-status]')
  const retry = required<HTMLButtonElement>('[data-recurring-editor-retry]')
  const form = required<HTMLFormElement>('[data-recurring-editor-form]')
  const cancel = required<HTMLAnchorElement>('[data-recurring-editor-cancel]')
  const submit = required<HTMLButtonElement>('[data-recurring-editor-submit]')
  const result = required<HTMLElement>('[data-recurring-editor-result]')
  const client = required<HTMLSelectElement>('[data-recurring-editor-client]')
  const clientHint = required<HTMLElement>('[data-recurring-client-hint]')
  const every = required<HTMLInputElement>('[data-recurring-editor-every]')
  const day = required<HTMLInputElement>('[data-recurring-editor-day]')
  const next = required<HTMLInputElement>('[data-recurring-editor-next]')
  const retainer = required<HTMLInputElement>('[data-recurring-editor-retainer]')
  const subject = required<HTMLInputElement>('[data-recurring-editor-subject]')
  const notes = required<HTMLTextAreaElement>('[data-recurring-editor-notes]')
  const amountTypes = [
    ...document.querySelectorAll<HTMLInputElement>('[data-recurring-editor-type]'),
  ]
  const fixedSection = required<HTMLElement>('[data-recurring-editor-fixed]')
  const bandSection = required<HTMLElement>('[data-recurring-editor-band]')
  const importSection = required<HTMLElement>('[data-recurring-editor-import]')
  const lineList = required<HTMLElement>('[data-recurring-editor-line-list]')
  const addLine = required<HTMLButtonElement>('[data-recurring-editor-add-line]')
  const total = required<HTMLElement>('[data-recurring-editor-total]')
  const lineTemplate = required<HTMLTemplateElement>('[data-recurring-line-template]')
  const sweepProjects = required<HTMLSelectElement>('[data-recurring-editor-projects]')
  // The banded picker (#484). Beside the fixed lines rather than the import
  // block, because it is the flat-amount case: these projects' hours are
  // claimed by the amount, not priced into it.
  const claims = required<HTMLSelectElement>('[data-recurring-editor-claims]')
  // How much of the period that band takes (#707), and in which unit.
  const claimMode = required<HTMLSelectElement>('[data-recurring-editor-claim-mode]')
  const claimScope = required<HTMLSelectElement>('[data-recurring-editor-claim-scope]')
  const costAlert = required<HTMLInputElement>('[data-recurring-editor-cost-alert]')
  const ceiling = required<HTMLElement>('[data-recurring-editor-ceiling]')
  const ceilingUnit = required<HTMLSelectElement>('[data-recurring-editor-ceiling-unit]')
  const ceilingAmount = required<HTMLInputElement>('[data-recurring-editor-ceiling-amount]')
  const timeOn = required<HTMLInputElement>('[data-recurring-editor-time-on]')
  const timeSummary = required<HTMLSelectElement>('[data-recurring-editor-time-summary]')
  const expensesOn = required<HTMLInputElement>('[data-recurring-editor-expenses-on]')
  const expensesSummary = required<HTMLSelectElement>('[data-recurring-editor-expenses-summary]')
  page.hidden = !isPage

  let activeSession: ActiveSession | null = null
  let target: RecurringEditorTarget | null = null
  let clients: readonly GeneralResource[] = []
  let projects: readonly GeneralResource[] = []
  let loadGeneration = 0
  let pending = false
  /**
   * Held the same way the workspace holds its issue key, and for the same
   * reason: the create is the only write here not addressed to an id, so a
   * retry under a fresh key is a second definition rather than a second
   * attempt at the first. A page load is a fresh command; a retry of this one
   * is not.
   */
  let createKey: string | null = null

  const current = (): ActiveSession | null =>
    activeSession === null || activeSession.signal.aborted ? null : activeSession

  const say = (message: string, outcome: 'error' | 'pending' | null): void => {
    result.textContent = message
    if (outcome === null) delete result.dataset.outcome
    else result.dataset.outcome = outcome
  }

  const lines = (): HTMLElement[] => [
    ...lineList.querySelectorAll<HTMLElement>('[data-recurring-line]'),
  ]

  const selectedType = (): RecurringDefinitionFormValues['amountType'] =>
    amountTypes.find((input) => input.checked)?.value === 'line_items_import'
      ? 'line_items_import'
      : 'fixed_lines'

  const currency = (): string => recurringCurrency({ client_id: Number(client.value) }, clients)

  const syncPending = (): void => {
    submit.disabled = pending
    addLine.disabled = pending
    for (const remove of lineList.querySelectorAll<HTMLButtonElement>(
      '[data-recurring-line-remove]',
    )) {
      remove.disabled = pending
    }
  }

  /**
   * Each line's amount and the total of them, in the client's currency. A line
   * that does not parse yet shows a dash and the total waits for it: a total
   * that silently left a line out is a figure nobody can check.
   */
  const syncAmounts = (): void => {
    const money = currency()
    let sum = 0
    let complete = true
    for (const line of lines()) {
      const cents = recurringLineAmountCents(readLine(line))
      const amount = line.querySelector<HTMLElement>('[data-recurring-line-amount]')
      if (amount !== null) {
        amount.textContent = cents === null ? '—' : recurringMoney(cents, money)
        markMoney(amount, cents !== null)
      }
      if (cents === null) complete = false
      else sum += cents
    }
    total.textContent = complete && lines().length > 0 ? recurringMoney(sum, money) : '—'
    markMoney(total, complete && lines().length > 0)
  }

  const syncLinePositions = (): void => {
    lines().forEach((line, position) => {
      // Numbered from 1 to match `recurringDefinitionInput`, whose messages say
      // "Line 2 needs a quantity" -- an editor that counts differently from the
      // sentence pointing at it sends someone to the wrong row.
      const legend = line.querySelector<HTMLElement>('[data-recurring-line-position]')
      if (legend !== null) legend.textContent = `Line ${position + 1}`
      const number = line.querySelector<HTMLElement>('[data-recurring-line-number]')
      if (number !== null) number.textContent = String(position + 1)
    })
    syncPending()
  }

  const readLine = (line: HTMLElement): RecurringLineFormValues => ({
    kind: lineField(line, 'kind').value,
    description: lineField(line, 'description').value,
    quantity: lineField(line, 'quantity').value,
    unitPriceCents: lineField(line, 'unitPriceCents').value,
    taxed: (lineField(line, 'taxed') as HTMLInputElement).checked,
    taxed2: (lineField(line, 'taxed2') as HTMLInputElement).checked,
    projectId: lineField(line, 'projectId').value,
    through: lineField(line, 'through').value,
    installments: lineField(line, 'installments').value,
  })

  const appendLine = (values: Readonly<RecurringLineFormValues>): HTMLElement => {
    const source = lineTemplate.content.firstElementChild
    if (source === null) throw new Error('recurring line template is empty')
    const line = source.cloneNode(true) as HTMLElement
    lineField(line, 'kind').value = values.kind
    lineField(line, 'description').value = values.description
    lineField(line, 'quantity').value = values.quantity
    lineField(line, 'unitPriceCents').value = values.unitPriceCents
    lineField(line, 'through').value = values.through
    lineField(line, 'installments').value = values.installments
    ;(lineField(line, 'taxed') as HTMLInputElement).checked = values.taxed
    ;(lineField(line, 'taxed2') as HTMLInputElement).checked = values.taxed2
    fillOptions(
      lineField(line, 'projectId') as HTMLSelectElement,
      projects.map((project) => ({
        label: recurringProjectLabel(project.id, projects),
        value: String(project.id),
      })),
      [values.projectId],
      'No project',
    )
    line.querySelector<HTMLButtonElement>('[data-recurring-line-remove]')?.addEventListener(
      'click',
      () => {
        if (pending) return
        const following = line.nextElementSibling
        line.remove()
        syncLinePositions()
        syncAmounts()
        // Focus goes where the row was rather than back to the top of the page.
        const landing =
          following?.querySelector<HTMLElement>('[data-recurring-line-field="kind"]') ?? addLine
        landing.focus()
      },
    )
    lineList.append(line)
    syncLinePositions()
    return line
  }

  // The ceiling boxes only mean anything once a band claims to one, and a
  // number sitting in a hidden box is a number somebody will later assume
  // applied.
  const syncClaimMode = (): void => {
    ceiling.hidden = claimMode.value !== 'ceiling'
  }

  const syncAmountType = (): void => {
    const fixed = selectedType() !== 'line_items_import'
    fixedSection.hidden = !fixed
    bandSection.hidden = !fixed
    importSection.hidden = fixed
  }

  const readForm = (): RecurringDefinitionFormValues => ({
    clientId: client.value,
    subjectTemplate: subject.value,
    notesTemplate: notes.value,
    everyNMonths: every.value,
    dayOfMonth: day.value,
    nextIssueOn: next.value,
    retainerId: retainer.value,
    amountType: selectedType(),
    lines: lines().map(readLine),
    projectIds: [...sweepProjects.options]
      .filter((item) => item.selected)
      .map((item) => item.value),
    claimsProjectIds: [...claims.options]
      .filter((item) => item.selected)
      .map((item) => item.value),
    claimMode: claimMode.value === 'ceiling' ? 'ceiling' : 'all',
    claimCeilingUnit: ceilingUnit.value === 'money' ? 'money' : 'time',
    claimCeiling: ceilingAmount.value,
    claimScope: claimScope.value === 'tracked' ? 'tracked' : 'billable',
    costAlertPercent: costAlert.value,
    importTime: timeOn.checked,
    timeSummary: timeSummary.value,
    importExpenses: expensesOn.checked,
    expenseSummary: expensesSummary.value,
  })

  const fillForm = (values: Readonly<RecurringDefinitionFormValues>): void => {
    fillOptions(
      client,
      clients.map((resource) => ({
        label: recurringClientLabel({ client_id: resource.id }, clients),
        value: String(resource.id),
      })),
      [values.clientId],
      'Choose a client',
    )
    subject.value = values.subjectTemplate
    notes.value = values.notesTemplate
    every.value = values.everyNMonths
    day.value = values.dayOfMonth
    next.value = values.nextIssueOn
    retainer.value = values.retainerId
    for (const input of amountTypes) input.checked = input.value === values.amountType
    lineList.replaceChildren()
    for (const line of values.lines) appendLine(line)
    const projectChoices = projects.map((project) => ({
      label: recurringProjectLabel(project.id, projects),
      value: String(project.id),
    }))
    fillOptions(sweepProjects, projectChoices, values.projectIds, null)
    fillOptions(claims, projectChoices, values.claimsProjectIds, null)
    // As tall as the account's projects, within reason: six empty rows under
    // two projects read as a list still loading.
    for (const list of [sweepProjects, claims]) {
      list.size = Math.min(Math.max(list.options.length, 3), 8)
    }
    claimScope.value = values.claimScope
    costAlert.value = values.costAlertPercent
    claimMode.value = values.claimMode
    ceilingUnit.value = values.claimCeilingUnit
    ceilingAmount.value = values.claimCeiling
    syncClaimMode()
    timeOn.checked = values.importTime
    timeSummary.value = values.timeSummary
    expensesOn.checked = values.importExpenses
    expensesSummary.value = values.expenseSummary
    syncAmountType()
    syncAmounts()
  }

  const clearPrivatePresentation = (): void => {
    loadGeneration += 1
    clients = []
    projects = []
    pending = false
    createKey = null
    // The form holds a client's name, an amount and a schedule, so it goes
    // with the session rather than standing on the page after it.
    form.hidden = true
    form.reset()
    lineList.replaceChildren()
    client.replaceChildren()
    sweepProjects.replaceChildren()
    claims.replaceChildren()
    total.textContent = '—'
    say('', null)
    retry.hidden = true
    status.textContent = 'Loading the editor…'
    syncPending()
  }

  const showTarget = (editing: RecurringEditorTarget): void => {
    const returnTo = recurringEditorReturnUrl(editing)
    back.href = returnTo
    back.textContent = editing === 'new' ? 'Back to recurring' : 'Back to the definition'
    cancel.href = returnTo
    title.textContent = editing === 'new' ? 'New recurring invoice' : 'Edit recurring invoice'
    // `recurring_invoices_linked_invoice_client_update` aborts a client change
    // whenever a linked invoice names a different one, and the API reports it
    // as the same opaque conflict as everything else. Nothing on the payload
    // says whether this definition has billed, so the control stays usable --
    // a definition that never issued may legitimately move -- and says what
    // the constraint is rather than letting the reader discover it on save.
    clientHint.hidden = editing === 'new'
    document.title = document.title.replace(
      / — .*$/u,
      editing === 'new' ? ' — New recurring invoice' : ' — Edit recurring invoice',
    )
  }

  const load = async (): Promise<void> => {
    const session = current()
    const editing = target
    if (session === null || editing === null) return
    const generation = ++loadGeneration
    form.hidden = true
    retry.hidden = true
    status.textContent = editing === 'new' ? 'Loading clients and projects…' : 'Loading the definition…'
    try {
      const [loadedClients, loadedProjects, definition] = await Promise.all([
        api.listRecurringClients === undefined
          ? Promise.resolve<GeneralResource[]>([])
          : collect(api.listRecurringClients, session.signal),
        api.listRecurringProjects === undefined
          ? Promise.resolve<GeneralResource[]>([])
          : collect(api.listRecurringProjects, session.signal),
        editing === 'new' ? Promise.resolve(null) : api.getRecurringInvoice!(editing, session.signal),
      ])
      if (current() !== session || generation !== loadGeneration) return
      clients = loadedClients
      projects = loadedProjects
      fillForm(
        definition === null
          ? { ...recurringBlankFormValues(), nextIssueOn: now().slice(0, 10) }
          : recurringFormValuesFromDefinition(definition),
      )
      eyebrow.textContent =
        definition === null
          ? 'Recurring invoice'
          : `${recurringClientLabel(definition, clients)} · Recurring invoice`
      status.textContent = ''
      form.hidden = false
    } catch (error) {
      if (current() !== session || generation !== loadGeneration) return
      if (session.onSessionFailure(error)) return
      status.textContent = messageFor(error)
      retry.hidden = false
    }
  }

  const save = async (): Promise<void> => {
    const session = current()
    const editing = target
    if (session === null || editing === null || pending || !recurringIdentityCanWrite(session.identity)) {
      return
    }
    let input: RecurringInvoiceInput
    try {
      input = recurringDefinitionInput(readForm())
    } catch (error) {
      // Refused before the request, and named. `assertRecurringAmountConfig`
      // and the 0044 trigger both refuse the same configs, but neither can say
      // which line was wrong by the time their message reaches a browser.
      say(messageFor(error), 'error')
      return
    }
    pending = true
    syncPending()
    say('Saving…', 'pending')
    try {
      let saved: RecurringInvoice
      if (editing === 'new') {
        // `??=`, not `=`, exactly as the workspace holds its issue key: a save
        // that fails after the server took it must retry under the key it
        // already used, or the retry is a second definition rather than a
        // second attempt at the first.
        createKey ??= globalThis.crypto.randomUUID()
        saved = await api.createRecurringInvoice!(input, createKey, session.signal)
        createKey = null
      } else {
        saved = await api.updateRecurringInvoice!(editing, input, session.signal)
      }
      if (current() !== session) return
      leavePageNotice(
        recurringWorkspaceUrl(),
        editing === 'new' ? 'Definition created.' : 'Definition saved.',
      )
      say('Saved. Opening the definition…', 'pending')
      globalThis.location.assign(recurringWorkspaceUrl(saved.id))
    } catch (error) {
      if (current() !== session) return
      if (session.onSessionFailure(error)) return
      say(messageFor(error), 'error')
    } finally {
      if (current() === session) {
        pending = false
        syncPending()
      }
    }
  }

  const clearResult = (): void => {
    if (!pending) say('', null)
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void save()
  })
  form.addEventListener('input', clearResult)
  lineList.addEventListener('input', syncAmounts)
  client.addEventListener('change', syncAmounts)
  claimMode.addEventListener('change', () => {
    syncClaimMode()
    clearResult()
  })
  for (const input of amountTypes) {
    input.addEventListener('change', () => {
      syncAmountType()
      clearResult()
    })
  }
  addLine.addEventListener('click', () => {
    if (pending) return
    const line = appendLine(recurringBlankLine())
    syncAmounts()
    lineField(line, 'description').focus()
  })
  retry.addEventListener('click', () => {
    void load()
  })

  return {
    async activate(identity, signal, onSessionFailure) {
      if (!isPage) return
      const session = { identity, signal, onSessionFailure }
      activeSession = session
      clearPrivatePresentation()
      target = recurringEditorTargetFromPathname(globalThis.location.pathname)
      signal.addEventListener(
        'abort',
        () => {
          if (activeSession !== session) return
          activeSession = null
          clearPrivatePresentation()
          status.textContent = 'Sign in to edit recurring invoices.'
        },
        { once: true },
      )
      if (target === null) {
        status.textContent = 'That recurring definition does not exist.'
        return
      }
      showTarget(target)
      if (!recurringIdentityCanWrite(identity)) {
        status.textContent =
          identity.authentication.kind === 'token'
            ? 'This API token cannot change recurring invoices.'
            : 'Your profile cannot change recurring invoices.'
        return
      }
      const writable =
        target === 'new'
          ? api.createRecurringInvoice !== undefined
          : api.updateRecurringInvoice !== undefined && api.getRecurringInvoice !== undefined
      if (!writable) {
        status.textContent =
          target === 'new'
            ? 'This build cannot create recurring invoices.'
            : 'This build cannot edit recurring invoices.'
        return
      }
      await load()
    },
  }
}
