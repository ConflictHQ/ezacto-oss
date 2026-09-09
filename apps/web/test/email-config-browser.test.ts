/** @vitest-environment happy-dom */

import type {
  EmailTemplate,
  EmailTemplateVariableGroup,
  SenderIdentity,
  Whoami,
} from '@ezacto/client'
import { describe, expect, it, vi } from 'vitest'
import { createEmailConfigurationController } from '../src/email-config/browser.js'
import type { EmailConfigurationApi } from '../src/email-config/model.js'
import { invoiceTabs, renderAppShell } from '../src/index.js'

const timestamp = '2026-09-09T12:00:00.000Z'

const defaultSender: SenderIdentity = {
  id: 1,
  email: 'billing@example.com',
  display_name: 'Folding Forks',
  reply_to_email: 'hello@example.com',
  provider: 'mailgun',
  provider_identity: 'example.com',
  is_default: true,
  version: 2,
  archived_at: null,
  evidence: {
    version: 3,
    source: 'provider_api',
    identity_kind: 'domain',
    verification_status: 'verified',
    dkim_status: 'verified',
    mail_from_domain: 'mail.example.com',
    mail_from_status: 'verified',
    observed_at: timestamp,
  },
  created_by_user_id: 1,
  created_at: timestamp,
  updated_at: timestamp,
}

const spare: SenderIdentity = {
  ...defaultSender,
  id: 2,
  email: 'accounts@example.com',
  is_default: false,
  version: 1,
  evidence: null,
}

const invoiceTemplate: EmailTemplate = {
  kind: 'invoice',
  version: 4,
  subject_template: 'Invoice %invoice_number% from %company_name%',
  text_template: 'Amount due: %invoice_amount%',
  html_template: null,
  unknown_variable_policy: 'error',
  created_by_user_id: 1,
  created_at: timestamp,
}

const reminderTemplate: EmailTemplate = {
  ...invoiceTemplate,
  kind: 'reminder',
  version: 1,
  subject_template: 'Reminder: %invoice_number%',
}

const catalog: readonly EmailTemplateVariableGroup[] = [
  {
    kind: 'invoice',
    variables: [
      { name: 'invoice_number', token: '%invoice_number%', description: 'The number', compatibility: 'harvest' },
      { name: 'company_name', token: '%company_name%', description: 'Your name', compatibility: 'harvest' },
      { name: 'invoice_amount', token: '%invoice_amount%', description: 'The total', compatibility: 'harvest' },
    ],
  },
]

const identity = (): Whoami => ({
  user_id: 1,
  profile: 'administrator',
  manager_grants: [],
  authentication: { kind: 'session' },
})

const writeDocument = (path = '/invoices/configure'): void => {
  window.history.replaceState(null, '', path)
  document.open()
  document.write(
    renderAppShell({
      environment: 'test',
      release: 'email-config-test',
      activeSection: 'Invoices',
      view: 'invoice-configure',
      tabs: invoiceTabs('invoice-configure'),
    })
      .replace(
        / {2}<link[^>]+(?:fonts\.googleapis|fonts\.gstatic|\/assets\/ezacto\.css)[^>]*>\n/gu,
        '',
      )
      .replace('  <script type="module" src="/assets/ezacto.js"></script>\n', ''),
  )
  document.close()
}

const baseApi = (
  overrides: Partial<EmailConfigurationApi> = {},
): Partial<EmailConfigurationApi> => ({
  listSenderIdentities: vi.fn(async () => [defaultSender, spare]),
  setDefaultSenderIdentity: vi.fn(async () => spare),
  archiveSenderIdentity: vi.fn(async () => spare),
  refreshSenderIdentityEvidence: vi.fn(async () => defaultSender),
  listEmailTemplates: vi.fn(async () => [invoiceTemplate, reminderTemplate]),
  listEmailTemplateVersions: vi.fn(async () => [invoiceTemplate]),
  listEmailTemplateVariables: vi.fn(async () => catalog),
  createEmailTemplateVersion: vi.fn(async () => ({ ...invoiceTemplate, version: 5 })),
  ...overrides,
})

