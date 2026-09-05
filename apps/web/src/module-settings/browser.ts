import type { Whoami } from '@ezacto/client'

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

export interface ModuleSettingsController {
  activate(
    identity: Whoami,
    signal: AbortSignal,
    onSessionFailure: (error: unknown) => boolean,
  ): Promise<void>
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

export const createModuleSettingsController = (): ModuleSettingsController => {
  const status = required<HTMLElement>('[data-module-settings-status]')
  const list = required<HTMLElement>('[data-module-settings-list]')

  return {
    async activate(identity, signal, onSessionFailure) {
      if (identity.profile !== 'administrator' && identity.profile !== 'executive_manager') {
        status.textContent = 'Only administrators can manage module settings.'
        return
      }

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
    },
  }
}
