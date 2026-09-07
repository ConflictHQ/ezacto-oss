import { EzactoApiError, type SenderIdentity, type Whoami } from '@ezacto/client'
import { renderDataTable } from '../components/data-table.js'
import {
  noteSettingsPatch,
  ratePercentage,
  senderVerificationLabel,
  timeTrackingFacts,
  type CompanySettingsApi,
} from './model.js'

interface ModuleState {
  module: string
  enabled: boolean
}

interface ModuleListEnvelope {
  data: readonly ModuleState[]
}

const moduleDescriptions: Readonly<Record<string, { label: string; warning: string }>> = {
  approval: {
    label: 'Timesheet approval',
    warning:
      'Disabling hides the Approvals navigation link and returns 404 from approval API endpoints. Existing submissions, approval states, and audit history are preserved. New time entries remain unsubmitted while approval is off. Existing approved locks still reject writes.',
  },
  expenses: {
    label: 'Expenses',
    warning:
      'Disabling hides the Expenses navigation link and returns 404 from expense API endpoints. Existing expense records are preserved.',
  },
}

const required = <ElementType extends Element>(selector: string): ElementType => {
  const item = document.querySelector<ElementType>(selector)
  if (item === null) throw new Error(`module settings element missing: ${selector}`)
  return item
}

interface ActiveSession {
  readonly signal: AbortSignal
  readonly onSessionFailure: (error: unknown) => boolean
}

export interface ModuleSettingsController {
  activate(
    identity: Whoami,
    signal: AbortSignal,
    onSessionFailure: (error: unknown) => boolean,
  ): Promise<void>
}

const facts = (
  target: HTMLElement,
  rows: readonly (readonly [string, string])[],
): void => {
  target.replaceChildren(
    ...rows.flatMap(([label, value]) => {
      const term = document.createElement('dt')
      term.textContent = label
      const detail = document.createElement('dd')
      detail.textContent = value
      return [term, detail]
    }),
  )
  target.hidden = false
}

/**
 * A 403 here is configuration, not a broken page: the notes policy answers to an
 * executive manager, email health to an administrator alone. Saying which is the
 * difference between a section an operator can act on and one that looks broken.
 */
const messageFor = (error: unknown, forbidden: string, fallback: string): string => {
  if (error instanceof EzactoApiError && error.status === 403) return forbidden
  return error instanceof Error ? error.message : fallback
}

const withSignal = (signal?: AbortSignal): { signal?: AbortSignal } =>
  signal === undefined ? {} : { signal }

