import { renderDataTable } from '../components/data-table.js'
import {
  EzactoApiError,
  type EmailTemplate,
  type EmailTemplateVariable,
  type EmailTemplateVariableGroup,
  type SenderIdentity,
  type Whoami,
} from '@ezacto/client'
import {
  emailConfigTemplateFromUrl,
  emailConfigUrl,
  emailTemplateKindLabel,
  emailTemplateKindPurpose,
  emailTemplateOrder,
  senderDefaultWarning,
  senderEvidenceDetail,
  senderEvidenceLabel,
  senderEvidenceRefreshVersion,
  senderEvidenceState,
  senderIdentityOrder,
  templateDraftChanged,
  templateDraftFrom,
  templateSaveOutcome,
  templateVariablesFor,
  unknownTemplateTokens,
  type EmailConfigurationApi,
  type EmailTemplateKind,
} from './model.js'

const required = <ElementType extends Element>(selector: string): ElementType => {
  const item = document.querySelector<ElementType>(selector)
  if (item === null) throw new Error(`email configuration element missing: ${selector}`)
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
    if (error.status === 403) return 'You do not have access to email configuration.'
  }
  return error instanceof Error ? error.message : 'The request could not be completed.'
}

interface ActiveSession {
  readonly identity: Whoami
  readonly signal: AbortSignal
  readonly onSessionFailure: (error: unknown) => boolean
}

export interface EmailConfigurationController {
  activate(
    identity: Whoami,
    signal: AbortSignal,
    onSessionFailure: (error: unknown) => boolean,
  ): Promise<void>
}

/**
 * The invoice-configuration workspace: who mail comes from, and what it says.
 *
 * The sender half is mostly a warning system. A deployment can hold several
 * identities and exactly one is the default; the provider decides whether that
 * one may actually send, and the only place that is visible before a bounce is
 * the evidence this screen reads. So the default's state is lifted out of the
 * table into a line of its own.
 *
 * The template half is an editor over an append-only history. Every save posts
 * against the version it was loaded from, and the server refuses a stale one --
 * so a conflict is reported as somebody else having saved first, with the
 * reload that fixes it, rather than as an unexplained failure.
 */
