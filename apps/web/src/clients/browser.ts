import { renderDataTable } from '../components/data-table.js'
import { EzactoApiError, type GeneralResource, type Whoami } from '@ezacto/client'
import {
  clientDisplayName,
  clientHierarchy,
  clientIdFromPathname,
  clientIsActive,
  clientNumber,
  clientProfileCanWrite,
  clientText,
  relationLabel,
  type ClientDirectoryApi,
  type ClientDirectoryPage,
} from './model.js'

const required = <ElementType extends Element>(selector: string): ElementType => {
  const element = document.querySelector<ElementType>(selector)
  if (element === null) throw new Error(`client directory element missing: ${selector}`)
  return element
}

const messageFor = (error: unknown): string => {
  if (error instanceof EzactoApiError && typeof error.body === 'object' && error.body !== null) {
    const detail = Reflect.get(error.body, 'error')
    if (typeof detail === 'object' && detail !== null) {
      const fields = Reflect.get(detail, 'fields')
      if (Array.isArray(fields)) {
        const field = fields.find(
          (candidate) =>
            typeof candidate === 'object' &&
            candidate !== null &&
            typeof Reflect.get(candidate, 'message') === 'string',
        )
        if (field !== undefined) return String(Reflect.get(field, 'message'))
      }
      const message = Reflect.get(detail, 'message')
      if (typeof message === 'string' && message.trim() !== '') return message
    }
  }
  return error instanceof Error ? error.message : 'The request could not be completed.'
}

const collect = async (
  load: (cursor?: string) => Promise<ClientDirectoryPage>,
  signal: AbortSignal,
): Promise<GeneralResource[]> => {
  const resources: GeneralResource[] = []
  let cursor: string | undefined
  do {
    signal.throwIfAborted()
    const page = await load(cursor)
    resources.push(...page.data)
    cursor = page.page.next_cursor ?? undefined
  } while (cursor !== undefined)
  return resources
}

const setText = (selector: string, text: string): void => {
  required<HTMLElement>(selector).textContent = text
}

const optionalNumber = (data: FormData, name: string): number | null => {
  const raw = data.get(name)
  if (typeof raw !== 'string' || raw === '') return null
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be zero or greater.`)
  return value
}

const optionalText = (data: FormData, name: string): string | null => {
  const raw = data.get(name)
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null
}

const relationId = (data: FormData, name: string): number | null => {
  const raw = data.get(name)
  if (typeof raw !== 'string' || raw === '') return null
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} is invalid.`)
  return value
}

const field = (
  form: HTMLFormElement,
  name: string,
): HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement => {
  const result = form.elements.namedItem(name)
  if (
    !(result instanceof HTMLInputElement) &&
    !(result instanceof HTMLTextAreaElement) &&
    !(result instanceof HTMLSelectElement)
  ) {
    throw new Error(`client directory form field missing: ${name}`)
  }
  return result
}

const valueFor = (resource: GeneralResource, name: string): string => {
  const value = resource[name]
  return value === null || value === undefined ? '' : String(value)
}

const recipientLabel = (status: string | null): string => {
  if (status === 'recipient') return 'Invoice recipient'
  if (status === 'cc') return 'Invoice CC'
  if (status === 'bcc') return 'Invoice BCC'
  return 'Not an invoice recipient'
}

const paymentTermsLabel = (value: string | null): string => {
  if (value === null) return 'Custom'
  if (value === 'upon_receipt') return 'Upon receipt'
  if (value.startsWith('net_')) return `Net ${value.slice(4)}`
  return value[0]!.toLocaleUpperCase('en-US') + value.slice(1).replaceAll('_', ' ')
}

const percentLabel = (value: unknown): string =>
  typeof value === 'number' && Number.isFinite(value) ? `${value}%` : 'None'

interface ActiveSession {
  readonly identity: Whoami
  readonly signal: AbortSignal
  readonly onSessionFailure: (error: unknown) => boolean
}

export interface ClientDirectoryController {
  activate(
    identity: Whoami,
    signal: AbortSignal,
    onSessionFailure: (error: unknown) => boolean,
  ): Promise<void>
}