const fetchModules = async (signal?: AbortSignal): Promise<readonly ModuleState[]> => {
  const response = await globalThis.fetch('/api/v1/admin/modules', {
    credentials: 'same-origin',
    ...withSignal(signal),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Failed to load modules (${response.status}): ${text}`)
  }
  const envelope = (await response.json()) as ModuleListEnvelope
  return envelope.data
}

const patchModule = async (
  module: string,
  enabled: boolean,
  signal?: AbortSignal,
): Promise<readonly ModuleState[]> => {
  const response = await globalThis.fetch(`/api/v1/admin/modules/${module}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
    credentials: 'same-origin',
    ...withSignal(signal),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Failed to update module (${response.status}): ${text}`)
  }
  const envelope = (await response.json()) as ModuleListEnvelope
  return envelope.data
}

const renderModuleCard = (state: ModuleState): string => {
  const description = moduleDescriptions[state.module]
  const label = description?.label ?? state.module
  const warning = description?.warning ?? ''
  return (
    `<article class="module-settings-card" data-module-card="${state.module}">` +
    `<header class="module-settings-card-header">` +
    `<div><h2>${label}</h2><p class="module-code">${state.module}</p></div>` +
    `<label class="module-toggle"><input type="checkbox" data-module-toggle="${state.module}"${state.enabled ? ' checked' : ''}><span>${state.enabled ? 'Enabled' : 'Disabled'}</span></label>` +
    `</header>` +
    `<p class="module-settings-warning">${warning}</p>` +
    `<p class="form-result" data-module-result="${state.module}" role="status" aria-live="polite"></p>` +
    `</article>`
  )
}

export const createModuleSettingsController = (
  api: Partial<CompanySettingsApi>,
): ModuleSettingsController => {
  const status = required<HTMLElement>('[data-module-settings-status]')
  const list = required<HTMLElement>('[data-module-settings-list]')
  const timeStatus = required<HTMLElement>('[data-settings-time-status]')
  const timeFacts = required<HTMLElement>('[data-settings-time-facts]')
  const noteForm = required<HTMLFormElement>('[data-note-settings-form]')
  const noteRequired = required<HTMLInputElement>('[data-note-settings-required]')
  const noteMinimum = required<HTMLInputElement>('[data-note-settings-minimum]')
  const noteSubmit = required<HTMLButtonElement>('[data-note-settings-submit]')
  const noteResult = required<HTMLElement>('[data-note-settings-result]')
  const emailStatus = required<HTMLElement>('[data-settings-email-status]')
  const emailSenders = required<HTMLElement>('[data-settings-sender-identities]')
  const emailReputation = required<HTMLElement>('[data-settings-email-reputation]')

  // The form is wired once, not on every activation: a sign-out and a sign-in
  // back into the page would otherwise leave two listeners on it and send the
  // policy twice.
  let session: ActiveSession | null = null

  noteForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const active = session
    if (active === null || api.updateTimeEntryNoteSettings === undefined) return
    noteResult.textContent = 'Saving…'
    noteSubmit.disabled = true
    try {
      const saved = await api.updateTimeEntryNoteSettings(
        noteSettingsPatch({
          required: noteRequired.checked,
          minimumLength: noteMinimum.value,
        }),
        active.signal,
      )
      noteRequired.checked = saved.required
      noteMinimum.value = String(saved.minimum_length)
      noteResult.textContent = 'Saved.'
    } catch (error) {
      if (active.onSessionFailure(error)) return
      noteResult.textContent = messageFor(
        error,
        'Only executive managers and administrators can change the notes policy.',
        'The notes policy could not be saved.',
      )
    } finally {
      noteSubmit.disabled = false
    }
  })

  const senderTable = (identities: readonly SenderIdentity[]): HTMLElement =>
    renderDataTable<SenderIdentity>({
      caption: 'Sender identities',
      rows: identities,
      rowKey: (identity) => String(identity.id),
      empty: 'No sender identity is configured, so nothing this instance sends has a from address.',
      columns: [
        { key: 'email', label: 'Sends as', render: (identity) => identity.email },
        { key: 'display_name', label: 'Display name', render: (identity) => identity.display_name },
        { key: 'provider', label: 'Transport', render: (identity) => identity.provider },
        {
          key: 'verification',
          label: 'Verification',
          render: (identity) => senderVerificationLabel(identity),
        },
        {
          key: 'default',
          label: 'Default',
          render: (identity) => (identity.is_default ? 'Default' : ''),
        },
      ],
    })

  /**
   * Everything a signed-in session put on this page. activate() calls it before
   * it does anything else, because the page outlives the session: signing out
   * and back in as someone else happens in the same document, and the previous
   * administrator's sender identities and reputation figures were still on
   * screen for whoever signed in next. Rewriting the status strings, which is
   * all the non-privileged branch used to do, does not remove what is rendered
   * above them.
   */
  const clearPrivatePresentation = (): void => {
    emailSenders.replaceChildren()
    emailSenders.hidden = true
    emailReputation.replaceChildren()
    emailReputation.hidden = true
    timeFacts.replaceChildren()
    noteForm.hidden = true
    list.replaceChildren()
  }

  /**
   * Two sections, loaded independently. A deployment with no mail transport
   * still has a notes policy worth reading, so one section's 403 or 500 must
   * not take the other down with it.
   */
  const loadTimeTracking = async (signal: AbortSignal): Promise<void> => {
    if (api.getTimeEntrySettings === undefined || api.getTimeEntryNoteSettings === undefined) {
      timeStatus.textContent = 'This build has no time tracking settings endpoint.'
      return
    }
    try {
      const [settings, notes] = await Promise.all([
        api.getTimeEntrySettings(signal),
        api.getTimeEntryNoteSettings(signal),
      ])
      facts(timeFacts, timeTrackingFacts(settings))
      noteRequired.checked = notes.required
      noteMinimum.value = String(notes.minimum_length)
      noteForm.hidden = false
      timeStatus.textContent = ''
    } catch (error) {
      // Every other controller in the shell answers a 401 by ending the
      // session rather than printing the transport error. Without it the shell
      // still presents a signed-out user as signed in, over a raw
      // "request failed with status 401".
      if (session?.onSessionFailure(error) ?? false) return
      if (signal.aborted) return
      timeStatus.textContent = messageFor(
        error,
        'Only executive managers and administrators can read the time tracking settings.',
        'Time tracking settings could not be loaded.',
      )
    }
  }

  const loadEmail = async (identity: Whoami, signal: AbortSignal): Promise<void> => {
    // email-health and sender-identities are both administrator-only. Asking as
    // an executive manager buys two 403s and tells the operator nothing.
    if (identity.profile !== 'administrator') {
      emailStatus.textContent = 'Email delivery is visible to administrators only.'
      return
    }
    if (api.listSenderIdentities === undefined || api.getEmailHealth === undefined) {
      emailStatus.textContent = 'This build has no email delivery endpoints.'
      return
    }
    try {
      const [identities, health] = await Promise.all([
        api.listSenderIdentities(signal),
        api.getEmailHealth(signal),
      ])
      emailSenders.replaceChildren(senderTable(identities))
      emailSenders.hidden = false
      facts(emailReputation, [
        // reputation.sent is counts.sent + bounced + complained -- the total
        // accepted, and the denominator both rates are taken over. Labelling it
        // Delivered overstated delivery and implied a total larger than the
        // real one, since a reader adds the bounced and complained rows to it.
        ['Accepted', String(health.reputation.sent)],
        ['Bounced', `${health.reputation.bounced} (${ratePercentage(health.reputation.bounce_rate_ppm)})`],
        [
          'Complained',
          `${health.reputation.complained} (${ratePercentage(health.reputation.complaint_rate_ppm)})`,
        ],
        ['Failed to send', String(health.reputation.failed)],
      ])
      emailStatus.textContent = ''
    } catch (error) {
      if (session?.onSessionFailure(error) ?? false) return
      if (signal.aborted) return
      emailStatus.textContent = messageFor(
        error,
        'Only administrators can view email delivery.',
        'Email delivery could not be loaded.',
      )
    }
  }

  return {
    async activate(identity, signal, onSessionFailure) {
      clearPrivatePresentation()
      if (identity.profile !== 'administrator' && identity.profile !== 'executive_manager') {
        status.textContent = 'Only administrators can manage module settings.'
        timeStatus.textContent = ''
        emailStatus.textContent = ''
        return
      }

      session = { signal, onSessionFailure }

      const configuration = Promise.all([
        loadTimeTracking(signal),
        loadEmail(identity, signal),
      ])

      try {
        const modules = await fetchModules(signal)
        status.textContent = ''
        list.innerHTML = modules.map(renderModuleCard).join('')

        for (const toggle of list.querySelectorAll<HTMLInputElement>('[data-module-toggle]')) {
          toggle.addEventListener('change', async () => {
            const moduleName = toggle.dataset.moduleToggle!
            const result = list.querySelector<HTMLElement>(`[data-module-result="${moduleName}"]`)
            const span = toggle.parentElement?.querySelector('span')
            toggle.disabled = true
            if (result) result.textContent = 'Saving…'

            try {
              const updated = await patchModule(moduleName, toggle.checked, signal)
              const state = updated.find((m) => m.module === moduleName)
              if (span) span.textContent = state?.enabled ? 'Enabled' : 'Disabled'
              if (result) result.textContent = ''
            } catch (error) {
              if (onSessionFailure(error)) return
              toggle.checked = !toggle.checked
              if (span) span.textContent = toggle.checked ? 'Enabled' : 'Disabled'
              if (result) {
                result.textContent = error instanceof Error
                  ? error.message
                  : 'The module update could not be completed.'
              }
            } finally {
              toggle.disabled = false
            }
          })
        }
      } catch (error) {
        if (onSessionFailure(error)) return
        status.textContent = error instanceof Error
          ? error.message
          : 'Modules could not be loaded.'
      }
      await configuration
    },
  }
}
