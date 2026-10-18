/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EzactoClient } from '@conflict-hq/ezacto-client'
import type { LogPageResult } from '../src/components/paged-log.js'
import { createShellApi } from '../src/shell/model.js'
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
  type ShellApi,
  type SsoDomain,
} from './support/shell-harness.js'

describe('company settings', () => {
  // The modules list predates the shell api and still fetches for itself, so a
  // company page that never resolves it leaves every section behind a spinner.
  // Both admin endpoints the company page reads directly rather than through
  // the typed client. Keyed by path, so the sign-in section does not get handed
  // the module payload and draw cards for methods that do not exist. A real
  // Response: those reads go through the shell's fetch, which reads the answer's
  // headers (issue 953).
  const stubModulesEndpoint = (): void => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const path = String(input)
        const data = path.includes('/admin/sign-in-methods')
          ? [{ method: 'password', configured: true, enabled: true }]
          : [{ module: 'expenses', enabled: true }]
        return new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
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
    listBackupRuns: vi
      .fn<
        (query: {
          per_page: number
          cursor?: string
        }) => Promise<LogPageResult<ReturnType<typeof backupRun>>>
      >()
      .mockImplementation(async () => ({
        data: backupStatusPayload.recent_runs,
        links: { next: null },
        page: {
          per_page: 50,
          next_cursor: null,
          total: backupStatusPayload.recent_runs.length,
        },
      })),
    getInvoiceReminders: vi.fn(async () => ({ first_after_days: 3, every_days: 7 })),
    updateInvoiceReminders: vi.fn(
      async (policy: { first_after_days: number; every_days: number } | null) => ({
        policy,
        applied: policy === null ? 0 : 2,
      }),
    ),
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

  afterEach(async () => {
    // happy-dom delivers hashchange on a timer. The controllers this file has
    // mounted keep listening, and each answers the cleared hash by reading the
    // first section, so the event is let through before fetch is unstubbed
    // rather than reaching a real one at teardown.
    globalThis.location.hash = ''
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0))
    vi.unstubAllGlobals()
  })

  // A section is read the first time it is shown (issue 809), so a test opens
  // the page on the section it reads, the way an operator following a link
  // would, and moves between sections the way the strip does: by the hash.
  const openCompanySettings = (section: string): void => {
    renderBrowserShell({ view: 'settings-company' })
    globalThis.location.hash = `#${section}`
  }
  const openSection = (section: string): void => {
    globalThis.location.hash = `#${section}`
    globalThis.dispatchEvent(new Event('hashchange'))
  }

  it('[browser] edits the company information and default values invoices print', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    globalThis.location.hash = '#invoices'
    const updateInvoiceDefaults = vi.fn(async (patch: Record<string, unknown>) => ({
      company_name: 'CONFLICT LLC',
      company_address: null,
      notes: null,
      subject: null,
      ...patch,
    }))
    const api: ShellApi = {
      ...companyApi(),
      getInvoiceDefaults: vi.fn(async () => ({
        company_name: 'CONFLICT LLC',
        company_address: null,
        notes: null,
        subject: null,
      })),
      updateInvoiceDefaults,
    }
    await mountShell(api)

    const form = document.querySelector<HTMLFormElement>('[data-invoice-defaults-form]')!
    await vi.waitFor(() => expect(form.hidden).toBe(false))
    // A missing address is said, because the invoice prints without it.
    expect(document.querySelector('[data-settings-invoices-status]')?.textContent).toContain(
      'No company address yet',
    )
    expect(document.querySelector<HTMLInputElement>('[data-invoice-defaults-name]')!.value).toBe(
      'CONFLICT LLC',
    )
    document.querySelector<HTMLTextAreaElement>('[data-invoice-defaults-address]')!.value =
      '100 Example Ave, STE 200\nSpringfield, IL, 62701'
    document.querySelector<HTMLTextAreaElement>('[data-invoice-defaults-notes]')!.value =
      'Beneficiary:\n*CONFLICT LLC*'
    form.requestSubmit()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-defaults-result]')?.textContent).toBe('Saved.'),
    )
    // Blank subject is no default, sent as null rather than an empty string.
    expect(updateInvoiceDefaults).toHaveBeenLastCalledWith(
      {
        company_name: 'CONFLICT LLC',
        company_address: '100 Example Ave, STE 200\nSpringfield, IL, 62701',
        subject: null,
        notes: 'Beneficiary:\n*CONFLICT LLC*',
      },
      expect.any(AbortSignal),
    )
    globalThis.location.hash = ''
  })

  it('[browser] saves what an invoice email carries by default, writing only what changed', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    globalThis.location.hash = '#invoices'
    const defaults = {
      company_name: 'Northwind Studio',
      company_address: '1 Example Way',
      notes: null,
      subject: null,
    }
    const setOrganizationInvoiceDocuments = vi.fn(
      async (input: Record<string, unknown>) => ({
        attach_pdf: false,
        attach_files: true,
        append_pdfs: false,
        attach_journal: false as const,
        journal_formats: ['pdf' as const],
        ...input,
      }),
    )
    const api: ShellApi = {
      ...companyApi(),
      getInvoiceDefaults: vi.fn(async () => defaults),
      updateInvoiceDefaults: vi.fn(async () => defaults),
      getOrganizationInvoiceDocuments: vi.fn(async () => ({
        attach_pdf: false,
        attach_files: true,
        append_pdfs: false,
        attach_journal: false as const,
        journal_formats: ['pdf' as const],
      })),
      setOrganizationInvoiceDocuments,
    }
    await mountShell(api)

    const form = document.querySelector<HTMLFormElement>('[data-invoice-defaults-form]')!
    await vi.waitFor(() => expect(form.hidden).toBe(false))
    // A third section of the same form, under its own heading.
    const heading = [...form.querySelectorAll('h3')].map((item) => item.textContent)
    expect(heading).toEqual(['Company information', 'Default values', 'Sending'])
    const pdf = form.querySelector<HTMLInputElement>('[data-invoice-defaults-attach-pdf]')!
    const files = form.querySelector<HTMLInputElement>('[data-invoice-defaults-attach-files]')!
    const journal = form.querySelector<HTMLInputElement>('[data-invoice-defaults-attach-journal]')!
    expect(pdf.closest('label')?.hidden).toBe(false)
    expect(pdf.checked).toBe(false)
    expect(files.checked).toBe(true)
    expect(journal.checked).toBe(false)
    // The report's detail and files only matter while it is attached.
    const detail = form.querySelector<HTMLElement>('[data-invoice-defaults-journal-detail]')!
    expect(detail.hidden).toBe(true)

    pdf.click()
    journal.click()
    expect(detail.hidden).toBe(false)
    form.querySelector<HTMLSelectElement>('[data-invoice-defaults-journal-level]')!.value = 'summary'
    form.querySelector<HTMLInputElement>('[data-invoice-defaults-journal-formats] input[value="pdf"]')!.click()
    form.requestSubmit()
    // A report with no files to go as is refused before anything is written.
    expect(document.querySelector('[data-invoice-defaults-result]')?.textContent).toBe(
      'Choose at least one file for the hours report.',
    )
    expect(api.updateInvoiceDefaults).not.toHaveBeenCalled()

    form.querySelector<HTMLInputElement>('[data-invoice-defaults-journal-formats] input[value="xlsx"]')!.click()
    form.requestSubmit()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-defaults-result]')?.textContent).toBe('Saved.'),
    )
    expect(api.updateInvoiceDefaults).toHaveBeenCalledTimes(1)
    // Files were left alone, so they are not written over whatever is stored.
    expect(setOrganizationInvoiceDocuments).toHaveBeenCalledWith(
      { attach_pdf: true, attach_journal: 'summary', journal_formats: ['xlsx'] },
      expect.any(AbortSignal),
    )

    // Saving again with nothing changed under Sending writes only the rest.
    form.requestSubmit()
    await vi.waitFor(() => expect(api.updateInvoiceDefaults).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-defaults-result]')?.textContent).toBe('Saved.'),
    )
    expect(setOrganizationInvoiceDocuments).toHaveBeenCalledTimes(1)
    globalThis.location.hash = ''
  })

  it('[security] on the public demo, keeps what invoices print read-only and still saves how they are sent', async () => {
    // Issue 931. The notes are where an invoice tells a client which account
    // to pay, so on the demo they are not a visitor's to change; the Worker
    // refuses the write, and the form says so rather than failing on Save.
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company', demo: true })
    globalThis.location.hash = '#invoices'
    const defaults = {
      company_name: 'Folding Forks',
      company_address: '1 Example Way',
      notes: 'Pay to account 000-000.',
      subject: null,
    }
    const setOrganizationInvoiceDocuments = vi.fn(async (input: Record<string, unknown>) => ({
      attach_pdf: false,
      attach_files: true,
      append_pdfs: false,
      attach_journal: false as const,
      journal_formats: ['pdf' as const],
      ...input,
    }))
    const api: ShellApi = {
      ...companyApi(),
      getInvoiceDefaults: vi.fn(async () => defaults),
      updateInvoiceDefaults: vi.fn(async () => defaults),
      getOrganizationInvoiceDocuments: vi.fn(async () => ({
        attach_pdf: false,
        attach_files: true,
        append_pdfs: false,
        attach_journal: false as const,
        journal_formats: ['pdf' as const],
      })),
      setOrganizationInvoiceDocuments,
    }
    await mountShell(api)

    const form = document.querySelector<HTMLFormElement>('[data-invoice-defaults-form]')!
    await vi.waitFor(() => expect(form.hidden).toBe(false))
    const note = document.querySelector<HTMLElement>('[data-invoice-defaults-demo]')!
    expect(note.hidden).toBe(false)
    expect(note.textContent).toBe(
      'Company information and default values: not available on the public demo.',
    )
    for (const selector of [
      '[data-invoice-defaults-name]',
      '[data-invoice-defaults-address]',
      '[data-invoice-defaults-subject]',
      '[data-invoice-defaults-notes]',
    ]) {
      expect(form.querySelector<HTMLInputElement>(selector)!.disabled).toBe(true)
    }

    form.querySelector<HTMLInputElement>('[data-invoice-defaults-attach-pdf]')!.click()
    form.requestSubmit()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-defaults-result]')?.textContent).toBe('Saved.'),
    )
    expect(api.updateInvoiceDefaults).not.toHaveBeenCalled()
    expect(setOrganizationInvoiceDocuments).toHaveBeenCalledWith(
      { attach_pdf: true },
      expect.any(AbortSignal),
    )
    globalThis.location.hash = ''
  })

  it('[security] on the public demo, says QuickBooks and uploaded marks are not available, and asks nothing', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company', demo: true })
    globalThis.location.hash = '#integrations'
    const api: ShellApi = {
      ...companyApi(),
      getQuickBooksConnection: vi.fn(async () => ({ configured: true, connection: null })),
    }
    await mountShell(api)

    const status = document.querySelector<HTMLElement>('[data-settings-quickbooks-status]')!
    await vi.waitFor(() => expect(status.textContent).toBe('Not available on the public demo.'))
    // The demo composes no QuickBooks, so a read could only fail and offer a
    // retry that fails again.
    expect(api.getQuickBooksConnection).not.toHaveBeenCalled()
    expect(document.querySelector<HTMLElement>('[data-settings-quickbooks-actions]')!.hidden).toBe(
      true,
    )

    openSection('brand')
    const brand = document.querySelector<HTMLElement>('[data-settings-brand-slots]')!
    await vi.waitFor(() => expect(brand.hidden).toBe(false))
    const pickers = [...brand.querySelectorAll<HTMLInputElement>('input[type="file"]')]
    expect(pickers.length).toBeGreaterThan(0)
    expect(pickers.every((picker) => picker.disabled)).toBe(true)
    expect(document.querySelector<HTMLElement>('[data-settings-brand-demo]')!.hidden).toBe(false)
    globalThis.location.hash = ''
  })

  it('[security] on the public demo, shows the ways in and the SSO domains and changes neither', async () => {
    // Issue 931. Every visitor is the same administrator: a sign-in method
    // switched off or a domain removed is the next visitor locked out, so the
    // Worker refuses both and the page offers neither.
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company', demo: true })
    globalThis.location.hash = '#sign-in'
    const api = companyApi([senderIdentity()], [ssoDomain()])
    await mountShell(api)

    const toggle = (): HTMLInputElement | null =>
      document.querySelector<HTMLInputElement>('[data-sign-in-toggle="password"]')
    await vi.waitFor(() => expect(toggle()).not.toBeNull())
    expect(toggle()!.checked).toBe(true)
    expect(toggle()!.disabled).toBe(true)
    expect(document.querySelector('[data-settings-sign-in-status]')!.textContent).toBe(
      'Switching a sign-in method: not available on the public demo.',
    )

    openSection('sso')
    await vi.waitFor(() => expect(ssoTable().hidden).toBe(false))
    expect(ssoTable().textContent).toContain('northpeak.test')
    expect(ssoAction(0, 'Verify').disabled).toBe(true)
    expect(ssoAction(0, 'Remove').disabled).toBe(true)
    expect(document.querySelector<HTMLFormElement>('[data-sso-domain-form]')!.hidden).toBe(true)
    expect(document.querySelector('[data-settings-sso-status]')!.textContent).toBe(
      'Adding, verifying or removing a domain: not available on the public demo.',
    )
    expect(api.verifySsoDomain).not.toHaveBeenCalled()
    expect(api.removeSsoDomain).not.toHaveBeenCalled()
    globalThis.location.hash = ''
  })

  it('[browser] keeps the ways in and the SSO domains changeable anywhere but the demo', async () => {
    stubModulesEndpoint()
    openCompanySettings('sign-in')
    await mountShell(companyApi([senderIdentity()], [ssoDomain()]))

    const toggle = (): HTMLInputElement | null =>
      document.querySelector<HTMLInputElement>('[data-sign-in-toggle="password"]')
    await vi.waitFor(() => expect(toggle()).not.toBeNull())
    expect(toggle()!.disabled).toBe(false)
    expect(document.querySelector('[data-settings-sign-in-status]')!.textContent).toBe('')

    openSection('sso')
    await vi.waitFor(() => expect(ssoTable().hidden).toBe(false))
    expect(ssoAction(0, 'Verify').disabled).toBe(false)
    expect(ssoAction(0, 'Remove').disabled).toBe(false)
    expect(document.querySelector<HTMLFormElement>('[data-sso-domain-form]')!.hidden).toBe(false)
    expect(document.querySelector('[data-settings-sso-status]')!.textContent).toBe('')
  })

  it('[browser] says which half of the invoice settings a failed save kept', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    globalThis.location.hash = '#invoices'
    const defaults = { company_name: 'Northwind Studio', company_address: null, notes: null, subject: null }
    const api: ShellApi = {
      ...companyApi(),
      getInvoiceDefaults: vi.fn(async () => defaults),
      updateInvoiceDefaults: vi.fn(async () => defaults),
      getOrganizationInvoiceDocuments: vi.fn(async () => ({
        attach_pdf: false,
        attach_files: false,
        append_pdfs: false,
        attach_journal: false as const,
        journal_formats: ['pdf' as const],
      })),
      setOrganizationInvoiceDocuments: vi.fn(async () => {
        throw new Error('Storage unavailable.')
      }),
    }
    await mountShell(api)
    const form = document.querySelector<HTMLFormElement>('[data-invoice-defaults-form]')!
    await vi.waitFor(() => expect(form.hidden).toBe(false))
    form.querySelector<HTMLInputElement>('[data-invoice-defaults-attach-pdf]')!.click()
    form.requestSubmit()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-defaults-result]')?.textContent).toBe(
        'The company information and default values were saved, but the sending defaults were not: Storage unavailable.',
      ),
    )
    globalThis.location.hash = ''
  })

  it('[browser] keeps the rest of the invoice settings when the sending defaults cannot be read', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    globalThis.location.hash = '#invoices'
    const defaults = { company_name: 'Northwind Studio', company_address: '1 Example Way', notes: null, subject: null }
    const api: ShellApi = {
      ...companyApi(),
      getInvoiceDefaults: vi.fn(async () => defaults),
      updateInvoiceDefaults: vi.fn(async () => defaults),
      getOrganizationInvoiceDocuments: vi.fn(async () => {
        throw new Error('Storage unavailable.')
      }),
      setOrganizationInvoiceDocuments: vi.fn(),
    }
    await mountShell(api)
    const form = document.querySelector<HTMLFormElement>('[data-invoice-defaults-form]')!
    await vi.waitFor(() => expect(form.hidden).toBe(false))
    expect(document.querySelector('[data-settings-invoices-status]')?.textContent).toBe(
      'The sending defaults could not be loaded: Storage unavailable.',
    )
    expect(
      [...form.querySelectorAll<HTMLElement>('[data-invoice-defaults-sending]')].every(
        (part) => part.hidden,
      ),
    ).toBe(true)
    form.requestSubmit()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-defaults-result]')?.textContent).toBe('Saved.'),
    )
    expect(api.setOrganizationInvoiceDocuments).not.toHaveBeenCalled()
    globalThis.location.hash = ''
  })

  const sendingDocuments = {
    attach_pdf: true,
    attach_files: true,
    append_pdfs: false,
    attach_journal: false as const,
    journal_formats: ['pdf' as const],
  }

  it('[browser] saves the PDFs bound behind the invoice and the addresses copied on every invoice email', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    globalThis.location.hash = '#invoices'
    const defaults = { company_name: 'Northwind Studio', company_address: '1 Example Way', notes: null, subject: null }
    const setOrganizationInvoiceDocuments = vi.fn(async (input: Record<string, unknown>) => ({
      ...sendingDocuments,
      ...input,
    }))
    // Stored as the mailer takes them: lower-cased.
    const setOrganizationInvoiceSending = vi.fn(
      async (input: { always_cc: { name: string; email: string }[] }) => ({
        always_cc: input.always_cc.map(({ name, email }) => ({ name, email: email.toLowerCase() })),
      }),
    )
    const api: ShellApi = {
      ...companyApi(),
      getInvoiceDefaults: vi.fn(async () => defaults),
      updateInvoiceDefaults: vi.fn(async () => defaults),
      getOrganizationInvoiceDocuments: vi.fn(async () => sendingDocuments),
      setOrganizationInvoiceDocuments,
      getOrganizationInvoiceSending: vi.fn(async () => ({
        always_cc: [{ name: 'Finance', email: 'finance@example.com' }],
      })),
      setOrganizationInvoiceSending,
    }
    await mountShell(api)

    const form = document.querySelector<HTMLFormElement>('[data-invoice-defaults-form]')!
    await vi.waitFor(() => expect(form.hidden).toBe(false))
    const result = () => document.querySelector('[data-invoice-defaults-result]')?.textContent
    const append = form.querySelector<HTMLInputElement>('[data-invoice-defaults-append-pdfs]')!
    expect(append.closest('label')?.hidden).toBe(false)
    expect(append.closest('label')?.textContent).toBe(
      'Append attached PDFs to the back of the invoice PDF by default',
    )
    expect(append.checked).toBe(false)
    const alwaysCc = form.querySelector<HTMLTextAreaElement>('[data-invoice-defaults-always-cc-list]')!
    expect(alwaysCc.closest('label')?.hidden).toBe(false)
    expect(alwaysCc.closest('label')?.textContent).toContain(
      'Always copy these addresses on invoice emails',
    )
    expect(alwaysCc.value).toBe('Finance <finance@example.com>')

    // An address the route would refuse is named before anything is written.
    alwaysCc.value = 'Finance <finance@example.com>\nnot-an-address'
    form.requestSubmit()
    expect(result()).toBe(
      'Always copy: “not-an-address” is not an email address. Write email@example.com or Name <email@example.com>.',
    )
    expect(api.updateInvoiceDefaults).not.toHaveBeenCalled()

    append.click()
    alwaysCc.value = 'Finance <finance@example.com>\nBooks <Books@Example.com>'
    form.requestSubmit()
    await vi.waitFor(() => expect(result()).toBe('Saved.'))
    expect(setOrganizationInvoiceDocuments).toHaveBeenCalledWith(
      { append_pdfs: true },
      expect.any(AbortSignal),
    )
    expect(setOrganizationInvoiceSending).toHaveBeenCalledWith(
      {
        always_cc: [
          { name: 'Finance', email: 'finance@example.com' },
          { name: 'Books', email: 'Books@Example.com' },
        ],
      },
      expect.any(AbortSignal),
    )
    // The list is shown as it was stored.
    expect(alwaysCc.value).toBe('Finance <finance@example.com>\nBooks <books@example.com>')

    // Saving again with nothing changed under Sending writes only the rest.
    form.requestSubmit()
    await vi.waitFor(() => expect(api.updateInvoiceDefaults).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(result()).toBe('Saved.'))
    expect(setOrganizationInvoiceDocuments).toHaveBeenCalledTimes(1)
    expect(setOrganizationInvoiceSending).toHaveBeenCalledTimes(1)
    globalThis.location.hash = ''
  })

  it('[browser] says the addresses to always copy were the part a failed save did not keep', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    globalThis.location.hash = '#invoices'
    const defaults = { company_name: 'Northwind Studio', company_address: null, notes: null, subject: null }
    const api: ShellApi = {
      ...companyApi(),
      getInvoiceDefaults: vi.fn(async () => defaults),
      updateInvoiceDefaults: vi.fn(async () => defaults),
      getOrganizationInvoiceDocuments: vi.fn(async () => sendingDocuments),
      setOrganizationInvoiceDocuments: vi.fn(async () => sendingDocuments),
      getOrganizationInvoiceSending: vi.fn(async () => ({ always_cc: [] })),
      setOrganizationInvoiceSending: vi.fn(async () => {
        throw new Error('Storage unavailable.')
      }),
    }
    await mountShell(api)
    const form = document.querySelector<HTMLFormElement>('[data-invoice-defaults-form]')!
    await vi.waitFor(() => expect(form.hidden).toBe(false))
    form.querySelector<HTMLTextAreaElement>('[data-invoice-defaults-always-cc-list]')!.value =
      'finance@example.com'
    form.requestSubmit()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-defaults-result]')?.textContent).toBe(
        'Everything else was saved, but the addresses to always copy were not: Storage unavailable.',
      ),
    )
    globalThis.location.hash = ''
  })

  it('[browser] keeps the attachment defaults when the addresses to always copy cannot be read', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    globalThis.location.hash = '#invoices'
    const defaults = { company_name: 'Northwind Studio', company_address: '1 Example Way', notes: null, subject: null }
    const api: ShellApi = {
      ...companyApi(),
      getInvoiceDefaults: vi.fn(async () => defaults),
      updateInvoiceDefaults: vi.fn(async () => defaults),
      getOrganizationInvoiceDocuments: vi.fn(async () => sendingDocuments),
      setOrganizationInvoiceDocuments: vi.fn(async () => sendingDocuments),
      getOrganizationInvoiceSending: vi.fn(async () => {
        throw new Error('Storage unavailable.')
      }),
      setOrganizationInvoiceSending: vi.fn(),
    }
    await mountShell(api)
    const form = document.querySelector<HTMLFormElement>('[data-invoice-defaults-form]')!
    await vi.waitFor(() => expect(form.hidden).toBe(false))
    expect(document.querySelector('[data-settings-invoices-status]')?.textContent).toBe(
      'The addresses to always copy could not be loaded: Storage unavailable.',
    )
    expect(
      [...form.querySelectorAll<HTMLElement>('[data-invoice-defaults-always-cc]')].every(
        (part) => part.hidden,
      ),
    ).toBe(true)
    // The attachment half read, so its heading and boxes stay.
    expect(form.querySelector<HTMLElement>('h3[data-invoice-defaults-sending]')!.hidden).toBe(false)
    expect(
      form.querySelector<HTMLInputElement>('[data-invoice-defaults-append-pdfs]')!.closest('label')!
        .hidden,
    ).toBe(false)
    form.requestSubmit()
    await vi.waitFor(() =>
      expect(document.querySelector('[data-invoice-defaults-result]')?.textContent).toBe('Saved.'),
    )
    expect(api.setOrganizationInvoiceSending).not.toHaveBeenCalled()
    globalThis.location.hash = ''
  })

  it('[unit] binds the addresses to always copy to the settings operations', async () => {
    const stored = { always_cc: [{ name: 'Finance', email: 'finance@example.com' }] }
    const generated = {
      getOrganizationInvoiceSending: vi.fn(async () => ({ data: stored })),
      setOrganizationInvoiceSending: vi.fn(async () => ({ data: stored })),
    }
    const api = createShellApi(generated as unknown as EzactoClient)
    const signal = new AbortController().signal

    expect(await api.getOrganizationInvoiceSending!(signal)).toEqual(stored)
    expect(await api.setOrganizationInvoiceSending!(stored, signal)).toEqual(stored)
    expect(generated.getOrganizationInvoiceSending).toHaveBeenCalledWith({ signal })
    expect(generated.setOrganizationInvoiceSending).toHaveBeenCalledWith({ body: stored, signal })
  })

  it('[browser #801] shows the payment reminder default, saves a change, and switches it off', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    globalThis.location.hash = '#reminders'
    const api = companyApi()
    await mountShell(api)

    const form = document.querySelector<HTMLFormElement>('[data-reminder-settings-form]')!
    const enabled = document.querySelector<HTMLInputElement>('[data-reminder-settings-enabled]')!
    const first = document.querySelector<HTMLInputElement>('[data-reminder-settings-first]')!
    const every = document.querySelector<HTMLInputElement>('[data-reminder-settings-every]')!
    const result = document.querySelector<HTMLElement>('[data-reminder-settings-result]')!
    await vi.waitFor(() => expect(form.hidden).toBe(false))
    expect(enabled.checked).toBe(true)
    expect(first.value).toBe('3')
    expect(every.value).toBe('7')

    first.value = '14'
    every.value = '14'
    form.requestSubmit()
    await vi.waitFor(() =>
      expect(result.textContent).toBe('Saved. Booked for 2 open invoices with nothing pending.'),
    )
    expect(api.updateInvoiceReminders).toHaveBeenLastCalledWith(
      { first_after_days: 14, every_days: 14 },
      expect.any(AbortSignal),
    )

    // Off sends null, and the numbers grey out rather than vanish: what the
    // default would be when switched back on is still worth seeing.
    enabled.checked = false
    enabled.dispatchEvent(new Event('change'))
    expect(first.disabled).toBe(true)
    form.requestSubmit()
    await vi.waitFor(() => expect(result.textContent).toBe('Saved. Payment reminders are off.'))
    expect(api.updateInvoiceReminders).toHaveBeenLastCalledWith(null, expect.any(AbortSignal))
    globalThis.location.hash = ''
  })

  it('[browser #800] shows one section at a time, chosen by the hash, and links each one', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    globalThis.location.hash = '#integrations'
    await mountShell(companyApi())

    const visible = (): string[] =>
      [...document.querySelectorAll<HTMLElement>('[data-settings-section]')]
        .filter((section) => !section.hidden)
        .map((section) => section.dataset.settingsSection!)
    // Where the QuickBooks consent screen sends an operator back to: the
    // accounting section, and only it.
    expect(visible()).toEqual(['integrations'])
    const current = document.querySelector<HTMLElement>('[data-settings-section-link][aria-current="page"]')!
    expect(current.dataset.settingsSectionLink).toBe('integrations')

    // The strip is plain anchors; following one is a hash change.
    globalThis.location.hash = '#sso'
    globalThis.dispatchEvent(new Event('hashchange'))
    expect(visible()).toEqual(['sso'])

    // Payouts is not offered until the deployment has the Wise routes, and a
    // stale link to it opens the first section rather than a blank page.
    expect(document.querySelector<HTMLElement>('[data-settings-section-link="payouts"]')!.hidden).toBe(true)
    globalThis.location.hash = '#payouts'
    globalThis.dispatchEvent(new Event('hashchange'))
    expect(visible()).toEqual(['modules'])
    globalThis.location.hash = ''
  })

  const fetchedPaths = (): string[] =>
    (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((call) =>
      String(call[0]).replace(/^https?:\/\/[^/]+/u, ''),
    )

  it('[browser #809] reads a section the first time it is shown, and not again', async () => {
    // Every section's reads used to go out the moment the page opened, so
    // opening Accounting called Wise and the module toggles waited on
    // QuickBooks. A section is read when it is shown, and once.
    stubModulesEndpoint()
    openCompanySettings('integrations')
    const api = {
      ...companyApi([senderIdentity()], [ssoDomain()]),
      getQuickBooksConnection: vi.fn(async () => ({ configured: true, connection: null })),
      getWiseConnection: vi.fn(async () => ({ configured: true, connection: null })),
    }
    await mountShell(api)

    await vi.waitFor(() => expect(api.getQuickBooksConnection).toHaveBeenCalledTimes(1))
    expect(api.getWiseConnection).not.toHaveBeenCalled()
    // The week grid reads the tracking settings for every page; the notes
    // policy is the Time section's own read.
    expect(api.getTimeEntryNoteSettings).not.toHaveBeenCalled()
    expect(api.getInvoiceReminders).not.toHaveBeenCalled()
    expect(api.listSenderIdentities).not.toHaveBeenCalled()
    expect(api.getEmailHealth).not.toHaveBeenCalled()
    expect(api.getBackupStatus).not.toHaveBeenCalled()
    expect(api.listSsoDomains).not.toHaveBeenCalled()
    // The three sections that fetch for themselves are not read either.
    expect(fetchedPaths()).not.toContain('/api/v1/admin/modules')
    expect(fetchedPaths()).not.toContain('/api/v1/admin/sign-in-methods')
    expect(fetchedPaths()).not.toContain('/api/v1/settings/brand-assets')

    openSection('payouts')
    await vi.waitFor(() => expect(api.getWiseConnection).toHaveBeenCalledTimes(1))
    expect(api.getQuickBooksConnection).toHaveBeenCalledTimes(1)

    // Back to a section already read: nothing goes out.
    openSection('integrations')
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0))
    expect(api.getQuickBooksConnection).toHaveBeenCalledTimes(1)
    expect(api.getWiseConnection).toHaveBeenCalledTimes(1)
    expect(api.listSsoDomains).not.toHaveBeenCalled()
  })

  it('[browser #809] offers Retry on a failed read, with the request id, and retries that section only', async () => {
    // "ezacto API request failed with status 500" named neither the section
    // nor what to do, and the only way to try again was a reload.
    stubModulesEndpoint()
    openCompanySettings('integrations')
    let attempts = 0
    const api = {
      ...companyApi([senderIdentity()], [ssoDomain()]),
      getQuickBooksConnection: vi.fn(async () => {
        attempts += 1
        if (attempts === 1) {
          throw new EzactoApiError(
            500,
            { error: { code: 'internal', message: 'server detail is not rendered' } },
            'req-7f3a9c',
          )
        }
        return { configured: true, connection: null }
      }),
      getWiseConnection: vi.fn(async () => ({ configured: true, connection: null })),
    }
    await mountShell(api)

    const status = document.querySelector<HTMLElement>('[data-settings-quickbooks-status]')!
    await vi.waitFor(() =>
      expect(status.textContent).toContain('The QuickBooks connection could not be read.'),
    )
    // The id is how the failure is found in the Worker log and in Sentry.
    expect(status.textContent).toContain('request id req-7f3a9c')
    const retry = status.querySelector<HTMLButtonElement>('[data-settings-retry="integrations"]')
    expect(retry).not.toBeNull()

    retry!.click()
    await vi.waitFor(() => expect(api.getQuickBooksConnection).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(status.textContent).toBe('Not connected.'))
    // Cleared on success, and no other section was asked.
    expect(status.querySelector('[data-settings-retry]')).toBeNull()
    expect(api.getWiseConnection).not.toHaveBeenCalled()
    expect(api.listSsoDomains).not.toHaveBeenCalled()

    // An operator who connected in another tab reads the section again from
    // the heading, and the cache forgets it.
    document.querySelector<HTMLButtonElement>('[data-settings-refresh="integrations"]')!.click()
    await vi.waitFor(() => expect(api.getQuickBooksConnection).toHaveBeenCalledTimes(3))
    expect(api.getWiseConnection).not.toHaveBeenCalled()
  })

  it('[browser #809] keeps a configuration answer as an answer, with nothing to retry', async () => {
    // A 403 is what this profile may read, not a failure to read it.
    stubModulesEndpoint()
    openCompanySettings('integrations')
    const api = {
      ...companyApi([senderIdentity()], []),
      getQuickBooksConnection: vi.fn(async () => {
        throw new EzactoApiError(403, { error: { code: 'profile_forbidden' } }, 'req-403')
      }),
    }
    await mountShell(api)

    const status = document.querySelector<HTMLElement>('[data-settings-quickbooks-status]')!
    await vi.waitFor(() =>
      expect(status.textContent).toBe('Connecting an accounting system is an administrator action.'),
    )
    expect(status.querySelector('[data-settings-retry]')).toBeNull()
  })

  it('[unit] shows the instance configuration the endpoints already served', async () => {
    // Every setting on this page had an endpoint and no reader: the notes
    // policy, the tracking mode, the address this instance sends as and how
    // that mail lands were all reachable only with a token and a terminal.
    stubModulesEndpoint()
    openCompanySettings('time')
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

    openSection('email')
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
    openCompanySettings('integrations')
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
      value: { ...original, hash: '#integrations', assign },
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
    openCompanySettings('integrations')
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
    openCompanySettings('integrations')
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
    openCompanySettings('integrations')
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
    openCompanySettings('email')
    const api = companyApi([senderIdentity()], [ssoDomain()])
    const controller = createModuleSettingsController(api as never)

    await controller.activate(identity, new AbortController().signal, () => false)
    const senders = document.querySelector<HTMLElement>('[data-settings-sender-identities]')!
    await vi.waitFor(() => expect(senders.hidden).toBe(false))
    expect(document.body.textContent).toContain('billing@northpeak.test')
    openSection('sso')
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('ezacto-verification=zLp7c4Qk'),
    )

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
    openCompanySettings('time')
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
    openCompanySettings('time')
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
    openCompanySettings('email')
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
    // The notes policy is theirs to set, so that section still loads.
    openSection('time')
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
    openCompanySettings('sso')
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
    openCompanySettings('sso')
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
    openCompanySettings('sso')
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
    openCompanySettings('sso')
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
    openCompanySettings('sso')
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
    openCompanySettings('sso')
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
    openCompanySettings('sso')
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
    openCompanySettings('sso')
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
    openCompanySettings('sso')
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
    openCompanySettings('sso')
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
    openCompanySettings('sso')
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
    openCompanySettings('time')
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
    openCompanySettings('sso')
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
    openCompanySettings('sso')
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
    openCompanySettings('backup')
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

  it('[browser] pages the whole backup history, not just the latest runs (#929)', async () => {
    // The status carries the latest twenty runs, which is enough to say whether
    // the last one worked and not enough to find the one before it.
    stubModulesEndpoint()
    openCompanySettings('backup')
    const api = companyApi()
    api.listBackupRuns
      .mockResolvedValueOnce({
        data: [backupRun({ id: 9 })],
        links: { next: '/api/v1/backup/runs?per_page=50&cursor=b1' },
        page: { per_page: 50, next_cursor: 'b1', total: 61 },
      })
      .mockResolvedValueOnce({
        data: [backupRun({ id: 8, trigger: 'manual' })],
        links: { next: null },
        page: { per_page: 50, next_cursor: null, total: 61 },
      })
    await mountShell(api)

    await vi.waitFor(() =>
      expect(document.querySelector('[data-settings-backup-runs] .log-pager-count')?.textContent).toBe(
        'Rows 1–1 of 61',
      ),
    )
    const older = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-settings-backup-runs] button'),
    ].find((button) => button.textContent === 'Older')!
    older.click()
    await vi.waitFor(() =>
      expect(api.listBackupRuns).toHaveBeenLastCalledWith(
        { per_page: 50, cursor: 'b1' },
        expect.anything(),
      ),
    )
    await vi.waitFor(() =>
      expect(document.querySelector('[data-settings-backup-runs]')?.textContent).toContain('manual'),
    )
    // The place is in the address, beside the section the page is on.
    expect(globalThis.location.search).toBe('?backup_cursor=b1&backup_offset=1')
    expect(globalThis.location.hash).toBe('#backup')
  })

  it('[browser] says when a backup started in the organization timezone (#929)', async () => {
    stubModulesEndpoint()
    openCompanySettings('backup')
    const api = {
      ...companyApi(),
      getTimesheetLockPolicy: vi.fn(async () => ({
        auto_lock: false,
        timesheet_deadline: null,
        timezone: 'America/Costa_Rica',
        week_start_day: 'monday' as const,
        updated_at: timestamp,
      })),
    }
    await mountShell(api)
    await vi.waitFor(() =>
      expect(
        document.querySelector('[data-settings-backup-runs] th[data-column="started"]')?.textContent,
      ).toBe('Started (America/Costa_Rica)'),
    )
    // 03:00 UTC is the evening before at UTC-6.
    expect(
      document.querySelector('[data-settings-backup-runs] td[data-column="started"]')?.textContent,
    ).toBe('2026-09-07 21:00')
  })

  it('[browser] raises the last failure above the table rather than in it', async () => {
    // A failed run found by scanning a table is a failure nobody reads. It is
    // the answer to the only question this section is asked, so it is the
    // first thing on it.
    stubModulesEndpoint()
    openCompanySettings('backup')
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
    openCompanySettings('backup')
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
    openCompanySettings('backup')
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
    // The company page shows one section at a time, chosen by the hash (issue
    // 800), so these open on Payouts the way an operator reading it would. Set
    // after the render, which puts the page's own URL in place.
    const openOnPayouts = (): void => {
      renderBrowserShell({ view: 'settings-company' })
      globalThis.location.hash = '#payouts'
    }
    afterEach(() => {
      globalThis.location.hash = ''
    })

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
      openOnPayouts()
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
      openOnPayouts()
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
      openOnPayouts()
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
      openOnPayouts()
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
      openOnPayouts()
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
      openOnPayouts()
      await mountShell(companyApi())
  
      expect(section().hidden).toBe(true)
    })

    it('[browser] a deployment without a Wise token is a state, not a failure to retry', async () => {
      // The generated client always has the method, so the only thing that
      // says whether Payouts applies is the route answering 404 (no token on
      // the Worker). ezacto.io showed "could not be loaded ... Retry" with a
      // request id for exactly that after #809 made the section lazy.
      stubModulesEndpoint()
      openOnPayouts()
      await mountShell({
          ...companyApi(),
          getWiseConnection: vi.fn(async () => {
            throw new EzactoApiError(
              404,
              { error: { code: 'not_found', message: 'The requested resource does not exist.', fields: [] } },
              'req-404',
            )
          }),
      })

      const status = document.querySelector<HTMLElement>('[data-settings-wise-status]')!
      await vi.waitFor(() => expect(status.textContent).toContain('not connected on this deployment'))
      expect(status.textContent).not.toContain('Retry')
      expect(document.querySelector('[data-settings-retry="payouts"]')).toBeNull()
      expect(section().hasAttribute('data-settings-unavailable')).toBe(true)
      expect(document.querySelector<HTMLElement>('[data-settings-section-link="payouts"]')!.hidden).toBe(true)
    })
  })
})
