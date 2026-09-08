/** @vitest-environment happy-dom */

import { EzactoApiError, type GeneralResource, type Whoami } from '@ezacto/client'
import { describe, expect, it, vi } from 'vitest'
import { createClientDirectoryController } from '../src/clients/browser.js'
import type { ClientDirectoryApi } from '../src/clients/model.js'
import {
  contrastRatio,
  defaultTheme,
  renderAppShell,
  themeManifest,
  webAssets,
} from '../src/index.js'

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

  it('[browser] gives each invoice routing state its own pill, shape included', async () => {
    writeDocument()
    const contacts = (['recipient', 'cc', 'bcc', 'none'] as const).map((status, index) => ({
      ...contact,
      id: 21 + index,
      first_name: status,
      invoice_recipient_status: status,
    }))
    const api: Partial<ClientDirectoryApi> = {
      listDirectoryClients: vi.fn(async () => page([child, parent])),
      getDirectoryClient: vi.fn(async () => child),
      listClientContacts: vi.fn(async () => page(contacts)),
      listClientProjects: vi.fn(async () => page([project])),
    }
    const identity: Whoami = {
      user_id: 1,
      profile: 'member',
      manager_grants: [],
      authentication: { kind: 'session' },
    }
    const controller = createClientDirectoryController(api)

    await controller.activate(identity, new AbortController().signal, () => false)
    // The pills are only worth anything under the stylesheet the worker serves,
    // so read them through it rather than through the class name.
    const stylesheet = document.createElement('style')
    stylesheet.textContent = webAssets.stylesheet
    document.head.append(stylesheet)

    const pills = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-client-contacts] .client-recipient-pill',
      ),
    ]
    expect(pills.map((pill) => pill.dataset.recipientStatus)).toEqual([
      'recipient',
      'cc',
      'bcc',
      'none',
    ])
    const painted = pills.map((pill) => {
      const style = window.getComputedStyle(pill)
      return {
        fill: style.backgroundColor,
        ink: style.color,
        border:
          style.borderTopColor === 'transparent'
            ? 'none'
            : `${style.borderTopWidth} ${style.borderTopStyle}`,
      }
    })
    // Four states, four appearances: nothing may render the same as anything else.
    expect(new Set(painted.map((paint) => JSON.stringify(paint))).size).toBe(4)
    // And none of it may depend on the fill, because a browser omits
    // background-color when "Background graphics" is off — the default, and so
    // the state a client's printed contact sheet is in. Every label has to
    // stand on its own ink against bare paper; the recipient's did not, because
    // --ez-action-fg is #FFFFFF and printed at 2.3:1, a ghost in the one row
    // the operator opened the sheet to find.
    const paper = themeManifest[defaultTheme].colors.ground
    for (const paint of painted) {
      expect(contrastRatio(paint.ink, paper)).toBeGreaterThanOrEqual(4.5)
    }
    // Hue goes with the fill for a colourblind operator or a greyscale printer,
    // and --ez-action and --ez-data reduce to nearly the same grey, so the
    // border alone has to separate all four states.
    expect(new Set(painted.map((paint) => paint.border)).size).toBe(4)
    // The recipient carries the heaviest of them rather than a fill that prints
    // as nothing, so the row that gets the invoice is the boldest on the page
    // instead of the faintest.
    expect(painted[0]?.border).toBe('2px solid')
  })

  it('[browser] filters the tree without orphaning a matched child', async () => {
    writeDocument('client-list', '/clients')
    const other: GeneralResource = { ...parent, id: 12, name: 'Unrelated Group' }
    const api: Partial<ClientDirectoryApi> = {
      listDirectoryClients: vi.fn(async () => page([parent, child, other])),
    }
    const identity: Whoami = {
      user_id: 1,
      profile: 'member',
      manager_grants: [],
      authentication: { kind: 'session' },
    }
    const controller = createClientDirectoryController(api)
    await controller.activate(identity, new AbortController().signal, () => false)

    const names = (): string[] =>
      [...document.querySelectorAll<HTMLAnchorElement>('[data-client-tree] a')].map(
        (link) => link.textContent ?? '',
      )
    const search = document.querySelector<HTMLInputElement>('[data-client-search]')!
    expect(names()).toEqual(['Parent Holding', 'Worked-For Studio', 'Unrelated Group'])

    search.value = 'worked-for'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    // The parent is kept although it does not match: the child is shown under
    // it, indented, exactly where it lives.
    expect(names()).toEqual(['Parent Holding', 'Worked-For Studio'])
    expect(document.querySelector('[data-client-list-status]')?.textContent).toBe('2 clients shown.')

    search.value = 'nothing'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    expect(names()).toEqual([])
    expect(document.querySelector('[data-client-list-status]')?.textContent).toBe(
      'No clients match that search.',
    )
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

  it('[security] does not sign the next user out with an ended session\u2019s 401', async () => {
    // The whole point of the session presenter. The old handleFailure asked
    // currentSession() who to report to instead of asking the session that made
    // the request, so a 401 arriving after a sign-out was handed to whoever had
    // signed in since -- and their shell, doing exactly what it should with a
    // 401, signed *them* out.
    writeDocument('client-list', '/clients')
    let failList: ((error: unknown) => void) | null = null
    const listDirectoryClients = vi.fn(() =>
      listDirectoryClients.mock.calls.length === 1
        ? new Promise<ReturnType<typeof page>>((_resolve, reject) => {
            failList = reject
          })
        : Promise.resolve(page([parent])),
    )
    const identity = (user_id: number): Whoami => ({
      user_id,
      profile: 'administrator',
      manager_grants: [],
      authentication: { kind: 'session' },
    })
    const controller = createClientDirectoryController({ listDirectoryClients })
    const first = new AbortController()

    const firstActivation = controller.activate(identity(1), first.signal, () => false)
    await vi.waitFor(() => expect(listDirectoryClients).toHaveBeenCalledTimes(1))
    first.abort()

    const second = new AbortController()
    const nextSessionFailure = vi.fn((error: unknown) => {
      if (!(error instanceof EzactoApiError) || error.status !== 401) return false
      second.abort()
      return true
    })
    await controller.activate(identity(2), second.signal, nextSessionFailure)

    failList!(new EzactoApiError(401, { error: { message: 'Session expired.' } }, null))
    await firstActivation

    expect(nextSessionFailure).not.toHaveBeenCalled()
    expect(second.signal.aborted).toBe(false)
    expect(document.body.textContent).not.toContain('Session expired.')
    expect(document.querySelector<HTMLButtonElement>('[data-client-list-retry]')?.hidden).toBe(true)
  })

  it('[security] keeps an ended session\u2019s save failure out of the next user\u2019s dialog', async () => {
    // The other shape in this file, `if (!handleFailure(error)) paint`: for a
    // session that had gone it read as "nobody took it -- carry on", and the
    // previous user's failure was waiting in the dialog the next one opens.
    writeDocument('client-list', '/clients')
    let failSave: ((error: unknown) => void) | null = null
    const createDirectoryClient = vi.fn(
      () =>
        new Promise<GeneralResource>((_resolve, reject) => {
          failSave = reject
        }),
    )
    const identity = (user_id: number): Whoami => ({
      user_id,
      profile: 'administrator',
      manager_grants: [],
      authentication: { kind: 'session' },
    })
    const controller = createClientDirectoryController({
      listDirectoryClients: vi.fn(async () => page([parent])),
      createDirectoryClient,
      updateDirectoryClient: vi.fn(),
    })
    const first = new AbortController()

    await controller.activate(identity(1), first.signal, () => false)
    const form = document.querySelector<HTMLFormElement>('[data-client-form]')!
    const submitter = document.querySelector<HTMLButtonElement>('[data-client-form-submit]')!
    document.querySelector<HTMLButtonElement>('[data-client-create]')!.click()
    ;(form.elements.namedItem('name') as HTMLInputElement).value = 'Left in flight'
    form.dispatchEvent(
      new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter }),
    )
    await vi.waitFor(() => expect(createDirectoryClient).toHaveBeenCalledTimes(1))

    first.abort()
    const nextSessionFailure = vi.fn(() => false)
    await controller.activate(identity(2), new AbortController().signal, nextSessionFailure)

    failSave!(new Error('Saving the client was refused.'))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(nextSessionFailure).not.toHaveBeenCalled()
    expect(document.querySelector('[data-client-form-result]')?.textContent).not.toContain(
      'Saving the client was refused.',
    )
    expect(document.body.textContent).not.toContain('Saving the client was refused.')
  })
})
