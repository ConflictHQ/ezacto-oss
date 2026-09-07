/** @vitest-environment happy-dom */

import { EzactoApiError, type GeneralResource, type Whoami } from '@ezacto/client'
import { describe, expect, it, vi } from 'vitest'
import { createClientDirectoryController } from '../src/clients/browser.js'
import type { ClientDirectoryApi } from '../src/clients/model.js'
import { renderAppShell } from '../src/index.js'

const timestamp = '2026-09-01T12:00:00.000Z'
const parent: GeneralResource = {
  id: 10,
  name: 'Parent Holding',
  currency: 'USD',
  is_active: true,
  parent_client_id: null,
  bill_to_client_id: null,
  payment_terms: 'net_30',
  default_tax_pct: 7.25,
  default_tax2_pct: null,
  default_discount_pct: 5,
  address: '1 Parent Way',
  created_at: timestamp,
  updated_at: timestamp,
}
const child: GeneralResource = {
  ...parent,
  id: 11,
  name: 'Worked-For Studio',
  parent_client_id: 10,
  bill_to_client_id: 10,
  address: '2 Child Way',
}
const contact: GeneralResource = {
  id: 21,
  client_id: 11,
  title: 'Dr.',
  first_name: 'Alex',
  last_name: 'Rivera',
  email: 'alex@example.test',
  phone_office: null,
  phone_mobile: '+1 555 0100',
  fax: null,
  invoice_recipient_status: 'cc',
  created_at: timestamp,
  updated_at: timestamp,
}
const project: GeneralResource = {
  id: 31,
  client_id: 11,
  name: 'Launch',
  code: 'WEB',
  is_active: true,
  billing_method: 'time_materials',
  created_at: timestamp,
  updated_at: timestamp,
}

const writeDocument = (
  view: 'client-list' | 'client-detail' = 'client-detail',
  pathname = '/clients/11',
): void => {
  window.history.replaceState(null, '', pathname)
  document.open()
  document.write(
    renderAppShell({
      environment: 'test',
      release: 'client-browser-test',
      activeSection: 'Clients',
      view,
    })
      .replace(/ {2}<link[^>]+(?:fonts\.googleapis|fonts\.gstatic|\/assets\/ezacto\.css)[^>]*>\n/gu, '')
      .replace('  <script type="module" src="/assets/ezacto.js"></script>\n', ''),
  )
  document.close()
}

const page = (data: readonly GeneralResource[]) => ({
  data,
  page: { next_cursor: null },
})

describe('Clients V1 browser controller', () => {
  it('[browser] renders exact relations, contact routing, and projects for read-only profiles', async () => {
    writeDocument()
    const api: Partial<ClientDirectoryApi> = {
      listDirectoryClients: vi.fn(async () => page([child, parent])),
      getDirectoryClient: vi.fn(async () => child),
      listClientContacts: vi.fn(async () => page([contact])),
      listClientProjects: vi.fn(async () => page([project])),
      createDirectoryClient: vi.fn(),
      updateDirectoryClient: vi.fn(),
      archiveDirectoryClient: vi.fn(),
      createClientContact: vi.fn(),
      updateClientContact: vi.fn(),
      deleteClientContact: vi.fn(),
    }
    const identity: Whoami = {
      user_id: 1,
      profile: 'member',
      manager_grants: [],
      authentication: { kind: 'session' },
    }
    const controller = createClientDirectoryController(api)

    await controller.activate(identity, new AbortController().signal, () => false)

    expect(document.querySelector('[data-client-detail-parent]')?.textContent).toBe(
      'Parent Holding',
    )
    expect(document.querySelector('[data-client-detail-bill-to]')?.textContent).toBe(
      'Parent Holding',
    )
    expect(document.querySelector('[data-client-projects]')?.textContent).toContain(
      '[WEB] Launch',
    )
    // A client is a hub: its projects are the way through to the work.
    const projectLink = document.querySelector<HTMLAnchorElement>(
      '[data-client-projects] a',
    )
    expect(projectLink?.getAttribute('href')).toBe('/projects/31')
    expect(projectLink?.textContent).toBe('[WEB] Launch')
    expect(document.querySelector('[data-client-contacts]')?.textContent).toContain(
      'Invoice CC',
    )
    expect(
      [...document.querySelectorAll<HTMLElement>('[data-client-write]')].every(
        (element) => element.hidden,
      ),
    ).toBe(true)
    expect(api.createDirectoryClient).not.toHaveBeenCalled()
    expect(api.archiveDirectoryClient).not.toHaveBeenCalled()
  })

  it('[browser] clears pending mutations after a shared 401 so reauthentication restores CRUD', async () => {
    writeDocument('client-list', '/clients')
    const createDirectoryClient = vi
      .fn()
      .mockRejectedValueOnce(
        new EzactoApiError(401, { error: { message: 'Session expired.' } }, null),
      )
      .mockResolvedValueOnce({ ...parent, id: 12, name: 'Recovered client' })
    const api: Partial<ClientDirectoryApi> = {
      listDirectoryClients: vi.fn(async () => page([parent])),
      createDirectoryClient,
      updateDirectoryClient: vi.fn(),
    }
    const identity: Whoami = {
      user_id: 1,
      profile: 'administrator',
      manager_grants: [],
      authentication: { kind: 'session' },
    }
    const controller = createClientDirectoryController(api)
    const expired = new AbortController()

    await controller.activate(identity, expired.signal, (error) => {
      if (!(error instanceof EzactoApiError) || error.status !== 401) return false
      expired.abort()
      return true
    })

    const form = document.querySelector<HTMLFormElement>('[data-client-form]')!
    const submit = document.querySelector<HTMLButtonElement>('[data-client-form-submit]')!
    document.querySelector<HTMLButtonElement>('[data-client-create]')!.click()
    ;(form.elements.namedItem('name') as HTMLInputElement).value = 'Expired attempt'
    form.dispatchEvent(
      new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: submit }),
    )

    await vi.waitFor(() => expect(createDirectoryClient).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(expired.signal.aborted).toBe(true))
    expect(document.querySelector<HTMLDialogElement>('[data-client-form-dialog]')!.open).toBe(false)

    await controller.activate(identity, new AbortController().signal, () => false)
    document.querySelector<HTMLButtonElement>('[data-client-create]')!.click()
    ;(form.elements.namedItem('name') as HTMLInputElement).value = 'Recovered client'
    form.dispatchEvent(
      new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter: submit }),
    )

    await vi.waitFor(() => expect(createDirectoryClient).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-client-list-status]')?.textContent).toBe(
        'Client added.',
      ),
    )
  })
})
