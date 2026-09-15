/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  EzactoApiError,
  authenticationError,
  browserApi,
  createModuleSettingsController,
  deferred,
  identity,
  mountShell,
  renderBrowserShell,
  secondIdentity,
  timestamp,
  type SenderIdentity,
  type SsoDomain,
} from './support/shell-harness.js'

describe('company settings', () => {
  // The modules list predates the shell api and still fetches for itself, so a
  // company page that never resolves it leaves every section behind a spinner.
  // Both admin endpoints the company page reads directly rather than through
  // the typed client. Keyed by path, so the sign-in section does not get handed
  // the module payload and draw cards for methods that do not exist.
  const stubModulesEndpoint = (): void => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const path = String(input)
        const data = path.includes('/admin/sign-in-methods')
          ? [{ method: 'password', configured: true, enabled: true }]
          : [{ module: 'expenses', enabled: true }]
        return {
          ok: true,
          status: 200,
          json: async () => ({ data }),
          text: async () => JSON.stringify({ data }),
        }
      }),
    )
  }

  const senderIdentity = (overrides: Partial<SenderIdentity> = {}): SenderIdentity => ({
    id: 3,
    email: 'billing@northpeak.test',
    display_name: 'Northpeak Billing',
    reply_to_email: null,
    provider: 'mailgun',
    provider_identity: 'billing@northpeak.test',
    is_default: true,
    version: 1,
    archived_at: null,
    evidence: {
      version: 1,
      source: 'deployment_config',
      identity_kind: 'email_address',
      verification_status: 'operator_configured',
      dkim_status: 'not_applicable',
      mail_from_domain: null,
      mail_from_status: 'not_configured',
      observed_at: timestamp,
    },
    created_by_user_id: 1,
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  })

  const ssoDomain = (overrides: Partial<SsoDomain> = {}): SsoDomain => ({
    id: 11,
    domain: 'northpeak.test',
    verified: false,
    verified_at: null,
    last_checked_at: null,
    record_name: '_ezacto-challenge.northpeak.test',
    record_type: 'TXT',
    record_value: 'ezacto-verification=zLp7c4Qk',
    created_at: timestamp,
    updated_at: timestamp,
    ...overrides,
  })

  const backupRun = (over: Record<string, unknown> = {}) => ({
    id: 9,
    status: 'completed' as const,
    trigger: 'nightly' as const,
    started_at: '2026-09-08T03:00:00.000Z',
    completed_at: '2026-09-08T03:04:11.000Z',
    r2_prefix: 'backups/2026-09-08',
    table_count: 91,
    total_rows: 32_516,
    error_message: null,
    ...over,
  })

  let backupStatusPayload: {
    last_completed: ReturnType<typeof backupRun> | null
    last_failed: ReturnType<typeof backupRun> | null
    recent_runs: ReturnType<typeof backupRun>[]
    has_failure: boolean
  } = {
    last_completed: backupRun(),
    last_failed: null,
    recent_runs: [backupRun()],
    has_failure: false,
  }

  const companyApi = (
    identities: readonly SenderIdentity[] = [senderIdentity()],
    domains: readonly SsoDomain[] = [],
  ) => ({
    ...browserApi(),
    getTimeEntryNoteSettings: vi.fn(async () => ({ required: true, minimum_length: 12 })),
    updateTimeEntryNoteSettings: vi.fn(async (patch: { required?: boolean; minimum_length?: number }) => ({
      required: patch.required ?? true,
      minimum_length: patch.minimum_length ?? 12,
    })),
    listSenderIdentities: vi.fn(async () => identities),
    listSsoDomains: vi.fn(async () => domains),
    addSsoDomain: vi.fn(async (domain: string) =>
      ssoDomain({
        id: 12,
        domain,
        record_name: `_ezacto-challenge.${domain}`,
        record_value: 'ezacto-verification=8mQd2Rh1',
      }),
    ),
    verifySsoDomain: vi.fn(async (id: number) => ({
      ...ssoDomain({ id, verified: true, verified_at: timestamp, last_checked_at: timestamp }),
      dnssec_validated: false,
    })),
    removeSsoDomain: vi.fn(async () => undefined),
    getBackupStatus: vi.fn(async () => backupStatusPayload),
    getEmailHealth: vi.fn(async () => ({
      reputation: {
        sent: 412,
        bounced: 3,
        complained: 1,
        failed: 0,
        bounce_rate_ppm: 7_200,
        complaint_rate_ppm: 2_400,
      },
    })),
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('[unit] shows the instance configuration the endpoints already served', async () => {
    // Every setting on this page had an endpoint and no reader: the notes
    // policy, the tracking mode, the address this instance sends as and how
    // that mail lands were all reachable only with a token and a terminal.
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const api = companyApi([
      senderIdentity(),
      senderIdentity({ id: 4, email: 'noreply@northpeak.test', is_default: false, evidence: null }),
    ])
    await mountShell(api)

    const facts = document.querySelector<HTMLElement>('[data-settings-time-facts]')!
    await vi.waitFor(() => expect(facts.hidden).toBe(false))
    expect(facts.textContent).toContain('Entry method')
    expect(facts.textContent).toContain('Duration')
    expect(facts.textContent).toContain('Monday')

    const noteRequired = document.querySelector<HTMLInputElement>('[data-note-settings-required]')!
    const noteMinimum = document.querySelector<HTMLInputElement>('[data-note-settings-minimum]')!
    expect(noteRequired.checked).toBe(true)
    expect(noteMinimum.value).toBe('12')
    expect(document.querySelector<HTMLElement>('[data-note-settings-form]')!.hidden).toBe(false)

    const senders = document.querySelector<HTMLElement>('[data-settings-sender-identities]')!
    await vi.waitFor(() => expect(senders.hidden).toBe(false))
    expect(senders.querySelectorAll('tbody [data-row]')).toHaveLength(2)
    expect(senders.textContent).toContain('billing@northpeak.test')
    expect(senders.textContent).toContain('Operator configured')
    // A sender nothing has checked is not a verified one, and must not read as
    // one: an empty verification cell would say the transport approved it.
    expect(senders.textContent).toContain('Not verified yet')

    const reputation = document.querySelector<HTMLElement>('[data-settings-email-reputation]')!
    expect(reputation.textContent).toContain('412')
    // The API reports parts per million; 7_200 ppm is 0.72% of mail bouncing,
    // and an operator who reads it as 7,200 bounces panics for nothing.
    expect(reputation.textContent).toContain('0.72%')
    expect(reputation.textContent).toContain('0.24%')
  })

  it('[browser #104] offers one Connect button, and sends the operator to Intuit', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const api = {
      ...companyApi([senderIdentity()], []),
      getQuickBooksConnection: vi.fn(async () => ({ configured: true, connection: null })),
      startQuickBooksAuthorization: vi.fn(async () => ({
        authorize_url: 'https://appcenter.intuit.com/connect/oauth2?state=abc',
      })),
    }
    const assign = vi.fn()
    const original = window.location
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, assign },
    })
    try {
      const controller = createModuleSettingsController(api as never)
      await controller.activate(identity, new AbortController().signal, () => false)

      const connect = document.querySelector<HTMLButtonElement>('[data-quickbooks-connect]')!
      await vi.waitFor(() => expect(connect.hidden).toBe(false))
      // Nothing to disconnect until something is connected.
      expect(
        document.querySelector<HTMLButtonElement>('[data-quickbooks-disconnect]')!.hidden,
      ).toBe(true)

      connect.click()
      await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(1))
      // Sent rather than fetched: the consent screen is a page a person has to
      // see and answer on Intuit's own domain.
      expect(assign).toHaveBeenCalledWith(
        'https://appcenter.intuit.com/connect/oauth2?state=abc',
      )
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original })
    }
  })

  it('[browser #104] shows the connected company, and what it is allowed to do', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const api = {
      ...companyApi([senderIdentity()], []),
      getQuickBooksConnection: vi.fn(async () => ({
        configured: true,
        connection: {
          realm_id: 'realm-a',
          company_name: 'Northpeak Books',
          scope: 'com.intuit.quickbooks.accounting',
          allow_online_payment: false,
          connected_at: '2026-09-11T12:00:00.000Z',
        },
      })),
      updateQuickBooksSettings: vi.fn(async () => undefined),
    }
    const controller = createModuleSettingsController(api as never)
    await controller.activate(identity, new AbortController().signal, () => false)

    const facts = document.querySelector<HTMLElement>('[data-settings-quickbooks-facts]')!
    await vi.waitFor(() => expect(facts.hidden).toBe(false))
    expect(facts.textContent).toContain('Northpeak Books')
    // The scope is shown, because "connected" without saying what it can reach
    // is not informed consent after the fact.
    expect(facts.textContent).toContain('com.intuit.quickbooks.accounting')
    expect(document.querySelector<HTMLButtonElement>('[data-quickbooks-connect]')!.hidden).toBe(
      true,
    )

    const allow = document.querySelector<HTMLInputElement>('[data-quickbooks-allow-payment]')!
    expect(allow.checked).toBe(false)
    allow.checked = true
    allow.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(api.updateQuickBooksSettings).toHaveBeenCalledWith(true, expect.anything()))
  })

  it('[security #104] offers no connect button to a profile the route would refuse', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const api = {
      ...companyApi([senderIdentity()], []),
      getQuickBooksConnection: vi.fn(async () => ({ configured: true, connection: null })),
      startQuickBooksAuthorization: vi.fn(async () => ({ authorize_url: 'https://example.test' })),
    }
    const controller = createModuleSettingsController(api as never)
    // An executive manager reaches this page; connecting an accounting system
    // is a grant over the whole book and the route refuses anyone but an
    // administrator.
    await controller.activate(
      { ...identity, profile: 'executive_manager' },
      new AbortController().signal,
      () => false,
    )
    expect(document.querySelector<HTMLElement>('[data-settings-quickbooks-actions]')!.hidden).toBe(
      true,
    )
    expect(api.getQuickBooksConnection).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('administrator action')
  })

  it('[browser #104] says so where the deployment has no Intuit credentials', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const api = {
      ...companyApi([senderIdentity()], []),
      getQuickBooksConnection: vi.fn(async () => ({ configured: false, connection: null })),
    }
    const controller = createModuleSettingsController(api as never)
    await controller.activate(identity, new AbortController().signal, () => false)
    // Keys are a deployment concern, not something fixable from this screen, so
    // it explains rather than offering a button that would answer 503.
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('no Intuit credentials'),
    )
    expect(document.querySelector<HTMLElement>('[data-settings-quickbooks-actions]')!.hidden).toBe(
      true,
    )
  })

  it('[security] clears an administrator\'s email data when a lesser profile signs in', async () => {
    // The page outlives the session: signing out and back in as someone else
    // happens in the same document. The non-privileged branch only rewrote
    // three status strings, so the previous administrator's sender identities
    // and reputation figures stayed rendered above the notice saying they were
    // administrators-only.
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const api = companyApi([senderIdentity()], [ssoDomain()])
    const controller = createModuleSettingsController(api as never)

    await controller.activate(identity, new AbortController().signal, () => false)
    const senders = document.querySelector<HTMLElement>('[data-settings-sender-identities]')!
    await vi.waitFor(() => expect(senders.hidden).toBe(false))
    expect(document.body.textContent).toContain('billing@northpeak.test')

    // The same tab, a different person.
    await controller.activate(secondIdentity, new AbortController().signal, () => false)

    expect(
      document.querySelector<HTMLElement>('[data-module-settings-status]')?.textContent,
    ).toBe('Only administrators can manage module settings.')
    expect(document.body.textContent).not.toContain('billing@northpeak.test')
    expect(senders.hidden).toBe(true)
    expect(
      document.querySelector<HTMLElement>('[data-settings-email-reputation]')!.textContent,
    ).toBe('')
    // A challenge token is the instance's proof it owns the domain. Leaving it
    // rendered hands the next person at the keyboard everything they need to
    // claim the domain themselves.
    expect(document.body.textContent).not.toContain('ezacto-verification=zLp7c4Qk')
    expect(document.querySelector<HTMLElement>('[data-settings-sso-domains]')!.hidden).toBe(true)
    expect(document.querySelector<HTMLFormElement>('[data-sso-domain-form]')!.hidden).toBe(true)
  })

  it('[unit] saves the notes policy the page loaded', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const api = companyApi()
    await mountShell(api)

    const noteRequired = document.querySelector<HTMLInputElement>('[data-note-settings-required]')!
    const noteMinimum = document.querySelector<HTMLInputElement>('[data-note-settings-minimum]')!
    await vi.waitFor(() => expect(noteMinimum.value).toBe('12'))
    noteRequired.checked = false
    noteMinimum.value = '25'
    document
      .querySelector<HTMLFormElement>('[data-note-settings-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() =>
      expect(api.updateTimeEntryNoteSettings).toHaveBeenCalledWith(
        { required: false, minimum_length: 25 },
        expect.any(AbortSignal),
      ),
    )
    await vi.waitFor(() =>
      expect(document.querySelector('[data-note-settings-result]')?.textContent).toBe('Saved.'),
    )
  })

  it('[unit] refuses a minimum length that is not a whole number of characters', async () => {
    // The API answers 422 for this. Spending a round trip to be told so leaves
    // the form looking broken rather than wrong.
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const api = companyApi()
    await mountShell(api)

    const noteMinimum = document.querySelector<HTMLInputElement>('[data-note-settings-minimum]')!
    await vi.waitFor(() => expect(noteMinimum.value).toBe('12'))
    noteMinimum.value = '-4'
    document
      .querySelector<HTMLFormElement>('[data-note-settings-form]')!
      .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() =>
      expect(document.querySelector('[data-note-settings-result]')?.textContent).toContain(
        'whole number of characters',
      ),
    )
    expect(api.updateTimeEntryNoteSettings).not.toHaveBeenCalled()
  })

  it('[security] does not ask for email delivery as an executive manager', async () => {
    // Both email endpoints are administrator-only. An executive manager who
    // opens the page gets told so, rather than two 403s dressed as a failure.
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const api = {
      ...companyApi(),
      whoami: vi.fn(async () => ({
        ...identity,
        user_id: 5,
        profile: 'executive_manager' as const,
      })),
    }
    await mountShell(api)

    await vi.waitFor(() =>
      expect(document.querySelector('[data-settings-email-status]')?.textContent).toBe(
        'Email delivery is visible to administrators only.',
      ),
    )
    expect(api.listSenderIdentities).not.toHaveBeenCalled()
    expect(api.getEmailHealth).not.toHaveBeenCalled()
    // The notes policy is theirs to set, so that half of the page still loads.
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLElement>('[data-note-settings-form]')!.hidden).toBe(false),
    )
  })

  const ssoTable = (): HTMLElement =>
    document.querySelector<HTMLElement>('[data-settings-sso-domains]')!

  const ssoStatuses = (): readonly (string | null)[] =>
    [...ssoTable().querySelectorAll('tbody [data-row] [data-column="status"]')].map(
      (cell) => cell.textContent,
    )

  const ssoAction = (row: number, label: string): HTMLButtonElement => {
    const rows = ssoTable().querySelectorAll<HTMLElement>('tbody [data-row]')
    const button = [...rows[row]!.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) => candidate.textContent === label,
    )
    if (button === undefined) throw new Error(`no ${label} action on row ${row}`)
    return button
  }

  const ssoResult = (): string | null =>
    document.querySelector<HTMLElement>('[data-sso-domain-result]')!.textContent

  it('[unit] shows the challenge record, and never checked is not the same as not found', async () => {
    // Migration 0039 creates the table empty and the provisioning gate is live,
    // so before this screen an instance had no in-product path from off to on:
    // recovery meant hand-writing a D1 row with a valid challenge token.
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const api = companyApi(
      [senderIdentity()],
      [
        ssoDomain(),
        ssoDomain({
          id: 12,
          domain: 'acme.test',
          record_name: '_ezacto-challenge.acme.test',
          last_checked_at: timestamp,
        }),
        ssoDomain({
          id: 13,
          domain: 'verified.test',
          record_name: '_ezacto-challenge.verified.test',
          verified: true,
          verified_at: timestamp,
          last_checked_at: timestamp,
        }),
      ],
    )
    await mountShell(api)

    await vi.waitFor(() => expect(ssoTable().hidden).toBe(false))
    // A domain nobody has looked up and a domain whose record was looked for
    // and not found are both unverified, and one label for both is how an
    // operator who has not published the record yet concludes SSO is broken.
    expect(ssoStatuses()).toEqual(['Awaiting first check', 'Record not found', 'Verified'])
    expect(ssoTable().textContent).toContain('_ezacto-challenge.northpeak.test')
    expect(ssoTable().textContent).toContain('ezacto-verification=zLp7c4Qk')
  })

  it('[unit] adds a domain and says it provisions nobody until the record is published', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const api = companyApi()
    await mountShell(api)

    const form = document.querySelector<HTMLFormElement>('[data-sso-domain-form]')!
    await vi.waitFor(() => expect(form.hidden).toBe(false))
    document.querySelector<HTMLInputElement>('[data-sso-domain-input]')!.value = ' acme.test '
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))

    await vi.waitFor(() =>
      expect(api.addSsoDomain).toHaveBeenCalledWith('acme.test', expect.any(AbortSignal)),
    )
    await vi.waitFor(() => expect(ssoResult()).toContain('Publish the TXT record shown'))
    expect(ssoTable().textContent).toContain('_ezacto-challenge.acme.test')
    expect(ssoTable().textContent).toContain('ezacto-verification=8mQd2Rh1')
    expect(ssoStatuses()).toEqual(['Awaiting first check'])
  })

  it('[unit] reports a check that ran and found nothing as not verified yet', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const api = {
      ...companyApi([senderIdentity()], [ssoDomain()]),
      verifySsoDomain: vi.fn(async () => ({
        ...ssoDomain({ last_checked_at: timestamp }),
        dnssec_validated: false,
      })),
    }
    await mountShell(api)
    await vi.waitFor(() => expect(ssoTable().hidden).toBe(false))

    ssoAction(0, 'Verify').click()

    await vi.waitFor(() => expect(ssoResult()).toContain('is not verified yet'))
    expect(ssoResult()).toContain('_ezacto-challenge.northpeak.test')
    expect(ssoStatuses()).toEqual(['Record not found'])
  })

  it('[unit] separates a lookup that could not run from a record that is not there', async () => {
    // 503 is the resolvers failing to answer, not the domain failing the check:
    // the record may be published and perfect. A page that reads the two the
    // same way sends an operator to pull a record that was never the problem.
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const api = {
      ...companyApi([senderIdentity()], [ssoDomain()]),
      verifySsoDomain: vi.fn(async () => {
        throw new EzactoApiError(
          503,
          {
            error: {
              code: 'dns_lookup_failed',
              message: 'The DNS challenge could not be looked up. Try again.',
              fields: [],
            },
          },
          null,
        )
      }),
    }
    await mountShell(api)
    await vi.waitFor(() => expect(ssoTable().hidden).toBe(false))

    ssoAction(0, 'Verify').click()

    await vi.waitFor(() =>
      expect(ssoResult()).toBe('The DNS challenge could not be looked up. Try again.'),
    )
    expect(ssoResult()).not.toContain('not verified yet')
    // Nothing was checked, so the row must not claim the record is missing.
    expect(ssoStatuses()).toEqual(['Awaiting first check'])
  })

  it('[unit] verifies a domain and says so', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const api = companyApi([senderIdentity()], [ssoDomain()])
    await mountShell(api)
    await vi.waitFor(() => expect(ssoTable().hidden).toBe(false))

    ssoAction(0, 'Verify').click()

    await vi.waitFor(() => expect(ssoResult()).toBe('northpeak.test is verified.'))
    expect(api.verifySsoDomain).toHaveBeenCalledWith(11, expect.any(AbortSignal))
    expect(ssoStatuses()).toEqual(['Verified'])
  })

  it('[unit] removes a domain from the list it provisions from', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const api = companyApi([senderIdentity()], [ssoDomain()])
    await mountShell(api)
    await vi.waitFor(() => expect(ssoTable().hidden).toBe(false))

    ssoAction(0, 'Remove').click()

    await vi.waitFor(() =>
      expect(api.removeSsoDomain).toHaveBeenCalledWith(11, expect.any(AbortSignal)),
    )
    await vi.waitFor(() => expect(ssoResult()).toBe('northpeak.test no longer provisions anyone.'))
    expect(ssoTable().querySelectorAll('tbody [data-row]')).toHaveLength(0)
    expect(ssoTable().textContent).toContain('No domain is provisioned')
  })

  it('[security] does not ask for provisioning domains as an executive manager', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const api = {
      ...companyApi([senderIdentity()], [ssoDomain()]),
      whoami: vi.fn(async () => ({
        ...identity,
        user_id: 5,
        profile: 'executive_manager' as const,
      })),
    }
    await mountShell(api)

    await vi.waitFor(() =>
      expect(document.querySelector('[data-settings-sso-status]')?.textContent).toBe(
        'SSO provisioning domains are visible to administrators only.',
      ),
    )
    expect(api.listSsoDomains).not.toHaveBeenCalled()
    expect(document.querySelector<HTMLFormElement>('[data-sso-domain-form]')!.hidden).toBe(true)
  })

  const settled = async (): Promise<void> => {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0))
  }

  const moduleStatus = (): string | null | undefined =>
    document.querySelector<HTMLElement>('[data-module-settings-status]')?.textContent

  // Each in-flight writer, driven the way the shell drives it: an operation
  // started by an administrator, a sign-out and a sign-in by someone lesser in
  // the same document, and only then the answer. #372 fixed the sections that
  // load on activation; nothing stopped a request that was already out from
  // painting into the page it came back to.
  it('[security] does not paint an add that answers after the next person signs in', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const added = deferred<SsoDomain>()
    const api = {
      ...companyApi([senderIdentity()], []),
      addSsoDomain: vi.fn(async () => added.promise),
    }
    const controller = createModuleSettingsController(api as never)

    // No abort here: the guard cannot rest on the shell remembering to abort,
    // and a session that was merely replaced has left the page just the same.
    await controller.activate(identity, new AbortController().signal, () => false)
    const form = document.querySelector<HTMLFormElement>('[data-sso-domain-form]')!
    await vi.waitFor(() => expect(form.hidden).toBe(false))
    document.querySelector<HTMLInputElement>('[data-sso-domain-input]')!.value = 'acme.test'
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(api.addSsoDomain).toHaveBeenCalled())

    // The same tab, a different person, while the POST is still out.
    await controller.activate(secondIdentity, new AbortController().signal, () => false)
    added.resolve(
      ssoDomain({
        id: 12,
        domain: 'acme.test',
        record_name: '_ezacto-challenge.acme.test',
        record_value: 'ezacto-verification=8mQd2Rh1',
      }),
    )
    await settled()

    // The challenge token is the instance's proof it owns the domain, and this
    // is the one path that puts a brand new one on screen.
    expect(document.body.textContent).not.toContain('ezacto-verification=8mQd2Rh1')
    expect(document.body.textContent).not.toContain('_ezacto-challenge.acme.test')
    expect(document.body.textContent).not.toContain('acme.test')
    expect(ssoTable().hidden).toBe(true)
    expect(ssoResult()).toBe('')
    expect(moduleStatus()).toBe('Only administrators can manage module settings.')
  })

  it('[security] does not paint a verify that answers after the next person signs in', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const checked = deferred<SsoDomain>()
    const api = {
      ...companyApi([senderIdentity()], [ssoDomain()]),
      verifySsoDomain: vi.fn(async () => checked.promise),
    }
    const controller = createModuleSettingsController(api as never)

    // The shell aborts on every sign-in and sign-out, so this is the path a
    // real verify takes. However the request ends, the finally that re-shows
    // the table runs.
    const first = new AbortController()
    await controller.activate(identity, first.signal, () => false)
    await vi.waitFor(() => expect(ssoTable().hidden).toBe(false))
    ssoAction(0, 'Verify').click()
    await vi.waitFor(() => expect(api.verifySsoDomain).toHaveBeenCalled())

    first.abort()
    await controller.activate(secondIdentity, new AbortController().signal, () => false)
    checked.resolve(ssoDomain({ verified: true, verified_at: timestamp, last_checked_at: timestamp }))
    await settled()

    expect(document.body.textContent).not.toContain('northpeak.test')
    expect(document.body.textContent).not.toContain('ezacto-verification=zLp7c4Qk')
    expect(ssoTable().hidden).toBe(true)
    expect(ssoResult()).toBe('')
    expect(moduleStatus()).toBe('Only administrators can manage module settings.')
  })

  it('[security] does not answer a verify that lands after the operator signed out', async () => {
    // Signing out does not activate the page again, so nothing clears it: all
    // that stops the check from reporting on a session that has ended is the
    // aborted signal the shell hands every controller on the way out.
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const checked = deferred<SsoDomain>()
    const api = {
      ...companyApi([senderIdentity()], [ssoDomain()]),
      verifySsoDomain: vi.fn(async () => checked.promise),
    }
    const controller = createModuleSettingsController(api as never)

    const operator = new AbortController()
    await controller.activate(identity, operator.signal, () => false)
    await vi.waitFor(() => expect(ssoTable().hidden).toBe(false))
    ssoAction(0, 'Verify').click()
    await vi.waitFor(() => expect(api.verifySsoDomain).toHaveBeenCalled())

    operator.abort()
    checked.resolve(ssoDomain({ verified: true, verified_at: timestamp, last_checked_at: timestamp }))
    await settled()

    expect(ssoResult()).not.toContain('is verified')
    expect(ssoStatuses()).toEqual(['Awaiting first check'])
  })

  it('[security] does not paint a remove that answers after the next person signs in', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const removed = deferred<undefined>()
    const api = {
      ...companyApi([senderIdentity()], [ssoDomain()]),
      removeSsoDomain: vi.fn(async () => removed.promise),
    }
    const controller = createModuleSettingsController(api as never)

    await controller.activate(identity, new AbortController().signal, () => false)
    await vi.waitFor(() => expect(ssoTable().hidden).toBe(false))
    ssoAction(0, 'Remove').click()
    await vi.waitFor(() => expect(api.removeSsoDomain).toHaveBeenCalled())

    await controller.activate(secondIdentity, new AbortController().signal, () => false)
    removed.resolve(undefined)
    await settled()

    // Even an empty table is the previous session's section: re-showing it
    // under "administrators only" says the notice is about someone else.
    expect(document.body.textContent).not.toContain('northpeak.test')
    expect(ssoTable().hidden).toBe(true)
    expect(ssoResult()).toBe('')
    expect(moduleStatus()).toBe('Only administrators can manage module settings.')
  })

  it('[security] does not paint a notes policy that saves after the next person signs in', async () => {
    // The notes form is the only writable setting on the page, and its handler
    // was written with the same shape as the three SSO ones.
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const saved = deferred<{ required: boolean; minimum_length: number }>()
    const api = {
      ...companyApi(),
      updateTimeEntryNoteSettings: vi.fn(async () => saved.promise),
    }
    const controller = createModuleSettingsController(api as never)

    const noteForm = document.querySelector<HTMLFormElement>('[data-note-settings-form]')!
    const noteMinimum = document.querySelector<HTMLInputElement>('[data-note-settings-minimum]')!
    await controller.activate(identity, new AbortController().signal, () => false)
    await vi.waitFor(() => expect(noteForm.hidden).toBe(false))
    noteMinimum.value = '25'
    noteForm.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(api.updateTimeEntryNoteSettings).toHaveBeenCalled())

    await controller.activate(secondIdentity, new AbortController().signal, () => false)
    saved.resolve({ required: false, minimum_length: 25 })
    await settled()

    expect(noteForm.hidden).toBe(true)
    expect(document.querySelector('[data-note-settings-result]')?.textContent).toBe('')
    expect(moduleStatus()).toBe('Only administrators can manage module settings.')
  })

  it('[security] does not report an ended session\u2019s failure to the shell at all', async () => {
    // The paint half of every handler here was guarded; the report half was
    // not, so a 401 from a session that had already gone was still handed to
    // onSessionFailure. Nothing worse happened only because the shell checks
    // currency a second time -- a guarantee this controller was borrowing
    // rather than holding, and the borrowed one is what six earlier sites had.
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const checked = deferred<SsoDomain>()
    const api = {
      ...companyApi([senderIdentity()], [ssoDomain()]),
      verifySsoDomain: vi.fn(async () => checked.promise),
    }
    const controller = createModuleSettingsController(api as never)

    const operator = new AbortController()
    const operatorSessionFailure = vi.fn(() => false)
    await controller.activate(identity, operator.signal, operatorSessionFailure)
    await vi.waitFor(() => expect(ssoTable().hidden).toBe(false))
    ssoAction(0, 'Verify').click()
    await vi.waitFor(() => expect(api.verifySsoDomain).toHaveBeenCalled())

    operator.abort()
    await controller.activate(secondIdentity, new AbortController().signal, () => false)
    checked.reject(authenticationError(401, 'unauthorized'))
    await settled()

    expect(operatorSessionFailure).not.toHaveBeenCalled()
    expect(ssoResult()).toBe('')
    expect(moduleStatus()).toBe('Only administrators can manage module settings.')
  })

  it('[unit] gives the next administrator controls that are not still disabled', async () => {
    // The finally that re-enables a control belongs to the session that
    // disabled it, so the reset has to happen where the next session's page is
    // built. Without it, guarding the finally strands the button.
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const added = deferred<SsoDomain>()
    const api = {
      ...companyApi([senderIdentity()], []),
      addSsoDomain: vi.fn(async () => added.promise),
    }
    const controller = createModuleSettingsController(api as never)

    await controller.activate(identity, new AbortController().signal, () => false)
    const form = document.querySelector<HTMLFormElement>('[data-sso-domain-form]')!
    await vi.waitFor(() => expect(form.hidden).toBe(false))
    document.querySelector<HTMLInputElement>('[data-sso-domain-input]')!.value = 'acme.test'
    form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(document.querySelector<HTMLButtonElement>('[data-sso-domain-submit]')!.disabled).toBe(
        true,
      ),
    )

    await controller.activate(identity, new AbortController().signal, () => false)
    added.resolve(ssoDomain({ id: 12, domain: 'acme.test' }))
    await settled()

    expect(document.querySelector<HTMLButtonElement>('[data-sso-domain-submit]')!.disabled).toBe(
      false,
    )
  })
  it('[browser] reports when this instance last backed itself up', async () => {
    // The endpoint has served this since it was written and no screen asked it,
    // so whether the nightly export worked was a question only a terminal could
    // answer.
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const api = companyApi()
    await mountShell(api)

    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLElement>('[data-settings-backup-facts]')?.hidden,
      ).toBe(false),
    )
    const facts = document.querySelector('[data-settings-backup-facts]')!.textContent ?? ''
    expect(facts).toContain('32,516 rows')
    expect(facts).toContain('backups/2026-09-08')
    // Nothing wrong, so no alarm.
    expect(document.querySelector<HTMLElement>('[data-settings-backup-alarm]')?.hidden).toBe(
      true,
    )
    expect(document.querySelector('[data-settings-backup-runs]')?.textContent).toContain(
      'nightly',
    )
  })

  it('[browser] raises the last failure above the table rather than in it', async () => {
    // A failed run found by scanning a table is a failure nobody reads. It is
    // the answer to the only question this section is asked, so it is the
    // first thing on it.
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    backupStatusPayload = {
      last_completed: backupRun(),
      last_failed: backupRun({
        id: 10,
        status: 'failed',
        completed_at: null,
        error_message: 'R2 put failed: 503',
      }),
      recent_runs: [backupRun({ id: 10, status: 'failed', error_message: 'R2 put failed: 503' })],
      has_failure: true,
    }
    await mountShell(companyApi())

    const alarm = document.querySelector<HTMLElement>('[data-settings-backup-alarm]')!
    await vi.waitFor(() => expect(alarm.hidden).toBe(false))
    expect(alarm.textContent).toContain('R2 put failed: 503')
  })

  it('[security] treats never having backed up as an alarm, not as fine', async () => {
    // An empty history reads as "nothing wrong" and is the state in which
    // nothing can be restored.
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    backupStatusPayload = {
      last_completed: null,
      last_failed: null,
      recent_runs: [],
      has_failure: false,
    }
    await mountShell(companyApi())

    const alarm = document.querySelector<HTMLElement>('[data-settings-backup-alarm]')!
    await vi.waitFor(() => expect(alarm.hidden).toBe(false))
    expect(alarm.textContent).toContain('nothing to restore from')
  })

  it('[browser] says where backups live when the deployment does not keep them', async () => {
    // The container composes no reader: its backups are the operator's own
    // filesystem, and an empty section would read as a broken one.
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    const api = companyApi()
    delete (api as { getBackupStatus?: unknown }).getBackupStatus
    await mountShell(api)

    await vi.waitFor(() =>
      expect(document.querySelector('[data-settings-backup-status]')?.textContent).toContain(
        'RESTORE.md',
      ),
    )
  })