const activate = async (
  api: Partial<EmailConfigurationApi>,
  signal = new AbortController().signal,
): Promise<void> => {
  await createEmailConfigurationController(api).activate(identity(), signal, () => false)
}

const senderText = (): string =>
  document.querySelector('[data-sender-list]')?.textContent ?? ''

const openInvoiceTemplate = async (api: Partial<EmailConfigurationApi>): Promise<void> => {
  document
    .querySelector<HTMLButtonElement>('[data-template-list] tr[data-row-key="invoice"] button')!
    .click()
  await vi.waitFor(() =>
    expect(document.querySelector<HTMLElement>('[data-template-editor]')?.hidden).toBe(false),
  )
  await vi.waitFor(() => expect(api.listEmailTemplateVersions).toHaveBeenCalled())
}

describe('Email configuration controller', () => {
  it('[browser] shows who mail comes from, and what the provider says about it', async () => {
    writeDocument()
    await activate(baseApi())

    expect(senderText()).toContain('billing@example.com')
    expect(senderText()).toContain('Verified')
    // Never checked is not the same as verified, and says so.
    expect(senderText()).toContain('Never checked')
    // Default first.
    const rows = [...document.querySelectorAll('[data-sender-list] tbody tr[data-row]')]
    expect(rows.map((row) => row.getAttribute('data-row-key'))).toEqual(['1', '2'])
  })

  it('[security] warns when the default sender will be refused', async () => {
    writeDocument()
    await activate(
      baseApi({
        listSenderIdentities: vi.fn(async () => [
          { ...defaultSender, evidence: { ...defaultSender.evidence!, dkim_status: 'failed' as const } },
        ]),
      }),
    )

    const warning = document.querySelector<HTMLElement>('[data-sender-warning]')!
    expect(warning.hidden).toBe(false)
    expect(warning.textContent).toContain('likely to be refused')
  })

  it('[browser] refreshes evidence against the evidence version, not the identity version', async () => {
    // Two numbers about two different things. The identity is at 2 and its
    // evidence at 3; sending 2 would be a claim about the wrong thing.
    writeDocument()
    const api = baseApi()
    await activate(api)

    const refresh = [
      ...document.querySelectorAll<HTMLButtonElement>('[data-sender-list] button'),
    ].find((button) => button.textContent === 'Refresh evidence')!
    refresh.click()
    await vi.waitFor(() => expect(api.refreshSenderIdentityEvidence).toHaveBeenCalled())
    expect(api.refreshSenderIdentityEvidence).toHaveBeenCalledWith(
      1,
      3,
      expect.any(String),
      expect.any(AbortSignal),
    )
  })

  it('[browser] does not offer to archive the address everything goes out as', async () => {
    // Archiving the default would leave the deployment with no sender at all.
    writeDocument()
    await activate(baseApi())

    const labelsFor = (key: string): string[] =>
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          `[data-sender-list] tr[data-row-key="${key}"] button`,
        ),
      ].map((button) => button.textContent ?? '')

    expect(labelsFor('1')).not.toContain('Archive')
    expect(labelsFor('1')).not.toContain('Make default')
    expect(labelsFor('2')).toContain('Archive')
    expect(labelsFor('2')).toContain('Make default')
  })

  it('[browser] opens a template with its variables and its version history', async () => {
    writeDocument()
    const api = baseApi()
    await activate(api)
    await openInvoiceTemplate(api)

    expect(window.location.search).toBe('?template=invoice')
    expect(document.querySelector<HTMLInputElement>('[data-template-subject]')?.value).toBe(
      'Invoice %invoice_number% from %company_name%',
    )
    expect(document.querySelector('[data-template-variables]')?.textContent).toContain(
      '%invoice_amount%',
    )
    expect(document.querySelector('[data-template-history]')?.textContent).toContain('4')
    // Nothing changed yet, so there is nothing to save.
    expect(document.querySelector<HTMLButtonElement>('[data-template-save]')?.disabled).toBe(
      true,
    )
  })

  it('[browser] names a token this template has no variable for', async () => {
    // At send time the policy is a choice between failing the send and putting
    // the literal in front of a client. Saying so now is better than either.
    writeDocument()
    const api = baseApi()
    await activate(api)
    await openInvoiceTemplate(api)

    const subject = document.querySelector<HTMLInputElement>('[data-template-subject]')!
    subject.value = 'Invoice %invoice_number% for %clint_name%'
    subject.dispatchEvent(new Event('input'))

    const unknown = document.querySelector<HTMLElement>('[data-template-unknown]')!
    expect(unknown.hidden).toBe(false)
    expect(unknown.textContent).toContain('%clint_name%')
    // Still saveable: it is a warning about a draft, not a refusal.
    expect(document.querySelector<HTMLButtonElement>('[data-template-save]')?.disabled).toBe(
      false,
    )
  })

  it('[browser] saves a new version against the one it loaded', async () => {
    writeDocument()
    const api = baseApi()
    await activate(api)
    await openInvoiceTemplate(api)

    const subject = document.querySelector<HTMLInputElement>('[data-template-subject]')!
    subject.value = 'Your invoice %invoice_number%'
    subject.dispatchEvent(new Event('input'))
    document
      .querySelector<HTMLFormElement>('[data-template-form]')!
      .dispatchEvent(new Event('submit', { cancelable: true }))

    await vi.waitFor(() => expect(api.createEmailTemplateVersion).toHaveBeenCalled())
    expect(api.createEmailTemplateVersion).toHaveBeenCalledWith(
      'invoice',
      expect.any(String),
      {
        expected_version: 4,
        subject_template: 'Your invoice %invoice_number%',
        text_template: 'Amount due: %invoice_amount%',
        // An empty HTML box is no HTML part, not an empty one.
        html_template: null,
      },
      expect.any(AbortSignal),
    )
    await vi.waitFor(() =>
      expect(document.querySelector('[data-template-result]')?.textContent).toContain(
        'version 5',
      ),
    )
  })

  it('[browser] reads a stale version as someone else having saved first', async () => {
    writeDocument()
    const api = baseApi({
      createEmailTemplateVersion: vi.fn(async () => {
        throw Object.assign(new Error('conflict'), { status: 409 })
      }),
    })
    await activate(api)
    await openInvoiceTemplate(api)

    const subject = document.querySelector<HTMLInputElement>('[data-template-subject]')!
    subject.value = 'Changed'
    subject.dispatchEvent(new Event('input'))
    document
      .querySelector<HTMLFormElement>('[data-template-form]')!
      .dispatchEvent(new Event('submit', { cancelable: true }))

    await vi.waitFor(() =>
      expect(document.querySelector<HTMLElement>('[data-template-result]')?.dataset.outcome).toBe(
        'stale',
      ),
    )
    // The edit is not thrown away: the fix is to reload and reapply it, which
    // needs it to still be there.
    expect(subject.value).toBe('Changed')
  })

  it('[browser] reverts a draft to what was loaded', async () => {
    writeDocument()
    const api = baseApi()
    await activate(api)
    await openInvoiceTemplate(api)

    const subject = document.querySelector<HTMLInputElement>('[data-template-subject]')!
    subject.value = 'Changed'
    subject.dispatchEvent(new Event('input'))
    document.querySelector<HTMLButtonElement>('[data-template-revert]')!.click()

    expect(subject.value).toBe('Invoice %invoice_number% from %company_name%')
    expect(document.querySelector<HTMLButtonElement>('[data-template-save]')?.disabled).toBe(
      true,
    )
  })

  it('[browser] opens a deep link straight to a template', async () => {
    writeDocument('/invoices/configure?template=reminder')
    const api = baseApi()
    await activate(api)

    await vi.waitFor(() =>
      expect(document.querySelector<HTMLElement>('[data-template-editor]')?.hidden).toBe(false),
    )
    expect(document.querySelector('[data-template-editor-kind]')?.textContent).toBe(
      'Payment reminder',
    )
  })

  it('[browser] leaves nothing on the page once the session ends', async () => {
    writeDocument()
    const controller = new AbortController()
    await activate(baseApi(), controller.signal)
    expect(senderText()).toContain('billing@example.com')

    controller.abort()

    expect(senderText()).toBe('')
    expect(document.querySelector('[data-sender-status]')?.textContent).toBe(
      'Sign in to view email configuration.',
    )
  })
})