export const createEmailConfigurationController = (
  api: Partial<EmailConfigurationApi>,
): EmailConfigurationController => {
  const isPage = document.documentElement.dataset.appView === 'invoice-configure'
  const page = required<HTMLElement>('[data-invoice-configure-page]')
  const senderStatus = required<HTMLElement>('[data-sender-status]')
  const senderWarning = required<HTMLElement>('[data-sender-warning]')
  const senderList = required<HTMLElement>('[data-sender-list]')
  const senderRetry = required<HTMLButtonElement>('[data-sender-retry]')
  const templateStatus = required<HTMLElement>('[data-template-status]')
  const templateList = required<HTMLElement>('[data-template-list]')
  const templateRetry = required<HTMLButtonElement>('[data-template-retry]')
  const editor = required<HTMLElement>('[data-template-editor]')
  const editorClose = required<HTMLAnchorElement>('[data-template-close]')
  const form = required<HTMLFormElement>('[data-template-form]')
  const subject = required<HTMLInputElement>('[data-template-subject]')
  const bodyText = required<HTMLTextAreaElement>('[data-template-text]')
  const bodyHtml = required<HTMLTextAreaElement>('[data-template-html]')
  const unknown = required<HTMLElement>('[data-template-unknown]')
  const save = required<HTMLButtonElement>('[data-template-save]')
  const revert = required<HTMLButtonElement>('[data-template-revert]')
  const result = required<HTMLElement>('[data-template-result]')
  const variables = required<HTMLElement>('[data-template-variables]')
  const history = required<HTMLElement>('[data-template-history]')
  page.hidden = !isPage

  let activeSession: ActiveSession | null = null
  let senders: readonly SenderIdentity[] = []
  let templates: readonly EmailTemplate[] = []
  let catalog: readonly EmailTemplateVariableGroup[] = []
  let selection: EmailTemplateKind | null = null
  let loaded: EmailTemplate | null = null
  let senderPending = false
  let savePending = false
  /** Held across a retry: the key is the command's identity, not the attempt's. */
  let saveKey: string | null = null

  const current = (): ActiveSession | null =>
    activeSession === null || activeSession.signal.aborted ? null : activeSession

  const clearPrivatePresentation = (): void => {
    senders = []
    templates = []
    catalog = []
    loaded = null
    saveKey = null
    senderPending = false
    savePending = false
    senderList.replaceChildren()
    templateList.replaceChildren()
    variables.replaceChildren()
    history.replaceChildren()
    subject.value = ''
    bodyText.value = ''
    bodyHtml.value = ''
    result.textContent = ''
    unknown.hidden = true
    editor.hidden = true
    senderWarning.hidden = true
    senderStatus.textContent = 'Loading sender identities…'
    templateStatus.textContent = 'Loading templates…'
    senderRetry.hidden = true
    templateRetry.hidden = true
    save.disabled = true
    revert.disabled = true
  }

  const draft = () => ({ subject: subject.value, text: bodyText.value, html: bodyHtml.value })

  const syncDraftState = (): void => {
    const template = loaded
    if (template === null) {
      save.disabled = true
      revert.disabled = true
      return
    }
    const changed = templateDraftChanged(draft(), template)
    save.disabled = !changed || savePending || api.createEmailTemplateVersion === undefined
    revert.disabled = !changed || savePending
    const strays = unknownTemplateTokens(
      [subject.value, bodyText.value, bodyHtml.value],
      templateVariablesFor(catalog, template.kind),
    )
    unknown.hidden = strays.length === 0
    unknown.textContent =
      strays.length === 0
        ? ''
        : `${strays.join(', ')} ${strays.length === 1 ? 'is not a variable' : 'are not variables'} for this template. At send time it either fails or reaches the client as written.`
  }

  const renderSenders = (): void => {
    const warning = senderDefaultWarning(senders)
    senderWarning.hidden = warning === null
    senderWarning.textContent = warning ?? ''
    const rows = senderIdentityOrder(senders)
    if (rows.length === 0) {
      senderList.replaceChildren()
      senderStatus.textContent = 'No sender identities are configured.'
      return
    }
    senderList.replaceChildren(
      renderDataTable<SenderIdentity>({
        caption: 'Sender identities',
        rows,
        rowKey: (identity) => String(identity.id),
        columns: [
          { key: 'email', label: 'Address', render: (identity) => identity.email },
          { key: 'name', label: 'Display name', render: (identity) => identity.display_name },
          {
            key: 'reply',
            label: 'Reply-to',
            render: (identity) => identity.reply_to_email ?? '—',
          },
          { key: 'provider', label: 'Provider', render: (identity) => identity.provider },
          {
            key: 'evidence',
            label: 'Provider evidence',
            render: (identity) => {
              const pill = document.createElement('span')
              pill.className = 'invoice-state'
              pill.dataset.senderEvidence = senderEvidenceState(identity)
              pill.textContent = senderEvidenceLabel(identity)
              pill.title = senderEvidenceDetail(identity)
              return pill
            },
          },
          {
            key: 'role',
            label: 'Role',
            render: (identity) =>
              identity.archived_at !== null
                ? 'Archived'
                : identity.is_default
                  ? 'Default'
                  : 'Available',
          },
        ],
        actions: (identity) =>
          identity.archived_at !== null
            ? []
            : [
                ...(identity.is_default
                  ? []
                  : [
                      {
                        label: 'Make default',
                        primary: true,
                        onSelect: () => {
                          void runSenderCommand('default', identity)
                        },
                      },
                    ]),
                {
                  label: 'Refresh evidence',
                  onSelect: () => {
                    void runSenderCommand('refresh', identity)
                  },
                },
                // Archiving the default would leave the deployment with no
                // address to send as, so it is not offered on that row.
                ...(identity.is_default
                  ? []
                  : [
                      {
                        label: 'Archive',
                        onSelect: () => {
                          void runSenderCommand('archive', identity)
                        },
                      },
                    ]),
              ],
      }),
    )
    senderStatus.textContent = `${rows.length} ${rows.length === 1 ? 'identity' : 'identities'} configured.`
  }

  const runSenderCommand = async (
    command: 'default' | 'archive' | 'refresh',
    identity: Readonly<SenderIdentity>,
  ): Promise<void> => {
    const session = current()
    if (session === null || senderPending) return
    const run =
      command === 'default'
        ? api.setDefaultSenderIdentity
        : command === 'archive'
          ? api.archiveSenderIdentity
          : api.refreshSenderIdentityEvidence
    if (run === undefined) return
    // Refresh claims the evidence's version; default and archive claim the
    // identity's. They are different numbers about different things, and an
    // identity nobody has checked has no evidence version at all.
    const expected =
      command === 'refresh' ? senderEvidenceRefreshVersion(identity) : identity.version
    if (expected === null) {
      senderStatus.textContent = `${identity.email} has no provider evidence to refresh yet.`
      return
    }
    senderPending = true
    senderStatus.textContent =
      command === 'refresh' ? 'Asking the provider…' : 'Applying the change…'
    try {
      await run(identity.id, expected, globalThis.crypto.randomUUID(), session.signal)
      if (current() !== session) return
      await loadSenders()
    } catch (error) {
      if (current() !== session) return
      if (session.onSessionFailure(error)) return
      senderStatus.textContent = messageFor(error)
    } finally {
      if (current() === session) senderPending = false
    }
  }

  const renderTemplates = (): void => {
    const rows = emailTemplateOrder(templates)
    if (rows.length === 0) {
      templateList.replaceChildren()
      templateStatus.textContent = 'No templates are installed.'
      return
    }
    templateList.replaceChildren(
      renderDataTable<EmailTemplate>({
        caption: 'Email templates',
        rows,
        rowKey: (template) => template.kind,
        columns: [
          {
            key: 'kind',
            label: 'Template',
            render: (template) => emailTemplateKindLabel(template.kind),
          },
          {
            key: 'purpose',
            label: 'Sent when',
            render: (template) => emailTemplateKindPurpose(template.kind),
          },
          {
            key: 'subject',
            label: 'Subject',
            render: (template) => template.subject_template,
          },
          {
            key: 'version',
            label: 'Version',
            numeric: true,
            render: (template) => String(template.version),
          },
        ],
        actions: (template) => [
          { label: 'Edit', primary: true, onSelect: () => openTemplate(template.kind) },
        ],
      }),
    )
    templateStatus.textContent = `${rows.length} ${rows.length === 1 ? 'template' : 'templates'} installed.`
  }

  const renderVariables = (kind: EmailTemplateKind): void => {
    const rows = templateVariablesFor(catalog, kind)
    variables.replaceChildren(
      renderDataTable<EmailTemplateVariable>({
        caption: 'Template variables',
        rows,
        rowKey: (variable) => variable.token,
        empty: 'No variables are published for this template.',
        columns: [
          { key: 'token', label: 'Token', render: (variable) => variable.token },
          { key: 'name', label: 'Name', render: (variable) => variable.name },
          {
            key: 'description',
            label: 'Means',
            render: (variable) => variable.description,
          },
          {
            key: 'compatibility',
            label: 'From',
            render: (variable) =>
              variable.compatibility === 'harvest' ? 'Harvest' : 'ezacto',
          },
        ],
      }),
    )
  }

  const renderHistory = (versions: readonly EmailTemplate[]): void => {
    history.replaceChildren(
      renderDataTable<EmailTemplate>({
        caption: 'Template versions',
        rows: [...versions].sort((left, right) => right.version - left.version),
        rowKey: (template) => String(template.version),
        empty: 'Only the version installed with the deployment.',
        columns: [
          {
            key: 'version',
            label: 'Version',
            numeric: true,
            render: (template) => String(template.version),
          },
          {
            key: 'created',
            label: 'Saved',
            render: (template) => template.created_at.slice(0, 10),
          },
          {
            key: 'by',
            label: 'By',
            render: (template) =>
              template.created_by_user_id === null
                ? 'Installed with the deployment'
                : `User #${String(template.created_by_user_id)}`,
          },
          {
            key: 'subject',
            label: 'Subject',
            render: (template) => template.subject_template,
          },
        ],
      }),
    )
  }

  const openTemplate = (kind: EmailTemplateKind): void => {
    globalThis.history.pushState(null, '', emailConfigUrl(kind))
    selection = kind
    void loadTemplate()
  }

  const loadTemplate = async (): Promise<void> => {
    const session = current()
    const kind = selection
    if (session === null || kind === null) {
      editor.hidden = true
      return
    }
    const template = templates.find((candidate) => candidate.kind === kind)
    if (template === undefined) {
      editor.hidden = true
      return
    }
    loaded = template
    saveKey = null
    editor.hidden = false
    required<HTMLElement>('[data-template-editor-kind]').textContent =
      emailTemplateKindLabel(kind)
    required<HTMLElement>('[data-template-editor-title]').textContent =
      `${emailTemplateKindLabel(kind)} — version ${String(template.version)}`
    required<HTMLElement>('[data-template-purpose]').textContent =
      emailTemplateKindPurpose(kind)
    const values = templateDraftFrom(template)
    subject.value = values.subject
    bodyText.value = values.text
    bodyHtml.value = values.html
    result.textContent = ''
    delete result.dataset.outcome
    renderVariables(kind)
    syncDraftState()
    if (api.listEmailTemplateVersions === undefined) return
    try {
      const versions = await api.listEmailTemplateVersions(kind, session.signal)
      if (current() !== session || selection !== kind) return
      renderHistory(versions)
    } catch (error) {
      if (current() !== session) return
      if (session.onSessionFailure(error)) return
      history.replaceChildren()
    }
  }

  const loadSenders = async (): Promise<void> => {
    const session = current()
    if (session === null) return
    if (api.listSenderIdentities === undefined) {
      senderStatus.textContent = 'Sender identities are unavailable in this build.'
      senderRetry.hidden = true
      return
    }
    senderRetry.hidden = true
    try {
      const loadedSenders = await api.listSenderIdentities(session.signal)
      if (current() !== session) return
      senders = loadedSenders
      renderSenders()
    } catch (error) {
      if (current() !== session) return
      if (session.onSessionFailure(error)) return
      senderList.replaceChildren()
      senderStatus.textContent = messageFor(error)
      senderRetry.hidden = false
    }
  }

  const loadTemplates = async (): Promise<void> => {
    const session = current()
    if (session === null) return
    if (api.listEmailTemplates === undefined) {
      templateStatus.textContent = 'Email templates are unavailable in this build.'
      templateRetry.hidden = true
      return
    }
    templateRetry.hidden = true
    try {
      const [loadedTemplates, loadedCatalog] = await Promise.all([
        api.listEmailTemplates(session.signal),
        api.listEmailTemplateVariables === undefined
          ? Promise.resolve<readonly EmailTemplateVariableGroup[]>([])
          : api.listEmailTemplateVariables(session.signal),
      ])
      if (current() !== session) return
      templates = loadedTemplates
      catalog = loadedCatalog
      renderTemplates()
      await loadTemplate()
    } catch (error) {
      if (current() !== session) return
      if (session.onSessionFailure(error)) return
      templateList.replaceChildren()
      templateStatus.textContent = messageFor(error)
      templateRetry.hidden = false
    }
  }

  const runSave = async (): Promise<void> => {
    const session = current()
    const template = loaded
    if (session === null || template === null || savePending) return
    if (api.createEmailTemplateVersion === undefined) return
    saveKey ??= globalThis.crypto.randomUUID()
    savePending = true
    save.disabled = true
    result.dataset.outcome = 'pending'
    result.textContent = 'Saving…'
    const values = draft()
    try {
      const saved = await api.createEmailTemplateVersion(
        template.kind,
        saveKey,
        {
          expected_version: template.version,
          subject_template: values.subject,
          text_template: values.text,
          // An empty box means "no HTML part", which is null rather than a
          // zero-length HTML body the mailer would try to send.
          html_template: values.html.trim() === '' ? null : values.html,
        },
        session.signal,
      )
      if (current() !== session) return
      saveKey = null
      templates = templates.map((candidate) =>
        candidate.kind === saved.kind ? saved : candidate,
      )
      renderTemplates()
      // The reload rebinds the editor to the version that now exists, and
      // clears the result as it does — so the confirmation is written after it,
      // not before, or the save appears to have said nothing.
      await loadTemplate()
      if (current() !== session) return
      result.dataset.outcome = 'saved'
      result.textContent = `Saved as version ${String(saved.version)}.`
    } catch (error) {
      if (current() !== session) return
      if (session.onSessionFailure(error)) return
      const outcome = templateSaveOutcome(error)
      result.dataset.outcome = outcome.kind
      result.textContent = outcome.message
      // A stale version is a settled answer: retrying the same command asks the
      // same question. The draft stays put so the edit is not lost.
      if (outcome.kind === 'stale' || outcome.kind === 'invalid') saveKey = null
    } finally {
      if (current() === session) {
        savePending = false
        syncDraftState()
      }
    }
  }

  const applyLocation = (): void => {
    if (current() === null) return
    selection = emailConfigTemplateFromUrl(new URL(globalThis.location.href))
    void loadTemplate()
  }

  for (const field of [subject, bodyText, bodyHtml]) {
    field.addEventListener('input', syncDraftState)
  }

  revert.addEventListener('click', () => {
    if (loaded === null) return
    const values = templateDraftFrom(loaded)
    subject.value = values.subject
    bodyText.value = values.text
    bodyHtml.value = values.html
    result.textContent = ''
    delete result.dataset.outcome
    syncDraftState()
  })

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void runSave()
  })

  editorClose.addEventListener('click', (event) => {
    if (current() === null) return
    event.preventDefault()
    globalThis.history.pushState(null, '', emailConfigUrl())
    selection = null
    loaded = null
    editor.hidden = true
  })

  senderRetry.addEventListener('click', () => {
    void loadSenders()
  })
  templateRetry.addEventListener('click', () => {
    void loadTemplates()
  })

  return {
    async activate(identity, signal, onSessionFailure) {
      if (!isPage) return
      const session = { identity, signal, onSessionFailure }
      activeSession = session
      selection = emailConfigTemplateFromUrl(new URL(globalThis.location.href))
      clearPrivatePresentation()
      globalThis.addEventListener('popstate', applyLocation, { signal })
      signal.addEventListener(
        'abort',
        () => {
          if (activeSession !== session) return
          activeSession = null
          clearPrivatePresentation()
          senderStatus.textContent = 'Sign in to view email configuration.'
          templateStatus.textContent = 'Sign in to view email configuration.'
        },
        { once: true },
      )
      await Promise.all([loadSenders(), loadTemplates()])
    },
  }
}
