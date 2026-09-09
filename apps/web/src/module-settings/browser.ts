import {
  EzactoApiError,
  type SenderIdentity,
  type SsoDomain,
  type Whoami,
} from '@ezacto/client'
import { renderDataTable } from '../components/data-table.js'
import { sessionPresenter, type SessionPresenter } from '../session.js'
import {
  apiErrorMessage,
  noteSettingsPatch,
  ratePercentage,
  senderVerificationLabel,
  ssoDomainStatus,
  ssoLastCheckedLabel,
  ssoVerificationMessage,
  timeTrackingFacts,
  type CompanySettingsApi,
  type BackupRun,
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

interface ActiveSession extends SessionPresenter {
  readonly signal: AbortSignal
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
  const backupStatus = required<HTMLElement>('[data-settings-backup-status]')
  const backupAlarm = required<HTMLElement>('[data-settings-backup-alarm]')
  const backupFacts = required<HTMLElement>('[data-settings-backup-facts]')
  const backupRuns = required<HTMLElement>('[data-settings-backup-runs]')
  const ssoStatus = required<HTMLElement>('[data-settings-sso-status]')
  const ssoDomains = required<HTMLElement>('[data-settings-sso-domains]')
  const ssoForm = required<HTMLFormElement>('[data-sso-domain-form]')
  const ssoInput = required<HTMLInputElement>('[data-sso-domain-input]')
  const ssoSubmit = required<HTMLButtonElement>('[data-sso-domain-submit]')
  const ssoResult = required<HTMLElement>('[data-sso-domain-result]')

  // The list is held rather than re-fetched after every action: add, verify and
  // remove all answer with what they changed, and a re-fetch would throw away
  // the challenge token the operator is part way through publishing.
  let ssoState: readonly SsoDomain[] = []
  let ssoBusy = false

  // The form is wired once, not on every activation: a sign-out and a sign-in
  // back into the page would otherwise leave two listeners on it and send the
  // policy twice.
  let session: ActiveSession | null = null

  /**
   * The session an operation may start for, or null when there is none. A
   * request begun for a session that has already ended is a request whose
   * answer has nowhere to go.
   */
  const currentSession = (): ActiveSession | null =>
    session === null || session.signal.aborted ? null : session

  noteForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const active = currentSession()
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
      active.present(() => {
        noteRequired.checked = saved.required
        noteMinimum.value = String(saved.minimum_length)
        noteResult.textContent = 'Saved.'
      })
    } catch (error) {
      active.presentFailure(error, () => {
        noteResult.textContent = messageFor(
          error,
          'Only executive managers and administrators can change the notes policy.',
          'The notes policy could not be saved.',
        )
      })
    } finally {
      // Re-enabling belongs to the session that disabled it. The next session
      // gets its controls back from clearPrivatePresentation instead.
      active.present(() => {
        noteSubmit.disabled = false
      })
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
   * The row's payload. A domain verifies only once this exact TXT record is in
   * the zone, so the name and the value are on screen to be copied — the
   * alternative, before this screen existed, was reading the challenge token
   * out of D1 by hand.
   */
  const ssoRecordCell = (domain: SsoDomain): HTMLElement => {
    const wrapper = document.createElement('div')
    wrapper.className = 'sso-record'
    const name = document.createElement('code')
    name.textContent = `${domain.record_name} ${domain.record_type}`
    const value = document.createElement('code')
    value.textContent = domain.record_value
    wrapper.append(name, value)
    return wrapper
  }

  const paintSsoDomains = (): void => {
    ssoDomains.replaceChildren(
      renderDataTable<SsoDomain>({
        caption: 'SSO provisioning domains',
        rows: ssoState,
        rowKey: (domain) => String(domain.id),
        empty:
          'No domain is provisioned, so single sign-on creates nobody. Add the email domain your directory signs in with.',
        columns: [
          { key: 'domain', label: 'Domain', render: (domain) => domain.domain },
          { key: 'status', label: 'Status', render: (domain) => ssoDomainStatus(domain) },
          {
            key: 'checked',
            label: 'Last checked',
            render: (domain) => ssoLastCheckedLabel(domain),
          },
          { key: 'record', label: 'DNS record', render: (domain) => ssoRecordCell(domain) },
        ],
        actions: (domain) => [
          {
            label: 'Verify',
            primary: true,
            disabled: ssoBusy,
            onSelect: () => void verifySsoDomain(domain),
          },
          { label: 'Remove', disabled: ssoBusy, onSelect: () => void removeSsoDomain(domain) },
        ],
      }),
    )
    ssoDomains.hidden = false
  }

  const verifySsoDomain = async (domain: SsoDomain): Promise<void> => {
    const active = currentSession()
    if (active === null || api.verifySsoDomain === undefined) return
    ssoBusy = true
    paintSsoDomains()
    ssoResult.textContent = `Checking ${domain.domain}…`
    try {
      const check = await api.verifySsoDomain(domain.id, active.signal)
      active.present(() => {
        ssoState = ssoState.map((row) => (row.id === check.id ? check : row))
        ssoResult.textContent = ssoVerificationMessage(check)
      })
    } catch (error) {
      active.presentFailure(error, () => {
        // A lookup that could not run is not a domain that failed the check: the
        // record may be published and perfect. The API's own message says which
        // happened, so an operator does not go and pull a correct record.
        ssoResult.textContent = apiErrorMessage(error, 'The domain could not be checked.')
      })
    } finally {
      ssoBusy = false
      active.present(paintSsoDomains)
    }
  }

  const removeSsoDomain = async (domain: SsoDomain): Promise<void> => {
    const active = currentSession()
    if (active === null || api.removeSsoDomain === undefined) return
    ssoBusy = true
    paintSsoDomains()
    ssoResult.textContent = `Removing ${domain.domain}…`
    try {
      await api.removeSsoDomain(domain.id, active.signal)
      active.present(() => {
        ssoState = ssoState.filter((row) => row.id !== domain.id)
        ssoResult.textContent = `${domain.domain} no longer provisions anyone.`
      })
    } catch (error) {
      active.presentFailure(error, () => {
        ssoResult.textContent = apiErrorMessage(error, 'The domain could not be removed.')
      })
    } finally {
      ssoBusy = false
      active.present(paintSsoDomains)
    }
  }

  ssoForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const active = currentSession()
    if (active === null || api.addSsoDomain === undefined) return
    const domain = ssoInput.value.trim()
    if (domain === '') {
      ssoResult.textContent = 'Enter the email domain to provision from, such as example.com.'
      return
    }
    ssoResult.textContent = 'Adding…'
    ssoSubmit.disabled = true
    try {
      const added = await api.addSsoDomain(domain, active.signal)
      // The new domain reaches the held list here and not a line earlier: a
      // domain added into a session that has ended is a challenge token
      // waiting for the next paint to put it on someone else's screen.
      active.present(() => {
        ssoState = [...ssoState, added]
        ssoInput.value = ''
        paintSsoDomains()
        // Added is not enabled: nothing is provisioned from it until the record
        // published below verifies, and the next step has to be said out loud or
        // a half-configured domain reads as a working one.
        ssoResult.textContent =
          `${added.domain} added. Publish the ${added.record_type} record shown, then verify it.`
      })
    } catch (error) {
      active.presentFailure(error, () => {
        ssoResult.textContent = apiErrorMessage(error, 'The domain could not be added.')
      })
    } finally {
      active.present(() => {
        ssoSubmit.disabled = false
      })
    }
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
    // The previous session stops owning the page here, before anything is
    // taken off it. Whatever it still has in flight then has nowhere to paint,
    // whether or not the shell remembered to abort its signal on the way out.
    session = null
    // Its controls come back with the page rather than from the finally of an
    // operation that is no longer allowed to touch anything.
    noteSubmit.disabled = false
    ssoSubmit.disabled = false
    ssoBusy = false
    emailSenders.replaceChildren()
    emailSenders.hidden = true
    emailReputation.replaceChildren()
    emailReputation.hidden = true
    timeFacts.replaceChildren()
    noteForm.hidden = true
    // The result line sits outside the form, so hiding the form leaves the
    // previous session's "Saved." or its 403 on screen under the next
    // person's notice.
    noteResult.textContent = ''
    list.replaceChildren()
    // The challenge tokens are the domains' proof of ownership as much as the
    // record they name, so they go with the rest of the previous session's
    // company data rather than sitting under a notice saying it is not yours.
    ssoState = []
    ssoDomains.replaceChildren()
    ssoDomains.hidden = true
    ssoForm.hidden = true
    ssoInput.value = ''
    ssoResult.textContent = ''
  }

  /**
   * Two sections, loaded independently. A deployment with no mail transport
   * still has a notes policy worth reading, so one section's 403 or 500 must
   * not take the other down with it.
   */
  const loadTimeTracking = async (active: ActiveSession): Promise<void> => {
    if (api.getTimeEntrySettings === undefined || api.getTimeEntryNoteSettings === undefined) {
      timeStatus.textContent = 'This build has no time tracking settings endpoint.'
      return
    }
    try {
      const [settings, notes] = await Promise.all([
        api.getTimeEntrySettings(active.signal),
        api.getTimeEntryNoteSettings(active.signal),
      ])
      active.present(() => {
        facts(timeFacts, timeTrackingFacts(settings))
        noteRequired.checked = notes.required
        noteMinimum.value = String(notes.minimum_length)
        noteForm.hidden = false
        timeStatus.textContent = ''
      })
    } catch (error) {
      // Every other controller in the shell answers a 401 by ending the
      // session rather than printing the transport error. Without it the shell
      // still presents a signed-out user as signed in, over a raw
      // "request failed with status 401".
      active.presentFailure(error, () => {
        timeStatus.textContent = messageFor(
          error,
          'Only executive managers and administrators can read the time tracking settings.',
          'Time tracking settings could not be loaded.',
        )
      })
    }
  }

  const loadEmail = async (identity: Whoami, active: ActiveSession): Promise<void> => {
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
        api.listSenderIdentities(active.signal),
        api.getEmailHealth(active.signal),
      ])
      active.present(() => {
        emailSenders.replaceChildren(senderTable(identities))
        emailSenders.hidden = false
        facts(emailReputation, [
          // reputation.sent is counts.sent + bounced + complained — the total
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
      })
    } catch (error) {
      active.presentFailure(error, () => {
        emailStatus.textContent = messageFor(
          error,
          'Only administrators can view email delivery.',
          'Email delivery could not be loaded.',
        )
      })
    }
  }

  /**
   * How long ago, said the way someone reading a backup screen is thinking.
   * "2026-09-07T03:00:12Z" answers a different question from "2 days ago", and
   * the question here is whether the last one is recent enough.
   */
  const sinceLabel = (at: string, now: number): string => {
    const elapsed = now - Date.parse(at)
    if (!Number.isFinite(elapsed) || elapsed < 0) return at.slice(0, 10)
    const hours = Math.floor(elapsed / 3_600_000)
    if (hours < 1) return 'less than an hour ago'
    if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
    const days = Math.floor(hours / 24)
    return `${days} ${days === 1 ? 'day' : 'days'} ago`
  }

  const backupRunTable = (runs: readonly BackupRun[]): HTMLElement =>
    renderDataTable<BackupRun>({
      caption: 'Recent backup runs',
      rows: runs,
      rowKey: (run) => String(run.id),
      empty: 'No backup has run yet.',
      columns: [
        { key: 'started', label: 'Started', render: (run) => run.started_at.replace('T', ' ').slice(0, 19) },
        { key: 'trigger', label: 'Trigger', render: (run) => run.trigger },
        {
          key: 'status',
          label: 'Result',
          render: (run) => {
            const pill = document.createElement('span')
            pill.className = 'invoice-state'
            pill.dataset.backupStatus = run.status
            pill.textContent = run.status
            return pill
          },
        },
        {
          key: 'rows',
          label: 'Rows',
          numeric: true,
          render: (run) =>
            run.total_rows === null ? '—' : run.total_rows.toLocaleString('en-US'),
        },
        {
          key: 'tables',
          label: 'Tables',
          numeric: true,
          render: (run) => (run.table_count === null ? '—' : String(run.table_count)),
        },
        // The reason it failed, where there is one. A failed run whose message
        // is only in a log is a failure nobody reads.
        { key: 'error', label: 'Detail', render: (run) => run.error_message ?? '' },
      ],
    })

  /**
   * Backups.
   *
   * The endpoint has served this since it was written and no screen asked it,
   * so whether the nightly export was working was a question only a terminal
   * could answer. A backup nobody looks at is a backup nobody knows is broken,
   * and it stays in that state until the day it is needed.
   *
   * Administrator-only, like the two sections above, and for the same reason:
   * asking as an executive manager buys a 403 and tells the operator nothing
   * about why the section is empty.
   */
  const loadBackups = async (identity: Whoami, active: ActiveSession): Promise<void> => {
    if (identity.profile !== 'administrator') {
      backupStatus.textContent = 'Backups are visible to administrators only.'
      return
    }
    if (api.getBackupStatus === undefined) {
      // The container composes no reader: its backups are the operator's
      // filesystem, and RESTORE.md is the contract there rather than this page.
      backupStatus.textContent =
        'This deployment does not manage its own backups. See RESTORE.md.'
      return
    }
    try {
      const status = await api.getBackupStatus(active.signal)
      active.present(() => {
        const now = Date.now()
        facts(backupFacts, [
          [
            'Last completed',
            status.last_completed === null
              ? 'Never'
              : `${sinceLabel(status.last_completed.completed_at ?? status.last_completed.started_at, now)} · ${(status.last_completed.total_rows ?? 0).toLocaleString('en-US')} rows`,
          ],
          [
            'Destination',
            status.last_completed?.r2_prefix ?? '—',
          ],
          ['Runs recorded', String(status.recent_runs.length)],
        ])
        // A failure is not a row in a table to be scanned for; it is the answer
        // to the only question this section is asked.
        backupAlarm.hidden = !status.has_failure
        backupAlarm.textContent =
          status.last_failed === null
            ? ''
            : `The last attempt on ${status.last_failed.started_at.slice(0, 10)} failed: ${status.last_failed.error_message ?? 'no reason was recorded'}`
        // Never having run is its own alarm. An empty history reads as "fine"
        // and is the state in which nothing can be restored.
        if (status.last_completed === null) {
          backupAlarm.hidden = false
          backupAlarm.textContent =
            'No backup has ever completed, so there is nothing to restore from.'
        }
        backupRuns.replaceChildren(backupRunTable(status.recent_runs))
        backupRuns.hidden = false
        backupStatus.textContent = ''
      })
    } catch (error) {
      active.presentFailure(error, () => {
        backupStatus.textContent = messageFor(
          error,
          'Only administrators can view backups.',
          'Backup status could not be loaded.',
        )
      })
    }
  }

  const loadSsoDomains = async (identity: Whoami, active: ActiveSession): Promise<void> => {
    // Every sso-domains route is administrator-only. Asking as an executive
    // manager buys a 403 and tells the operator nothing about why the section
    // is empty.
    if (identity.profile !== 'administrator') {
      ssoStatus.textContent = 'SSO provisioning domains are visible to administrators only.'
      return
    }
    if (api.listSsoDomains === undefined) {
      ssoStatus.textContent = 'This build has no SSO provisioning domain endpoints.'
      return
    }
    try {
      const domains = await api.listSsoDomains(active.signal)
      active.present(() => {
        ssoState = domains
        paintSsoDomains()
        ssoForm.hidden = false
        ssoStatus.textContent = ''
      })
    } catch (error) {
      active.presentFailure(error, () => {
        ssoStatus.textContent = messageFor(
          error,
          'Only administrators can manage SSO provisioning domains.',
          'SSO provisioning domains could not be loaded.',
        )
      })
    }
  }

  return {
    async activate(identity, signal, onSessionFailure) {
      clearPrivatePresentation()
      if (identity.profile !== 'administrator' && identity.profile !== 'executive_manager') {
        status.textContent = 'Only administrators can manage module settings.'
        timeStatus.textContent = ''
        emailStatus.textContent = ''
        ssoStatus.textContent = ''
        return
      }

      const active: ActiveSession = {
        signal,
        ...sessionPresenter(() => currentSession() === active, onSessionFailure),
      }
      session = active

      const configuration = Promise.all([
        loadTimeTracking(active),
        loadEmail(identity, active),
        loadBackups(identity, active),
        loadSsoDomains(identity, active),
      ])

      try {
        const modules = await fetchModules(signal)
        active.present(() => {
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
                active.present(() => {
                  const state = updated.find((m) => m.module === moduleName)
                  if (span) span.textContent = state?.enabled ? 'Enabled' : 'Disabled'
                  if (result) result.textContent = ''
                })
              } catch (error) {
                active.presentFailure(error, () => {
                  toggle.checked = !toggle.checked
                  if (span) span.textContent = toggle.checked ? 'Enabled' : 'Disabled'
                  if (result) {
                    result.textContent = error instanceof Error
                      ? error.message
                      : 'The module update could not be completed.'
                  }
                })
              } finally {
                active.present(() => {
                  toggle.disabled = false
                })
              }
            })
          }
        })
      } catch (error) {
        active.presentFailure(error, () => {
          status.textContent = error instanceof Error
            ? error.message
            : 'Modules could not be loaded.'
        })
      }
      await configuration
    },
  }
}