describe('the payout connection on company settings (issues 421, 543)', () => {
    const wiseApi = (
      connection: {
        configured: boolean
        connection: {
          profileId: string
          profileName: string | null
          payableRecipients: number
          webhooksVerifiable: boolean
        } | null
      },
    ) => ({
      ...companyApi(),
      getWiseConnection: vi.fn(async () => connection),
    })
  
    const section = (): HTMLElement =>
      document.querySelector<HTMLElement>('[data-settings-wise]')!
  
    it('[money] says which profile pays and how many people it can pay', async () => {
      stubModulesEndpoint()
      renderBrowserShell({ view: 'settings-company' })
      await mountShell(
        wiseApi({
          configured: true,
          connection: {
            profileId: '22239672',
            profileName: 'Example Firm LLC',
            payableRecipients: 3,
            webhooksVerifiable: true,
          },
        }),
      )
  
      await vi.waitFor(() => expect(section().hidden).toBe(false))
      await vi.waitFor(() =>
        expect(
          document.querySelector<HTMLElement>('[data-settings-wise-facts]')!.hidden,
        ).toBe(false),
      )
      expect(section().textContent).toContain('Example Firm LLC')
      expect(section().textContent).toContain('Verified')
      expect(
        document.querySelector<HTMLElement>('[data-settings-wise-alarm]')!.hidden,
      ).toBe(true)
    })
  
    it('[money] raises the alarm when Wise cannot tell us what became of a payout', async () => {
      // Money still leaves without a signing key. What stops is anything ever
      // saying whether it arrived, and that is invisible from everywhere else.
      stubModulesEndpoint()
      renderBrowserShell({ view: 'settings-company' })
      await mountShell(
        wiseApi({
          configured: true,
          connection: {
            profileId: '22239672',
            profileName: 'Example Firm LLC',
            payableRecipients: 3,
            webhooksVerifiable: false,
          },
        }),
      )
  
      const alarm = document.querySelector<HTMLElement>('[data-settings-wise-alarm]')!
      await vi.waitFor(() => expect(alarm.hidden).toBe(false))
      expect(alarm.textContent).toContain('every delivery it sends is refused')
    })
  
    it('[money] treats having nobody to pay as its own alarm', async () => {
      // A healthy connection with an empty recipient list reads as working right
      // up until payday.
      stubModulesEndpoint()
      renderBrowserShell({ view: 'settings-company' })
      await mountShell(
        wiseApi({
          configured: true,
          connection: {
            profileId: '22239672',
            profileName: 'Example Firm LLC',
            payableRecipients: 0,
            webhooksVerifiable: true,
          },
        }),
      )
  
      const alarm = document.querySelector<HTMLElement>('[data-settings-wise-alarm]')!
      await vi.waitFor(() => expect(alarm.hidden).toBe(false))
      expect(alarm.textContent).toContain('nobody this profile can pay')
    })
  
    it('says so plainly when the deployment has no Wise token', async () => {
      stubModulesEndpoint()
      renderBrowserShell({ view: 'settings-company' })
      await mountShell(wiseApi({ configured: false, connection: null }))
  
      await vi.waitFor(() =>
        expect(
          document.querySelector<HTMLElement>('[data-settings-wise-status]')!.textContent,
        ).toContain('Payouts cannot be sent'),
      )
    })
  
    it('[security] shows nobody else where the money leaves from', async () => {
      // Which profile pays and how many people it can pay is a fact about the
      // organisation's money. The whole company-settings controller refuses a
      // member before any section loads, and this holds that: no section, and
      // Wise is never asked.
      stubModulesEndpoint()
      renderBrowserShell({ view: 'settings-company' })
      const getWiseConnection = vi.fn(async () => ({ configured: true, connection: null }))
      await mountShell({
        ...companyApi(),
        whoami: vi.fn(async () => secondIdentity),
        getWiseConnection,
      })

      expect(section().hidden).toBe(true)
      expect(getWiseConnection).not.toHaveBeenCalled()
    })

    it('hides the section entirely in a build without the Wise routes', async () => {
      stubModulesEndpoint()
      renderBrowserShell({ view: 'settings-company' })
      await mountShell(companyApi())
  
      expect(section().hidden).toBe(true)
    })
  })
})
