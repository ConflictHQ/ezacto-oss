import { setRequestBusy } from '../request-feedback.js'
import type { ApplyCommand, ApplyStatus, ImportApi, ImportMapping, ImportPreview, ImportRun } from './contract.js'
import { EzactoApiError } from '@conflict-hq/ezacto-client'
import { cancelNotice } from './contract.js'
import { createCsvCatalog } from './catalog.js'
import { createCsvDiagnostics } from './diagnostics.js'
import { CsvUiError, authorityRefused, csvFailureCode, csvFailureMessage } from './errors.js'
import { applyCommand, blockers, physicalLines, startReview, type Review } from './review.js'
import { previewFacts, progressFacts, runFacts } from './view.js'

interface Activation { actor: string; administrator: boolean; signal: AbortSignal }
type CommandOperation = 'apply' | 'resume'
const stageParameter = 'csv_import'
const knownStates = new Set(['completed', 'cancelled', 'failed', 'superseded', 'paused', 'partial'])
const sameCommand = (left: ApplyCommand, right: ApplyCommand): boolean =>
  Object.keys(left).length === Object.keys(right).length && (Object.keys(right) as (keyof ApplyCommand)[]).every(key => left[key] === right[key])

/** Same-origin SDK only. A command is retained exactly until authoritative reconciliation. */
export const createCsvImportController = (root: HTMLElement, api: ImportApi) => {
  const find = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!
  const status = find<HTMLElement>('[data-csv-status]'), privateRoot = find<HTMLElement>('[data-csv-private]')
  const upload = find<HTMLFormElement>('[data-csv-upload-form]'), file = upload.elements.namedItem('file') as HTMLInputElement
  const source = find<HTMLFormElement>('[data-csv-source-form]'), workspace = source.elements.namedItem('workspace') as HTMLInputElement, zone = source.elements.namedItem('zone') as HTMLInputElement
  const mappingHost = find<HTMLElement>('[data-csv-mapping]'), reviewHost = find<HTMLElement>('[data-csv-review]'), progress = find<HTMLElement>('[data-csv-progress]')
  const confirm = find<HTMLFormElement>('[data-csv-confirm-form]'), apply = find<HTMLButtonElement>('[data-csv-apply]')
  const exclusionsForm = find<HTMLFormElement>('[data-csv-exclusions-form]'), lines = exclusionsForm.elements.namedItem('lines') as HTMLInputElement
  const check = (name: string) => confirm.elements.namedItem(name) as HTMLInputElement
  const retry = find<HTMLButtonElement>('[data-csv-retry]'), reload = find<HTMLButtonElement>('[data-csv-reload]')
  const resume = find<HTMLButtonElement>('[data-csv-resume]'), cancel = find<HTMLButtonElement>('[data-csv-cancel]'), exactRetry = find<HTMLButtonElement>('[data-csv-retry-command]'), purge = find<HTMLButtonElement>('[data-csv-purge]')
  const progressStatus = find<HTMLElement>('[data-csv-progress-status]')
  let active: Activation | null = null, generation = 0, revision = 0, busy = false, ready = false, dirty = false, stale = false, inputUnavailable = false
  let run: ImportRun | null = null, preview: ImportPreview | null = null, review: Review | null = null, draft: ImportMapping['mapping'] = {}
  let outcome: ApplyStatus | null = null, pending: { body: ApplyCommand; operation: CommandOperation } | null = null, unknown = false
  let cancelCommand: string | null = null
  let pollTimer: ReturnType<typeof setTimeout> | null = null, pollCount = 0, detach: (() => void) | null = null
  const live = (activation = active, epoch = generation) => activation !== null && active === activation && epoch === generation && !activation.signal.aborted
  const stopPolling = () => { if (pollTimer !== null) clearTimeout(pollTimer); pollTimer = null }
  const locator = (id: string | null) => {
    const url = new URL(location.href)
    if (id === null) url.searchParams.delete(stageParameter); else url.searchParams.set(stageParameter, id)
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }
  const catalog = createCsvCatalog(root, api), diagnostics = createCsvDiagnostics(root, api)
  const clearReview = () => {
    preview = null; review = null; draft = {}; dirty = false; stale = false
    mappingHost.hidden = reviewHost.hidden = true; catalog.clear(); diagnostics.clear()
    find<HTMLElement>('[data-csv-preview-facts]').replaceChildren(); find<HTMLElement>('[data-csv-confirm-state]').textContent = ''
    for (const name of ['reviewed', 'exclusions', 'difference', 'people']) check(name).checked = false
    lines.value = ''
  }
  const clear = (preserveLocator = false) => {
    generation++; revision++; stopPolling(); detach?.(); detach = null
    active = null; ready = false; busy = false; run = null; outcome = null; pending = null; unknown = false; pollCount = 0; cancelCommand = null; inputUnavailable = false
    clearReview(); privateRoot.hidden = true; source.hidden = progress.hidden = true; file.value = ''; workspace.value = ''; zone.value = ''
    find<HTMLElement>('[data-csv-run-facts]').replaceChildren(); find<HTMLElement>('[data-csv-run-facts]').hidden = true
    find<HTMLElement>('[data-csv-progress-facts]').replaceChildren(); progressStatus.textContent = ''; find<HTMLElement>('[data-csv-retention]').textContent = ''
    status.textContent = ''; setRequestBusy(status, false); root.setAttribute('aria-busy', 'false'); retry.hidden = reload.hidden = purge.hidden = true
    for (const input of root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')) input.disabled = false
    apply.disabled = true
    if (!preserveLocator) locator(null)
  }
  const paint = () => {
    if (!live()) return
    privateRoot.hidden = !ready
    for (const element of privateRoot.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')) element.disabled = busy
    for (const element of upload.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')) element.disabled = busy || unknown
    const immutable = outcome !== null && outcome.state !== 'not_confirmed'
    for (const element of [...source.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button'), ...mappingHost.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select'), ...exclusionsForm.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')]) element.disabled = busy || immutable || unknown
    catalog.dirty(busy || dirty || immutable || unknown)
    upload.hidden = run !== null && run.status !== 'purged' && !inputUnavailable
    source.hidden = run === null || run.status === 'purged' || inputUnavailable || immutable
    reload.hidden = run === null; reload.disabled = busy
    mappingHost.hidden = preview === null || immutable
    reviewHost.hidden = preview === null
    confirm.hidden = immutable && !(outcome?.allowed_actions.includes('resume'))
    const reasons = review ? blockers(review) : ['Review a fresh preview before applying.']
    find<HTMLElement>('[data-csv-confirm-state]').textContent = dirty ? 'Save the changed choices and review the fresh preview.' : stale ? 'Reload the saved choices and review a current preview.' : reasons.join(' ')
    apply.disabled = busy || !review || dirty || stale || reasons.length > 0 || immutable || unknown
    apply.hidden = immutable
    diagnostics.syncSelection()
    for (const [selector, visible] of [['[data-csv-ack-exclusions]', !!preview?.choices.excluded_lines.length], ['[data-csv-ack-difference]', (preview?.tallies.destination_delta_seconds ?? 0) !== 0], ['[data-csv-ack-people]', (preview?.tallies.people.new ?? 0) > 0]] as const) find<HTMLElement>(selector).hidden = !visible
    progress.hidden = outcome === null && !unknown
    exactRetry.hidden = !unknown || pending === null
    resume.hidden = !outcome?.allowed_actions.includes('resume') || preview === null || unknown
    resume.disabled = busy || !review || blockers(review).length > 0 || stale
    cancel.hidden = !outcome?.allowed_actions.includes('cancel'); cancel.disabled = busy
    purge.hidden = !(run?.purge_allowed || outcome?.allowed_actions.includes('purge')); purge.disabled = busy || unknown || outcome?.state === 'queued' || outcome?.state === 'running'
    const retention = outcome?.retention_deadline ?? run?.retention_deadline ?? run?.staging_expires_at
    find<HTMLElement>('[data-csv-retention]').textContent = retention ? `Staged input expires by ${retention}. Purging input never deletes committed time or setup.` : ''
  }
  const failure = (error: unknown) => {
    if (!live()) return
    if (authorityRefused(error)) { clear(); status.textContent = 'Browser import needs a current administrator session. Sign in again.'; return }
    if (['preview_stale', 'preview_changed', 'version_conflict', 'run_version_conflict'].includes(csvFailureCode(error) ?? '')) { stale = true; review = null }
    status.textContent = csvFailureMessage(error); retry.hidden = ready; paint()
  }
  const operation = async (work: (activation: Activation, epoch: number) => Promise<unknown>) => {
    const activation = active, epoch = generation
    if (!activation || !live(activation, epoch) || busy) return
    busy = true; status.textContent = 'Processing import request…'; setRequestBusy(status, true); root.setAttribute('aria-busy', 'true'); paint()
    try { await work(activation, epoch) } catch (error) { if (live(activation, epoch)) failure(error) }
    finally { if (live(activation, epoch)) { busy = false; setRequestBusy(status, false); root.setAttribute('aria-busy', 'false'); if (status.textContent === 'Processing import request…') status.textContent = 'Import status updated.'; paint() } }
  }
  const showRun = (value: ImportRun) => {
    run = value; const facts = find<HTMLElement>('[data-csv-run-facts]'); facts.hidden = false; facts.replaceChildren(runFacts(value)); paint()
  }
  const mappingInput = (): ImportMapping => {
    if (!run) throw new CsvUiError('Upload a CSV before choosing its source.')
    return { workspace_identity: workspace.value.trim(), exporter_zone: zone.value.trim(), date_format: 'iso', destination_interpretation: 'source_wall_time', currency_policy: 'destination_rates', mapping: structuredClone(draft), excluded_lines: physicalLines(lines.value), version: run.version }
  }
  const showPreview = async (value: ImportPreview, activation: Activation, epoch: number) => {
    if (!live(activation, epoch)) return
    clearReview(); preview = value; showRun(value.run); draft = structuredClone(value.choices.mapping)
    workspace.value = value.choices.workspace_identity; zone.value = value.choices.exporter_zone; lines.value = value.choices.excluded_lines.join(', ')
    stale = value.run.preview_stale; review = startReview(value, activation.actor)
    find<HTMLElement>('[data-csv-preview-facts]').replaceChildren(previewFacts(value)); paint()
    const request = ++revision, isCurrent = () => live(activation, epoch) && preview === value && revision === request
    await Promise.all([
      catalog.activate({ preview: value, signal: activation.signal, isCurrent, canEdit: () => !busy && !unknown && (!outcome || outcome.state === 'not_confirmed'), mapping: () => draft, edit: mapping => { if (!isCurrent() || busy || unknown) return; draft = mapping; dirty = true; review = null; paint() }, failure }),
      diagnostics.activate({ preview: value, signal: activation.signal, isCurrent,
        canEdit: () => !busy && !unknown && (!outcome || outcome.state === 'not_confirmed'),
        excludedLines: () => { try { return physicalLines(lines.value) } catch { return null } },
        exclude: (line, exclude) => {
        if (!isCurrent() || busy || unknown || outcome && outcome.state !== 'not_confirmed') return
        const selected = new Set(physicalLines(lines.value)); if (exclude) selected.add(line); else selected.delete(line)
        lines.value = [...selected].sort((a, b) => a - b).join(', '); dirty = true; review = null; paint()
      }, failure }),
    ])
  }
  const scheduleStatus = () => {
    stopPolling()
    if (!live() || !outcome || knownStates.has(outcome.state) || pollCount >= 30) return
    pollTimer = setTimeout(() => { pollTimer = null; if (!busy) void operation(async (activation, epoch) => { pollCount++; await readStatus(activation, epoch) }); else scheduleStatus() }, 2000)
  }
  const showOutcome = (value: ApplyStatus) => {
    outcome = value
    if (value.command_known) { unknown = false; pending = null }
    if (!value.allowed_actions.includes('cancel')) cancelCommand = null
    find<HTMLElement>('[data-csv-progress-facts]').replaceChildren(progressFacts(value))
    progressStatus.textContent = value.state === 'cancelled' ? cancelNotice(value.committed_rows, value.created_setup) : `Import state: ${value.state}.${value.code ? ` ${value.code.replaceAll('_', ' ')}.` : ''} Committed progress is authoritative.`
    paint(); scheduleStatus()
  }
  const readStatus = async (activation: Activation, epoch: number) => {
    if (!run) return null
    const id = run.id, command = pending?.body.command_id
    const value = (await api.getCsvImportApply({ runId: id, ...(command ? { query: { command_id: command } } : {}), signal: activation.signal })).data
    if (!live(activation, epoch) || run?.id !== id) return null
    showOutcome(value)
    if (value.pending_command && !value.command_known) {
      unknown = true
      // The server replays any accepted packet through Apply before branching on operation.
      if (pending === null) pending = { body: structuredClone(value.pending_command), operation: 'apply' }
      progressStatus.textContent = pending.body.command_id === value.pending_command.command_id
        ? 'A confirmation is accepted but its outcome is not yet known. Refresh authoritative status or retry its exact accepted packet; do not start another import.'
        : 'The newest command outcome is unknown. The server still shows an earlier accepted command. Retry only the newest exact packet or refresh status; do not start another command.'
      paint()
    }
    return value
  }
  const restore = async (id: string, activation: Activation, epoch: number) => {
    const value = (await api.getCsvImport({ runId: id, signal: activation.signal })).data
    if (!live(activation, epoch)) return
    clearReview(); inputUnavailable = false; workspace.value = zone.value = ''; showRun(value); locator(value.id)
    await readStatus(activation, epoch)
    if (!live(activation, epoch)) return
    if (value.status === 'purged') {
      inputUnavailable = true; source.hidden = true
      if (live(activation, epoch)) status.textContent = 'This staged input expired or was purged. Committed progress remains; resuming requires an identical owned reupload and fresh review.'
      return
    }
    let state
    try { state = (await api.getCsvImportMapping({ runId: id, signal: activation.signal })).data }
    catch (error) {
      if (!live(activation, epoch)) return
      if (csvFailureCode(error) !== 'preview_stale') throw error
      // Raw expiry can precede the sweep that changes stage.status. Metadata remains usable.
      clearReview(); workspace.value = zone.value = ''; stale = true; inputUnavailable = true
      status.textContent = 'The staged input or its private choices are no longer available. Authoritative progress and Stop remain available; resume needs an identical owned reupload and fresh review.'
      paint(); return
    }
    if (!live(activation, epoch)) return
    if (state.choices) { workspace.value = state.choices.workspace_identity; zone.value = state.choices.exporter_zone; draft = structuredClone(state.choices.mapping); lines.value = state.choices.excluded_lines.join(', ') }
    if (value.preview_id && !value.preview_stale) {
      const immutable = (await api.previewCsvImport({ runId: id, body: { preview_id: value.preview_id }, signal: activation.signal })).data
      if (!live(activation, epoch)) return
      await showPreview(immutable, activation, epoch)
    }
    if (live(activation, epoch)) status.textContent = 'Saved import status loaded. Review before any new command.'
  }
  const refreshPreview = async (activation: Activation, epoch: number) => {
    if (!run || inputUnavailable || unknown || outcome && outcome.state !== 'not_confirmed') return
    const id = run.id, input = mappingInput()
    const mapped = (await api.mapCsvImport({ runId: id, body: input, signal: activation.signal })).data
    if (!live(activation, epoch)) return
    showRun(mapped)
    const value = (await api.previewCsvImport({ runId: id, signal: activation.signal })).data
    if (!live(activation, epoch)) return
    outcome = null; await showPreview(value, activation, epoch); status.textContent = 'Preview ready. No people, setup or time have been imported.'
  }
  upload.addEventListener('submit', event => {
    event.preventDefault()
    void operation(async (activation, epoch) => {
      if (unknown || run && run.status !== 'purged' && !inputUnavailable) return
      const selected = file.files?.[0]
      if (!selected || selected.size === 0 || selected.size > 5 * 1024 * 1024) throw new CsvUiError('Choose a nonempty CSV no larger than 5 MiB.')
      const bytes = await selected.arrayBuffer()
      if (!live(activation, epoch)) return
      const digest = await crypto.subtle.digest('SHA-256', bytes)
      if (!live(activation, epoch)) return
      const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
      const value = (await api.uploadCsvImport({ 'X-CSV-SHA256': hash, 'X-CSV-Bytes': selected.size, body: new Uint8Array(bytes), signal: activation.signal })).data
      if (!live(activation, epoch)) return
      file.value = ''; clearReview(); inputUnavailable = false; outcome = null; showRun(value); locator(value.id); status.textContent = 'CSV staged privately. Enter its stable workspace identity and exporter timezone.'; workspace.focus()
    })
  })
  source.addEventListener('submit', event => { event.preventDefault(); void operation(refreshPreview) })
  find<HTMLButtonElement>('[data-csv-save-mapping]').addEventListener('click', () => void operation(refreshPreview))
  exclusionsForm.addEventListener('submit', event => { event.preventDefault(); void operation(refreshPreview) })
  for (const input of [workspace, zone, lines]) input.addEventListener('input', () => { dirty = true; review = null; paint() })
  confirm.addEventListener('change', () => {
    if (!review || !live()) return
    review = { ...review, reviewed: check('reviewed').checked, exclusions: check('exclusions').checked, destinationDifference: check('difference').checked, newPeople: check('people').checked }; paint()
  })
  const send = async (body: ApplyCommand, method: CommandOperation, activation: Activation, epoch: number) => {
    if (!run) return
    pending = { body: structuredClone(body), operation: method }; unknown = true; stopPolling(); paint()
    try {
      const args = { runId: run.id, body, 'Idempotency-Key': body.command_id, signal: activation.signal }
      const response = await (method === 'apply' ? api.applyCsvImport(args) : api.resumeCsvImport(args))
      if (live(activation, epoch)) showOutcome(response.data)
    } catch (error) {
      if (!live(activation, epoch)) return
      if (authorityRefused(error)) { failure(error); return }
      progress.hidden = false; progressStatus.textContent = 'The command outcome is unknown. Reconcile authoritative status or retry this exact command; do not start a new one.'
      // A transport error does not establish that the transaction failed.
      try {
        const authoritative = await readStatus(activation, epoch)
        if (!live(activation, epoch)) return
        const refused = error instanceof EzactoApiError && [400, 404, 409, 413, 415, 422].includes(error.status)
        if (refused && authoritative) {
          const acceptedPacket = authoritative.pending_command
          if (!acceptedPacket || !sameCommand(acceptedPacket, body)) {
            unknown = false; pending = null; stale = true; review = null
            status.textContent = 'This command was refused. Authoritative status has been reconciled. Reload the saved choices and review before any new command.'
          } else {
            status.textContent = 'The accepted confirmation still exists. Reconcile or retry only its exact packet; do not create a replacement command.'
          }
        }
      } catch (statusError) { if (live(activation, epoch)) failure(statusError) }
    }
  }
  confirm.addEventListener('submit', event => { event.preventDefault(); void operation(async (activation, epoch) => {
    if (!review || dirty || stale || unknown || outcome && outcome.state !== 'not_confirmed') return
    await send(applyCommand(review, crypto.randomUUID()), 'apply', activation, epoch)
  }) })
  exactRetry.addEventListener('click', () => void operation(async (activation, epoch) => { if (pending && unknown) await send(pending.body, pending.operation, activation, epoch) }))
  resume.addEventListener('click', () => void operation(async (activation, epoch) => {
    if (!review || !run || unknown || stale || !outcome?.allowed_actions.includes('resume')) return
    const current = (await api.getCsvImport({ runId: run.id, signal: activation.signal })).data
    if (!live(activation, epoch)) return
    showRun(current); await send(applyCommand(review, crypto.randomUUID(), current.version), 'resume', activation, epoch)
  }))
  cancel.addEventListener('click', () => void operation(async (activation, epoch) => {
    if (!run || !outcome?.allowed_actions.includes('cancel')) return
    cancelCommand ??= crypto.randomUUID()
    try {
      const value = (await api.cancelCsvImport({ runId: run.id, body: { command_id: cancelCommand }, 'Idempotency-Key': cancelCommand, signal: activation.signal })).data
      if (live(activation, epoch)) showOutcome(value)
    } catch (error) {
      if (!live(activation, epoch)) return
      if (authorityRefused(error)) { failure(error); return }
      progressStatus.textContent = 'The stop outcome is unknown. Refresh authoritative status; retrying Stop uses the same command. Committed work is never rolled back.'
      try { await readStatus(activation, epoch) } catch (statusError) { if (live(activation, epoch)) failure(statusError) }
    }
  }))
  find<HTMLButtonElement>('[data-csv-refresh-status]').addEventListener('click', () => void operation(readStatus))
  reload.addEventListener('click', () => void operation(async (activation, epoch) => { if (run && !unknown) await restore(run.id, activation, epoch); else await readStatus(activation, epoch) }))
  find<HTMLButtonElement>('[data-csv-download]').addEventListener('click', () => void operation(async (activation, epoch) => {
    if (!run || !preview) return
    const bytes = await api.downloadCsvImportDiagnostics({ runId: run.id, query: { preview_id: preview.preview_id }, signal: activation.signal })
    if (!live(activation, epoch)) return
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/json' }))
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'clockify-import-diagnostics.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0)
  }))
  purge.addEventListener('click', () => void operation(async (activation, epoch) => {
    if (!run || unknown || !(run.purge_allowed || outcome?.allowed_actions.includes('purge'))) return
    const id = run.id
    await api.purgeCsvImportInput({ runId: id, signal: activation.signal })
    if (!live(activation, epoch)) return
    clearReview(); workspace.value = zone.value = ''; source.hidden = true; run = null; locator(null)
    find<HTMLElement>('[data-csv-run-facts]').replaceChildren(); find<HTMLElement>('[data-csv-run-facts]').hidden = true
    status.textContent = 'Staged input, private choices and diagnostics were purged. Committed time and setup remain. Resume needs an identical owned reupload and fresh review.'
  }))
  const activate = async (activation: Activation) => {
    clear(true); active = activation; const epoch = generation
    const abort = () => { if (active === activation) { clear(); locator(null) } }
    activation.signal.addEventListener('abort', abort, { once: true })
    const leave = (event: BeforeUnloadEvent) => { if (live() && (busy || unknown || outcome?.state === 'queued' || outcome?.state === 'running')) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', leave)
    detach = () => { activation.signal.removeEventListener('abort', abort); window.removeEventListener('beforeunload', leave) }
    if (activation.signal.aborted) { abort(); return }
    if (!activation.administrator) { status.textContent = 'Browser CSV import requires an administrator session. Ask an administrator or use the operator migration tool.'; return }
    await operation(async (current, currentEpoch) => {
      status.textContent = 'Checking browser import availability…'
      const capability = (await api.getCsvImportCapabilities({ signal: current.signal })).data
      if (!live(current, currentEpoch)) return
      ready = capability.runtime === 'container' && capability.staging_supported && capability.browser_ready && capability.apply_supported
      if (!ready) { status.textContent = 'Browser import is unavailable on this runtime. Use the operator CSV migration tool; no file has been read or uploaded.'; return }
      status.textContent = 'Choose a Clockify Detailed CSV to review before importing.'
      const id = new URL(location.href).searchParams.get(stageParameter)
      if (id) await restore(id, current, currentEpoch)
    })
    if (live(activation, epoch)) paint()
  }
  retry.addEventListener('click', () => { if (active) void activate(active) })
  return { activate, clear }
}
