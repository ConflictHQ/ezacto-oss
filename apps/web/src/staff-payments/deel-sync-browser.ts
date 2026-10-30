import { EzactoApiError } from '@conflict-hq/ezacto-client'
import type {
  DeelSyncPreview,
  DeelSyncRunResult,
  DeelSyncSettingsCommand,
  DeelSyncStatus,
  DeelSyncWindow,
} from '@conflict-hq/ezacto-client'
import { isDemoDeployment } from '../demo.js'
import { setRequestBusy } from '../request-feedback.js'

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
  let generation = 0
  let busy = false
  let pendingControls: { control: HTMLInputElement; disabled: boolean }[] = []

  const say = (text: string) => {
    message.textContent = text
  }

  const clearPreview = () => {
    preview = null
    previewResult.replaceChildren()
    reviewed.checked = false
    reviewed.disabled = true
    send.disabled = true
  }

  const restoreControls = () => {
    for (const { control, disabled } of pendingControls) control.disabled = disabled
    pendingControls = []
  }
  const action = async (phase: string, work: (active: AbortSignal, current: () => boolean) => Promise<void>) => {
    const active = signal, revision = generation
    if (!active || active.aborted || busy) return
    const current = () => signal === active && !active.aborted && generation === revision
    busy = true
    pendingControls = [...section.querySelectorAll<HTMLInputElement>('input,select,button')]
      .map(control => ({ control, disabled: control.disabled }))
    pendingControls.forEach(({ control }) => { control.disabled = true })
    say(phase)
    setRequestBusy(message, true)
    try {
      await work(active, current)
    } catch (error) {
      if (current()) say(failure(error))
    } finally {
      if (current()) {
        busy = false
        restoreControls()
        reviewed.disabled = preview === null || preview.entry_ids.length === 0
        send.disabled = reviewed.disabled || !reviewed.checked
        setRequestBusy(message, false)
      }
    }
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

  const load = async (active: AbortSignal, current: () => boolean) => {
    if (!api.getDeelSync) return
    const result = await api.getDeelSync({ signal: active })
    if (current()) renderStatus(result)
  }

  settings.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!api.updateDeelSyncSettings) return
    const data = new FormData(settings)
    void action('Saving Deel sync settings…', async (active, current) => {
      if (!api.updateDeelSyncSettings) return
      await api.updateDeelSyncSettings!({
        body: {
          mode: data.get('mode') as 'manual' | 'automatic',
          run_time: String(data.get('run_time')),
        },
        signal: active,
      })
      if (!current()) return
      await load(active, current)
      if (current()) say('Deel sync settings saved.')
    })
  })

  previewForm.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (!api.previewDeelSync) return
    const data = new FormData(previewForm)
    void action('Reviewing timesheets for Deel…', async (active, current) => {
      if (!api.previewDeelSync) return
      clearPreview()
      const result = await api.previewDeelSync!({
        body: { from: String(data.get('from')), to: String(data.get('to')) },
        signal: active,
      })
      if (!current()) return
      if (result.status !== 'ready') {
        say('Deel is not ready to review these hours. Nothing was sent. Try again after checking the connection.')
        return
      }
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
    })
  })

  reviewed.addEventListener('change', () => {
    send.disabled = busy || !reviewed.checked || preview === null
  })
  previewForm.addEventListener('input', () => { if (!busy) clearPreview() })
  previewForm.addEventListener('change', () => { if (!busy) clearPreview() })

  send.addEventListener('click', async () => {
    if (busy || preview === null || !reviewed.checked || !api.runDeelSync) return
    const sent = preview
    void action('Sending to Deel…', async (active, current) => {
      const result = await api.runDeelSync!({
        body: {
          from: sent.window.from,
          to: sent.window.to,
          entry_ids: [...sent.entry_ids],
        },
        signal: active,
      })
      if (!current()) return
      clearPreview()
      say(
        `Run ${result.run_id}: ${outcomeText(result.status)}. ${result.timesheets_submitted} timesheets and ${result.entries_transferred} entries sent to Deel.` +
          (result.error === null ? '' : ` ${result.error}`),
      )
      await load(active, current)
    })
  })

  return {
    activate: async (active: AbortSignal): Promise<void> => {
      generation++
      restoreControls()
      busy = false
      signal = active
      say('')
      setRequestBusy(message, false)
      section.hidden = active.aborted || demo || api.getDeelSync === undefined
      clearPreview()
      active.addEventListener('abort', () => {
        if (signal !== active) return
        generation++
        restoreControls()
        busy = false
        clearPreview()
        settings.reset()
        previewForm.reset()
        status.textContent = ''
        runs.replaceChildren()
        say('')
        setRequestBusy(message, false)
        section.hidden = true
      }, { once: true })
      if (!section.hidden) await action('Checking Deel sync settings…', async (active, current) => {
        await load(active, current)
        if (current()) say('')
      })
    },
  }
}