export const createClientDirectoryController = (
  api: Partial<ClientDirectoryApi>,
): ClientDirectoryController => {
  const listPage = document.documentElement.dataset.appView === 'client-list'
  const detailPage = document.documentElement.dataset.appView === 'client-detail'
  const listPageElement = required<HTMLElement>('[data-client-list-page]')
  const detailPageElement = required<HTMLElement>('[data-client-detail-page]')
  const listStatus = required<HTMLElement>('[data-client-list-status]')
  const detailStatus = required<HTMLElement>('[data-client-detail-status]')
  const tree = required<HTMLElement>('[data-client-tree]')
  const listRetry = required<HTMLButtonElement>('[data-client-list-retry]')
  const detailRetry = required<HTMLButtonElement>('[data-client-detail-retry]')
  const detail = required<HTMLElement>('[data-client-detail]')
  const projectsList = required<HTMLElement>('[data-client-projects]')
  const contactsList = required<HTMLElement>('[data-client-contacts]')
  const clientFormDialog = required<HTMLDialogElement>('[data-client-form-dialog]')
  const clientForm = required<HTMLFormElement>('[data-client-form]')
  const clientFormTitle = required<HTMLElement>('[data-client-form-title]')
  const clientFormResult = required<HTMLElement>('[data-client-form-result]')
  const clientFormSubmit = required<HTMLButtonElement>('[data-client-form-submit]')
  const contactFormDialog = required<HTMLDialogElement>('[data-contact-form-dialog]')
  const contactForm = required<HTMLFormElement>('[data-contact-form]')
  const contactFormTitle = required<HTMLElement>('[data-contact-form-title]')
  const contactFormResult = required<HTMLElement>('[data-contact-form-result]')
  const contactFormSubmit = required<HTMLButtonElement>('[data-contact-form-submit]')
  const clientArchiveDialog = required<HTMLDialogElement>('[data-client-archive-dialog]')
  const clientArchiveForm = required<HTMLFormElement>('[data-client-archive-form]')
  const clientArchiveResult = required<HTMLElement>('[data-client-archive-result]')
  const contactDeleteDialog = required<HTMLDialogElement>('[data-contact-delete-dialog]')
  const contactDeleteForm = required<HTMLFormElement>('[data-contact-delete-form]')
  const contactDeleteResult = required<HTMLElement>('[data-contact-delete-result]')

  listPageElement.hidden = !listPage
  detailPageElement.hidden = !detailPage

  let session: ActiveSession | null = null
  let clients: readonly GeneralResource[] = []
  let contacts: readonly GeneralResource[] = []
  let projects: readonly GeneralResource[] = []
  let currentClient: GeneralResource | null = null
  let clientFilter: 'active' | 'all' = 'active'
  let editingClientId: number | null = null
  let editingContactId: number | null = null
  let deletingContactId: number | null = null
  let mutationPending = false

  const resetMutationState = (): void => {
    mutationPending = false
    editingClientId = null
    editingContactId = null
    deletingContactId = null
    clientFormSubmit.disabled = false
    contactFormSubmit.disabled = false
    required<HTMLButtonElement>('[data-client-archive-confirm]').disabled = false
    required<HTMLButtonElement>('[data-contact-delete-confirm]').disabled = false
  }

  const clearPrivatePresentation = (): void => {
    clients = []
    contacts = []
    projects = []
    currentClient = null
    tree.replaceChildren()
    projectsList.replaceChildren()
    contactsList.replaceChildren()
    detail.hidden = true
    listStatus.textContent = 'Loading clients…'
    detailStatus.textContent = 'Loading client…'
    listRetry.hidden = true
    detailRetry.hidden = true
  }

  const currentSession = (): ActiveSession | null =>
    session === null || session.signal.aborted ? null : session

  const enableWrites = (enabled: boolean): void => {
    for (const element of document.querySelectorAll<HTMLElement>('[data-client-write]')) {
      element.hidden = !enabled
      if (element instanceof HTMLButtonElement) element.disabled = !enabled
    }
  }

  const handleFailure = (error: unknown): boolean => {
    const active = currentSession()
    return active !== null && active.onSessionFailure(error)
  }

  const option = (client: GeneralResource): HTMLOptionElement => {
    const item = document.createElement('option')
    item.value = String(client.id)
    item.textContent = `${clientDisplayName(client)}${clientIsActive(client) ? '' : ' (archived)'}`
    return item
  }

  const populateClientRelations = (selected: GeneralResource | null): void => {
    const parent = field(clientForm, 'parent_client_id') as HTMLSelectElement
    const billTo = field(clientForm, 'bill_to_client_id') as HTMLSelectElement
    const available = clients.filter((client) => client.id !== selected?.id)
    const noneOption = (): HTMLOptionElement => {
      const item = document.createElement('option')
      item.value = ''
      item.textContent = 'None'
      return item
    }
    parent.replaceChildren(noneOption(), ...available.map(option))
    billTo.replaceChildren(noneOption(), ...available.map(option))
    parent.value = valueFor(selected ?? ({} as GeneralResource), 'parent_client_id')
    billTo.value = valueFor(selected ?? ({} as GeneralResource), 'bill_to_client_id')
  }

  const renderTree = (): void => {
    const visible =
      clientFilter === 'active' ? clients.filter((client) => clientIsActive(client)) : clients
    if (visible.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'client-tree-empty'
      empty.textContent =
        clientFilter === 'active'
          ? 'No active clients yet.'
          : 'No clients have been created or imported yet.'
      tree.replaceChildren(empty)
      listStatus.textContent = empty.textContent
      return
    }
    const rows = clientHierarchy(visible)
    tree.replaceChildren(
      renderDataTable<{ client: GeneralResource; depth: number }>({
        caption: 'Clients',
        rows,
        rowKey: ({ client }) => String(client.id),
        columns: [
          {
            key: 'client',
            label: 'Client',
            render: ({ client, depth }) => {
              const cell = document.createElement('div')
              cell.className = 'client-tree-name'
              // A child sits under its parent, so the name carries the depth.
              cell.style.paddingInlineStart = `${Math.min(depth, 4) * 16}px`
              const link = document.createElement('a')
              link.href = `/clients/${client.id}`
              link.textContent = clientDisplayName(client)
              cell.append(link)
              if (!clientIsActive(client)) {
                const archived = document.createElement('span')
                archived.className = 'client-status-pill'
                archived.textContent = 'Archived'
                cell.append(archived)
              }
              return cell
            },
          },
          {
            key: 'parent',
            label: 'Worked-for parent',
            render: ({ client }) => {
              const parentId = clientNumber(client, 'parent_client_id')
              return parentId === null
                ? '—'
                : `Worked-for parent: ${relationLabel(parentId, clients)}`
            },
          },
          {
            key: 'bill-to',
            label: 'Bill-to client',
            render: ({ client }) => {
              const billToId = clientNumber(client, 'bill_to_client_id')
              return billToId === null
                ? '—'
                : `Bill-to client: ${relationLabel(billToId, clients)}`
            },
          },
        ],
      }),
    )
    listStatus.textContent = `${visible.length} ${visible.length === 1 ? 'client' : 'clients'} shown.`
  }

  const renderProjects = (): void => {
    if (projects.length === 0) {
      const empty = document.createElement('li')
      empty.className = 'client-related-empty'
      empty.textContent = 'No projects are associated with this client.'
      projectsList.replaceChildren(empty)
      return
    }
    projectsList.replaceChildren(
      renderDataTable<GeneralResource>({
        caption: 'Projects for this client',
        rows: projects,
        rowKey: (project) => String(project.id),
        empty: 'No projects for this client.',
        columns: [
          {
            key: 'name',
            label: 'Project',
            render: (project) => {
              const name = clientText(project, 'name') ?? `Project #${project.id}`
              const code = clientText(project, 'code')
              return code === null ? name : `[${code}] ${name}`
            },
          },
          {
            key: 'billing',
            label: 'Billing',
            render: (project) =>
              clientText(project, 'billing_method')?.replaceAll('_', ' ') ?? '—',
          },
          {
            key: 'status',
            label: 'Status',
            render: (project) => (project['is_active'] === false ? 'Archived' : 'Active'),
          },
        ],
      }),
    )
  }

  const openContactForm = (contact: GeneralResource | null): void => {
    const active = currentSession()
    if (
      active === null ||
      !clientProfileCanWrite(active.identity.profile) ||
      currentClient === null
    ) {
      return
    }
    editingContactId = contact?.id ?? null
    contactForm.reset()
    contactFormTitle.textContent = contact === null ? 'Add contact' : 'Edit contact'
    contactFormSubmit.textContent = contact === null ? 'Add contact' : 'Save contact'
    contactFormResult.textContent = ''
    if (contact !== null) {
      for (const name of [
        'title',
        'first_name',
        'last_name',
        'email',
        'phone_office',
        'phone_mobile',
        'fax',
        'invoice_recipient_status',
      ]) {
        field(contactForm, name).value = valueFor(contact, name)
      }
    }
    contactFormDialog.showModal()
    field(contactForm, 'first_name').focus()
  }

  const renderContacts = (): void => {
    if (contacts.length === 0) {
      const empty = document.createElement('li')
      empty.className = 'client-related-empty'
      empty.textContent = 'No contacts have been added for this client.'
      contactsList.replaceChildren(empty)
      return
    }
    const canWrite = session !== null && clientProfileCanWrite(session.identity.profile)
    const contactName = (contact: GeneralResource): string =>
      [
        clientText(contact, 'title'),
        clientText(contact, 'first_name'),
        clientText(contact, 'last_name'),
      ]
        .filter((value): value is string => value !== null)
        .join(' ') || `Contact #${contact.id}`

    contactsList.replaceChildren(
      renderDataTable<GeneralResource>({
        caption: 'Contacts for this client',
        rows: contacts,
        rowKey: (contact) => String(contact.id),
        empty: 'No contacts have been added for this client.',
        columns: [
          { key: 'name', label: 'Contact', render: contactName },
          { key: 'email', label: 'Email', render: (c) => clientText(c, 'email') ?? '—' },
          {
            key: 'phone',
            label: 'Phone',
            render: (c) =>
              [clientText(c, 'phone_office'), clientText(c, 'phone_mobile')]
                .filter((value): value is string => value !== null)
                .join(' · ') || '—',
          },
          {
            key: 'recipient',
            label: 'Invoices',
            render: (contact) => {
              const pill = document.createElement('span')
              pill.className = 'client-recipient-pill'
              pill.dataset.recipientStatus =
                clientText(contact, 'invoice_recipient_status') ?? 'none'
              pill.textContent = recipientLabel(clientText(contact, 'invoice_recipient_status'))
              return pill
            },
          },
        ],
        ...(canWrite
          ? {
              actions: (contact) => [
                {
                  label: 'Edit',
                  primary: true,
                  onSelect: () => openContactForm(contact),
                },
                {
                  label: 'Delete',
                  onSelect: () => {
                    deletingContactId = contact.id
                    contactDeleteResult.textContent = ''
                    contactDeleteDialog.showModal()
                  },
                },
              ],
            }
          : {}),
      }),
    )
  }

  const renderDetail = (): void => {
    if (currentClient === null) return
    document.title = `${document.documentElement.dataset.brand ?? 'ezacto'} — ${clientDisplayName(currentClient)}`
    setText('[data-client-detail-name]', clientDisplayName(currentClient))
    setText('[data-client-detail-active]', clientIsActive(currentClient) ? 'Active' : 'Archived')
    setText('[data-client-detail-currency]', clientText(currentClient, 'currency') ?? '—')
    setText(
      '[data-client-detail-parent]',
      relationLabel(clientNumber(currentClient, 'parent_client_id'), clients),
    )
    setText(
      '[data-client-detail-bill-to]',
      relationLabel(clientNumber(currentClient, 'bill_to_client_id'), clients),
    )
    setText(
      '[data-client-detail-terms]',
      paymentTermsLabel(clientText(currentClient, 'payment_terms')),
    )
    setText('[data-client-detail-tax]', percentLabel(currentClient['default_tax_pct']))
    setText('[data-client-detail-tax2]', percentLabel(currentClient['default_tax2_pct']))
    setText('[data-client-detail-discount]', percentLabel(currentClient['default_discount_pct']))
    setText('[data-client-detail-address]', clientText(currentClient, 'address') ?? 'None')
    renderProjects()
    renderContacts()
    detail.hidden = false
    detailStatus.textContent = 'Client details loaded.'
  }

  const loadClients = async (active: ActiveSession): Promise<GeneralResource[]> => {
    if (api.listDirectoryClients === undefined) throw new Error('Client directory is unavailable in this build.')
    return collect(
      (cursor) => api.listDirectoryClients!(cursor, active.signal),
      active.signal,
    )
  }

  const refreshList = async (): Promise<void> => {
    const active = currentSession()
    if (active === null || !listPage) return
    listStatus.textContent = 'Loading clients…'
    tree.setAttribute('aria-busy', 'true')
    listRetry.hidden = true
    try {
      clients = await loadClients(active)
      if (currentSession() !== active) return
      renderTree()
    } catch (error) {
      if (handleFailure(error)) return
      listStatus.textContent = messageFor(error)
      tree.replaceChildren()
      listRetry.hidden = false
    } finally {
      if (currentSession() === active) tree.removeAttribute('aria-busy')
    }
  }

  const refreshDetail = async (): Promise<void> => {
    const active = currentSession()
    if (active === null || !detailPage) return
    const id = clientIdFromPathname(globalThis.location.pathname)
    if (
      id === null ||
      api.getDirectoryClient === undefined ||
      api.listClientContacts === undefined ||
      api.listClientProjects === undefined
    ) {
      detailStatus.textContent = 'Client detail is unavailable in this build.'
      detail.hidden = true
      return
    }
    detailStatus.textContent = 'Loading client…'
    detail.setAttribute('aria-busy', 'true')
    detail.hidden = true
    detailRetry.hidden = true
    try {
      const [allClients, selected, selectedContacts, selectedProjects] = await Promise.all([
        loadClients(active),
        api.getDirectoryClient(id, active.signal),
        collect(
          (cursor) => api.listClientContacts!(id, cursor, active.signal),
          active.signal,
        ),
        collect(
          (cursor) => api.listClientProjects!(id, cursor, active.signal),
          active.signal,
        ),
      ])
      if (currentSession() !== active) return
      clients = allClients
      currentClient = selected
      contacts = selectedContacts
      projects = selectedProjects
      renderDetail()
    } catch (error) {
      if (handleFailure(error)) return
      detailStatus.textContent = messageFor(error)
      detail.hidden = true
      detailRetry.hidden = false
    } finally {
      if (currentSession() === active) detail.removeAttribute('aria-busy')
    }
  }

  const openClientForm = (client: GeneralResource | null): void => {
    const active = currentSession()
    if (active === null || !clientProfileCanWrite(active.identity.profile)) return
    editingClientId = client?.id ?? null
    clientForm.reset()
    clientFormTitle.textContent = client === null ? 'Add client' : 'Edit client'
    clientFormSubmit.textContent = client === null ? 'Add client' : 'Save client'
    clientFormResult.textContent = ''
    if (client !== null) {
      for (const name of [
        'name',
        'address',
        'currency',
        'payment_terms',
        'default_tax_pct',
        'default_tax2_pct',
        'default_discount_pct',
      ]) {
        field(clientForm, name).value = valueFor(client, name)
      }
    } else {
      field(clientForm, 'payment_terms').value = 'custom'
    }
    populateClientRelations(client)
    clientFormDialog.showModal()
    field(clientForm, 'name').focus()
  }

  for (const close of document.querySelectorAll<HTMLButtonElement>('[data-client-dialog-close]')) {
    close.addEventListener('click', () => clientFormDialog.close())
  }
  for (const close of document.querySelectorAll<HTMLButtonElement>('[data-contact-dialog-close]')) {
    close.addEventListener('click', () => contactFormDialog.close())
  }
  required<HTMLButtonElement>('[data-client-create]').addEventListener('click', () =>
    openClientForm(null),
  )
  required<HTMLButtonElement>('[data-client-edit]').addEventListener('click', () =>
    openClientForm(currentClient),
  )
  required<HTMLButtonElement>('[data-contact-create]').addEventListener('click', () =>
    openContactForm(null),
  )
  required<HTMLButtonElement>('[data-client-archive]').addEventListener('click', () => {
    if (currentClient === null) return
    clientArchiveResult.textContent = ''
    clientArchiveDialog.showModal()
  })
  listRetry.addEventListener('click', () => void refreshList())
  detailRetry.addEventListener('click', () => void refreshDetail())
  for (const filter of document.querySelectorAll<HTMLButtonElement>('[data-client-filter]')) {
    filter.addEventListener('click', () => {
      clientFilter = filter.dataset.clientFilter === 'all' ? 'all' : 'active'
      for (const button of document.querySelectorAll<HTMLButtonElement>('[data-client-filter]')) {
        button.setAttribute('aria-pressed', String(button === filter))
      }
      renderTree()
    })
  }

  clientForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const active = currentSession()
    if (
      active === null ||
      mutationPending ||
      !clientProfileCanWrite(active.identity.profile) ||
      api.createDirectoryClient === undefined ||
      api.updateDirectoryClient === undefined
    ) {
      return
    }
    const data = new FormData(clientForm)
    const name = optionalText(data, 'name')
    if (name === null) {
      clientFormResult.textContent = 'Enter a client name.'
      field(clientForm, 'name').focus()
      return
    }
    let input: Record<string, unknown>
    try {
      const currency = optionalText(data, 'currency')
      input = {
        name,
        address: optionalText(data, 'address'),
        ...(currency === null ? {} : { currency: currency.toLocaleUpperCase('en-US') }),
        parent_client_id: relationId(data, 'parent_client_id'),
        bill_to_client_id: relationId(data, 'bill_to_client_id'),
        payment_terms: optionalText(data, 'payment_terms') ?? 'custom',
        default_tax_pct: optionalNumber(data, 'default_tax_pct'),
        default_tax2_pct: optionalNumber(data, 'default_tax2_pct'),
        default_discount_pct: optionalNumber(data, 'default_discount_pct'),
      }
    } catch (error) {
      clientFormResult.textContent = messageFor(error)
      return
    }
    mutationPending = true
    clientFormSubmit.disabled = true
    clientFormResult.textContent = editingClientId === null ? 'Adding client…' : 'Saving client…'
    const request =
      editingClientId === null
        ? api.createDirectoryClient(input, active.signal)
        : api.updateDirectoryClient(editingClientId, input, active.signal)
    request
      .then(async (saved) => {
        if (currentSession() !== active) return
        clients = await loadClients(active)
        if (currentSession() !== active) return
        currentClient = detailPage ? saved : currentClient
        clientFormDialog.close()
        if (listPage) renderTree()
        if (detailPage) renderDetail()
        ;(listPage ? listStatus : detailStatus).textContent =
          editingClientId === null ? 'Client added.' : 'Client updated.'
      })
      .catch((error: unknown) => {
        if (!handleFailure(error)) clientFormResult.textContent = messageFor(error)
      })
      .finally(() => {
        if (currentSession() === active) {
          mutationPending = false
          clientFormSubmit.disabled = false
        }
      })
  })

  contactForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const active = currentSession()
    if (
      active === null ||
      currentClient === null ||
      mutationPending ||
      !clientProfileCanWrite(active.identity.profile) ||
      api.createClientContact === undefined ||
      api.updateClientContact === undefined
    ) {
      return
    }
    const data = new FormData(contactForm)
    const firstName = optionalText(data, 'first_name')
    if (firstName === null) {
      contactFormResult.textContent = 'Enter a first name.'
      field(contactForm, 'first_name').focus()
      return
    }
    const input = {
      client_id: currentClient.id,
      title: optionalText(data, 'title'),
      first_name: firstName,
      last_name: optionalText(data, 'last_name'),
      email: optionalText(data, 'email'),
      phone_office: optionalText(data, 'phone_office'),
      phone_mobile: optionalText(data, 'phone_mobile'),
      fax: optionalText(data, 'fax'),
      invoice_recipient_status: optionalText(data, 'invoice_recipient_status') ?? 'none',
    }
    mutationPending = true
    contactFormSubmit.disabled = true
    contactFormResult.textContent = editingContactId === null ? 'Adding contact…' : 'Saving contact…'
    const request =
      editingContactId === null
        ? api.createClientContact(input, active.signal)
        : api.updateClientContact(editingContactId, input, active.signal)
    request
      .then(async () => {
        if (currentSession() !== active) return
        contacts = await collect(
          (cursor) => api.listClientContacts!(currentClient!.id, cursor, active.signal),
          active.signal,
        )
        if (currentSession() !== active) return
        contactFormDialog.close()
        renderContacts()
        detailStatus.textContent = editingContactId === null ? 'Contact added.' : 'Contact updated.'
      })
      .catch((error: unknown) => {
        if (!handleFailure(error)) contactFormResult.textContent = messageFor(error)
      })
      .finally(() => {
        if (currentSession() === active) {
          mutationPending = false
          contactFormSubmit.disabled = false
        }
      })
  })

  clientArchiveForm.addEventListener('submit', (event) => {
    const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null
    if (submitter?.value !== 'confirm') return
    event.preventDefault()
    const active = currentSession()
    if (
      active === null ||
      currentClient === null ||
      mutationPending ||
      api.archiveDirectoryClient === undefined
    ) {
      return
    }
    mutationPending = true
    submitter.disabled = true
    clientArchiveResult.textContent = 'Archiving client…'
    api.archiveDirectoryClient(currentClient.id, active.signal)
      .then(() => {
        if (currentSession() !== active) return
        currentClient = { ...currentClient!, is_active: false }
        clientArchiveDialog.close()
        renderDetail()
        detailStatus.textContent = 'Client archived.'
      })
      .catch((error: unknown) => {
        if (!handleFailure(error)) clientArchiveResult.textContent = messageFor(error)
      })
      .finally(() => {
        if (currentSession() === active) {
          mutationPending = false
          submitter.disabled = false
        }
      })
  })

  contactDeleteForm.addEventListener('submit', (event) => {
    const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null
    if (submitter?.value !== 'confirm') return
    event.preventDefault()
    const active = currentSession()
    if (
      active === null ||
      currentClient === null ||
      deletingContactId === null ||
      mutationPending ||
      api.deleteClientContact === undefined
    ) {
      return
    }
    const contactId = deletingContactId
    mutationPending = true
    submitter.disabled = true
    contactDeleteResult.textContent = 'Deleting contact…'
    api.deleteClientContact(contactId, active.signal)
      .then(() => {
        if (currentSession() !== active) return
        contacts = contacts.filter((contact) => contact.id !== contactId)
        deletingContactId = null
        contactDeleteDialog.close()
        renderContacts()
        detailStatus.textContent = 'Contact deleted.'
      })
      .catch((error: unknown) => {
        if (!handleFailure(error)) contactDeleteResult.textContent = messageFor(error)
      })
      .finally(() => {
        if (currentSession() === active) {
          mutationPending = false
          submitter.disabled = false
        }
      })
  })

  return {
    async activate(identity, signal, onSessionFailure) {
      const active = { identity, signal, onSessionFailure }
      session = active
      resetMutationState()
      signal.addEventListener(
        'abort',
        () => {
          if (session !== active) return
          session = null
          resetMutationState()
          clearPrivatePresentation()
          enableWrites(false)
          for (const dialog of [
            clientFormDialog,
            contactFormDialog,
            clientArchiveDialog,
            contactDeleteDialog,
          ]) {
            if (dialog.open) dialog.close()
          }
        },
        { once: true },
      )
      enableWrites(clientProfileCanWrite(identity.profile))
      if (listPage) await refreshList()
      if (detailPage) await refreshDetail()
    },
  }
}
