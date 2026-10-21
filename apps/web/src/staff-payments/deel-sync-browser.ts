import { EzactoApiError } from '@conflict-hq/ezacto-client'
import type {
  DeelSyncPreview,
  DeelSyncRunResult,
  DeelSyncSettingsCommand,
  DeelSyncStatus,
  DeelSyncWindow,
} from '@conflict-hq/ezacto-client'
import { isDemoDeployment } from '../demo.js'

/**
 * The Deel time sync panel on the staff payments page (#1102). An administrator
 * chooses manual or automatic, the automatic time, and sends timesheets to Deel
 * only after previewing them and ticking that they reviewed the preview.
 */
export interface DeelSyncApi {
  getDeelSync?(args?: { signal?: AbortSignal }): Promise<DeelSyncStatus>
  updateDeelSyncSettings?(args: {
    body: DeelSyncSettingsCommand
    signal?: AbortSignal
  }): Promise<void>
  previewDeelSync?(args: { body: DeelSyncWindow; signal?: AbortSignal }): Promise<DeelSyncPreview>
  runDeelSync?(args: {
    body: { from: string; to: string; entry_ids: number[] }
    signal?: AbortSignal
  }): Promise<DeelSyncRunResult>
}

const failure = (error: unknown): string => {
  if (error instanceof EzactoApiError) {
    const body = error.body as {
      error?: { message?: string; fields?: { message?: string }[] }
    } | null
    return (
      body?.error?.fields?.[0]?.message ??
      body?.error?.message ??
      'The Deel sync could not complete. Try again.'
    )
  }
  return 'The Deel sync could not complete. Try again.'
}

const outcomeText = (outcome: string): string =>
  outcome === 'running' ? 'Running' : outcome === 'completed' ? 'Completed' : 'Failed'

const element = <T extends HTMLElement>(root: Document | HTMLElement, selector: string): T => {
  const found = root.querySelector<T>(selector)
  if (found === null) throw new Error(`Deel sync panel is missing ${selector}`)
  return found
}

export const createDeelSyncController = (page: HTMLElement, api: DeelSyncApi) => {
  const section = page.querySelector<HTMLElement>('[data-deel-sync]')
  if (section === null) return { activate: async () => {} }
  const status = element<HTMLElement>(section, '[data-deel-sync-status]')
  const settings = element<HTMLFormElement>(section, '[data-deel-sync-settings]')
  const mode = element<HTMLElement & { value: string }>(settings, 'select[name=mode]')
  const runTime = element<HTMLElement & { value: string }>(settings, 'input[name=run_time]')
  const previewForm = element<HTMLFormElement>(section, '[data-deel-sync-preview]')
  const previewResult = element<HTMLElement>(section, '[data-deel-sync-preview-result]')
  const reviewed = element<HTMLElement & { checked: boolean; disabled: boolean }>(section, '[data-deel-sync-reviewed]')
  const send = element<HTMLElement & { disabled: boolean }>(section, '[data-deel-sync-send]')
  const runs = element<HTMLElement>(section, '[data-deel-sync-runs]')
  const message = element<HTMLElement>(section, '[data-deel-sync-message]')
  const demo = isDemoDeployment()
  let signal: AbortSignal | null = null
  let preview: (DeelSyncPreview & { status: 'ready' }) | null = null

  const say = (text: string) => {
    message.textContent = text
  }

  const clearPreview = () => {
    preview = null
    previewResult.replaceChildren()
    reviewed.checked = false
    send.disabled = true
  }

  const renderStatus = (current: DeelSyncStatus) => {
    ;mode.value = current.mode
    ;runTime.value = current.run_time
    status.textContent = current.configured
      ? `Configured. Mode: ${current.mode}${current.mode === 'automatic' ? `, runs daily at ${current.run_time} in the organization timezone` : ', nothing is sent until you preview and send'}.`
      : `Not configured: ${current.reason ?? 'unknown reason'}. Nothing can be sent to Deel.`
    if (current.runs.length === 0) {
      runs.textContent = 'No Deel sync runs yet.'
      return
    }
    const list = document.createElement('ul')
    list.replaceChildren(
      ...current.runs.map((run) => {
        const item = document.createElement('li')
        item.textContent = `${run.started_at.slice(0, 16).replace('T', ' ')} UTC: ${outcomeText(run.outcome)}, ${run.timesheets_submitted} timesheets, ${run.entries_transferred} entries`
        return item
      }),
    )
    runs.replaceChildren(list)
  }

  const load = async () => {
    if (demo) {
      section.hidden = true
      return
    }
    try {
      renderStatus(await api.getDeelSync!({ ...(signal === null ? {} : { signal }) }))
    } catch (error) {
      say(failure(error))
    }
  }

  settings.addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = new FormData(settings)
    try {
      await api.updateDeelSyncSettings!({
        body: {
          mode: data.get('mode') as 'manual' | 'automatic',
          run_time: String(data.get('run_time')),
        },
        ...(signal === null ? {} : { signal }),
      })
      say('Deel sync settings saved.')
      await load()
    } catch (error) {
      say(failure(error))
    }
  })

  previewForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    const data = new FormData(previewForm)
    clearPreview()
    try {
      const result = await api.previewDeelSync!({
        body: { from: String(data.get('from')), to: String(data.get('to')) },
        ...(signal === null ? {} : { signal }),
      })
      if (result.status !== 'ready') return
      preview = result as DeelSyncPreview & { status: 'ready' }
      previewResult.textContent =
        `${result.timesheets} timesheet${result.timesheets === 1 ? '' : 's'} (${result.entry_ids.length} entries) would be sent to Deel for ${result.window.from} to ${result.window.to}. ` +
        `${result.already_transferred} entries were already sent. ${result.conflicts.length} conflicts, ${result.unsyncable.length} entries that cannot be sent, ${result.unmatched.length} people without a Deel match.`
      reviewed.disabled = result.entry_ids.length === 0
      say(
        result.entry_ids.length === 0
          ? 'Nothing new to send in this window.'
          : 'Review the preview, then tick the box to send.',
      )
    } catch (error) {
      say(failure(error))
    }
  })

  reviewed.addEventListener('change', () => {
    send.disabled = !reviewed.checked || preview === null
  })

  send.addEventListener('click', async () => {
    if (preview === null || !reviewed.checked) return
    const sent = preview
    send.disabled = true
    say('Sending to Deel…')
    try {
      const result = await api.runDeelSync!({
        body: {
          from: sent.window.from,
          to: sent.window.to,
          entry_ids: [...sent.entry_ids],
        },
        ...(signal === null ? {} : { signal }),
      })
      clearPreview()
      say(
        `Run ${result.run_id}: ${outcomeText(result.status)}. ${result.timesheets_submitted} timesheets and ${result.entries_transferred} entries sent to Deel.` +
          (result.error === null ? '' : ` ${result.error}`),
      )
      await load()
    } catch (error) {
      say(failure(error))
      send.disabled = false
    }
  })

  return {
    activate: async (active: AbortSignal): Promise<void> => {
      signal = active
      section.hidden = demo || api.getDeelSync === undefined
      clearPreview()
      if (!section.hidden) await load()
    },
  }
}
