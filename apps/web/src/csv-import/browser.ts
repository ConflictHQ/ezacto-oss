import type { ImportApi, ImportMapping, ImportPreview, ImportRun } from './contract.js'
import { createCsvCatalog } from './catalog.js'
import { createCsvDiagnostics } from './diagnostics.js'
import { CsvUiError, authorityRefused, csvFailureCode, csvFailureMessage } from './errors.js'
import { physicalLines, startReview } from './review.js'
import { previewFacts, runFacts } from './view.js'
import { setRequestBusy } from '../request-feedback.js'

interface Activation { actor: string; administrator: boolean; signal: AbortSignal }
const stageParameter = 'csv_import'

/** Private staging only. No apply route is composed or called by this controller. */
export const createCsvImportController = (root: HTMLElement, api: ImportApi) => {
  const find = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!
  const status = find<HTMLElement>('[data-csv-status]'), privateRoot = find<HTMLElement>('[data-csv-private]')
  const upload = find<HTMLFormElement>('[data-csv-upload-form]'), file = upload.elements.namedItem('file') as HTMLInputElement
  const source = find<HTMLFormElement>('[data-csv-source-form]'), workspace = source.elements.namedItem('workspace') as HTMLInputElement, zone = source.elements.namedItem('zone') as HTMLInputElement
  const mappingHost = find<HTMLElement>('[data-csv-mapping]'), reviewHost = find<HTMLElement>('[data-csv-review]')
  const exclusions = find<HTMLFormElement>('[data-csv-exclusions-form]'), lines = exclusions.elements.namedItem('lines') as HTMLInputElement
  const retry = find<HTMLButtonElement>('[data-csv-retry]'), reload = find<HTMLButtonElement>('[data-csv-reload]'), purge = find<HTMLButtonElement>('[data-csv-purge]')
  const catalog = createCsvCatalog(root, api), diagnostics = createCsvDiagnostics(root, api)
  let lastActivation: Activation | null = null
  let active: Activation | null = null, owner: AbortController | null = null, generation = 0, revision = 0
  let busy = false, ready = false, dirty = false, stale = false, run: ImportRun | null = null, preview: ImportPreview | null = null
  let draft: ImportMapping['mapping'] = {}, detach: (() => void) | null = null
  const live = (activation = active, epoch = generation) => activation !== null && active === activation && epoch === generation && !activation.signal.aborted
  const locator = (id: string | null) => {
    const url = new URL(location.href)
    if (id === null) url.searchParams.delete(stageParameter); else url.searchParams.set(stageParameter, id)
    history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`)
  }
  const clearPreview = () => {
    revision++; preview = null; draft = {}; dirty = stale = false; catalog.clear(); diagnostics.clear()
    mappingHost.hidden = reviewHost.hidden = true
    find<HTMLElement>('[data-csv-preview-facts]').replaceChildren(); find<HTMLElement>('[data-csv-confirm-state]').textContent = ''; lines.value = ''
  }
  const clear = (preserveLocator = false) => {
    generation++; detach?.(); detach = null; owner?.abort(); owner = null; active = null; ready = busy = false; run = null
    clearPreview(); privateRoot.hidden = source.hidden = true; file.value = workspace.value = zone.value = ''; status.textContent = ''
    find<HTMLElement>('[data-csv-run-facts]').replaceChildren(); find<HTMLElement>('[data-csv-run-facts]').hidden = true
    find<HTMLElement>('[data-csv-retention]').textContent = ''; retry.hidden = reload.hidden = purge.hidden = true
    setRequestBusy(status, false); root.setAttribute('aria-busy', 'false')
    if (!preserveLocator) locator(null)
  }
  const paint = () => {
    if (!live()) return
    privateRoot.hidden = !ready
    for (const element of privateRoot.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')) element.disabled = busy
    find<HTMLButtonElement>('[data-csv-apply]').disabled = true
    for (const element of upload.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input,button')) element.disabled = busy || run !== null
    source.hidden = !run || !run.allowed_actions.includes('map')
    mappingHost.hidden = reviewHost.hidden = preview === null
    reload.hidden = run === null; reload.disabled = busy
    purge.hidden = !run?.purge_allowed; purge.disabled = busy
    retry.disabled = busy; catalog.dirty(busy); diagnostics.syncSelection()
    find<HTMLElement>('[data-csv-confirm-state]').textContent = dirty ? 'Choices changed. Refresh the preview to review this new selection.' : stale ? 'The preview is stale. Reload the saved choices and refresh it.' : preview ? 'This preview is immutable. Applying it is not enabled.' : ''
    const expiry = run?.retention_deadline ?? run?.staging_expires_at
    find<HTMLElement>('[data-csv-retention]').textContent = expiry ? `Private input expires by ${expiry}. Purging it does not delete any organization records.` : ''
  }
  const failure = (error: unknown) => {
    if (!live()) return
    if (authorityRefused(error)) { clear(); status.textContent = 'A current administrator session is required. Sign in again.'; return }
    if (csvFailureCode(error) === 'preview_stale') stale = true
    status.textContent = csvFailureMessage(error); retry.hidden = ready; paint()
  }
  const operation = async (message: string, action: (activation: Activation, epoch: number) => Promise<void>) => {
    if (!live() || busy) return
    const activation = active!, epoch = generation
    busy = true; status.textContent = message; setRequestBusy(status, true); root.setAttribute('aria-busy', 'true'); paint()
    try { await action(activation, epoch) } catch (error) { if (live(activation, epoch)) failure(error) }
    finally { if (live(activation, epoch)) { busy = false; setRequestBusy(status, false); root.setAttribute('aria-busy', 'false'); paint() } }
  }
  const showRun = (value: ImportRun) => {
    run = value
    const host = find<HTMLElement>('[data-csv-run-facts]'); host.hidden = false; host.replaceChildren(runFacts(value)); paint()
  }
  const showPreview = async (value: ImportPreview, activation: Activation, epoch: number) => {
    if (!live(activation, epoch)) return
    clearPreview(); preview = startReview(value, activation.actor).preview
    const snapshot = preview
    showRun(snapshot.run); draft = structuredClone(snapshot.choices.mapping)
    workspace.value = snapshot.choices.workspace_identity; zone.value = snapshot.choices.exporter_zone; lines.value = snapshot.choices.excluded_lines.join(', ')
    stale = snapshot.run.preview_stale
    find<HTMLElement>('[data-csv-preview-facts]').replaceChildren(previewFacts(snapshot)); paint()
    const request = ++revision, isCurrent = () => live(activation, epoch) && preview === snapshot && revision === request
    const canEdit = () => isCurrent() && !busy && !stale
    await Promise.all([
      catalog.activate({ preview: snapshot, signal: activation.signal, isCurrent, canEdit, mapping: () => draft, edit: value => { if (!canEdit()) return; draft = value; dirty = true; paint() }, failure }),
      diagnostics.activate({ preview: snapshot, signal: activation.signal, isCurrent, canEdit, excludedLines: () => { try { return physicalLines(lines.value) } catch { return null } }, exclude: (line, exclude) => {
        if (!canEdit()) return
        const selected = new Set(physicalLines(lines.value)); if (exclude) selected.add(line); else selected.delete(line)
        lines.value = [...selected].sort((a,b) => a-b).join(', '); dirty = true; paint()
      }, failure }),
    ])
  }
  const restore = async (id: string, activation: Activation, epoch: number) => {
    const value = (await api.getCsvImport({ runId: id, signal: activation.signal })).data
    if (!live(activation, epoch)) return
    clearPreview(); showRun(value); locator(value.id)
    if (value.status === 'purged' && !value.purge_allowed) { run = null; locator(null); paint() }
    if (!value.allowed_actions.includes('map')) { status.textContent = value.purge_allowed ? 'Input is unavailable. Retry purging its private files.' : 'Input was purged or expired. Choose another CSV.'; return }
    const saved = (await api.getCsvImportMapping({ runId: id, signal: activation.signal })).data
    if (!live(activation, epoch)) return
    if (saved.choices) { workspace.value = saved.choices.workspace_identity; zone.value = saved.choices.exporter_zone; draft = structuredClone(saved.choices.mapping); lines.value = saved.choices.excluded_lines.join(', ') }
    if (value.preview_id && !value.preview_stale) {
      const snapshot = (await api.previewCsvImport({ runId: id, body: { preview_id: value.preview_id }, signal: activation.signal })).data
      if (live(activation, epoch)) await showPreview(snapshot, activation, epoch)
    }
    if (live(activation, epoch)) status.textContent = 'Saved choices loaded. Review or refresh the preview.'
  }
  const refresh = async (activation: Activation, epoch: number) => {
    if (!run) return
    const id = run.id
    const input: ImportMapping = { workspace_identity: workspace.value.trim(), exporter_zone: zone.value.trim(), date_format: 'iso', destination_interpretation: 'source_wall_time', currency_policy: 'destination_rates', mapping: structuredClone(draft), excluded_lines: physicalLines(lines.value), version: run.version }
    const mapped = (await api.mapCsvImport({ runId: id, body: input, signal: activation.signal })).data
    if (!live(activation, epoch)) return
    showRun(mapped); status.textContent = 'Building the immutable preview…'
    const value = (await api.previewCsvImport({ runId: id, signal: activation.signal })).data
    if (!live(activation, epoch)) return
    await showPreview(value, activation, epoch)
    if (live(activation, epoch)) status.textContent = 'Preview ready. No people, setup or time have been imported.'
  }
  upload.addEventListener('submit', event => { event.preventDefault(); void operation('Reading and hashing the selected CSV…', async (activation, epoch) => {
    if (run) return
    const selected = file.files?.[0]
    if (!selected || selected.size === 0 || selected.size > 5 * 1024 * 1024) throw new CsvUiError('Choose a nonempty CSV no larger than 5 MiB.')
    const bytes = await selected.arrayBuffer()
    if (!live(activation, epoch)) return
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    if (!live(activation, epoch)) return
    const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    status.textContent = 'Uploading and checking the CSV in private staging…'
    const value = (await api.uploadCsvImport({ 'X-CSV-SHA256': hash, 'X-CSV-Bytes': selected.size, body: new Uint8Array(bytes), signal: activation.signal })).data
    if (!live(activation, epoch)) return
    file.value = ''; clearPreview(); showRun(value); locator(value.id); status.textContent = 'CSV staged privately. Enter its workspace identity and exporter timezone.'; workspace.focus()
  }) })
  source.addEventListener('submit', event => { event.preventDefault(); void operation('Saving reviewed source choices…', refresh) })
  exclusions.addEventListener('submit', event => { event.preventDefault(); void operation('Saving the exact selected lines…', refresh) })
  find<HTMLButtonElement>('[data-csv-save-mapping]').addEventListener('click', () => void operation('Saving destination mappings…', refresh))
  for (const input of [workspace, zone, lines]) input.addEventListener('input', () => { dirty = true; paint() })
  reload.addEventListener('click', () => { if (run) void operation('Reloading saved choices…', (activation, epoch) => restore(run!.id, activation, epoch)) })
  find<HTMLButtonElement>('[data-csv-download]').addEventListener('click', () => void operation('Preparing all static diagnostics…', async (activation, epoch) => {
    if (!preview || dirty || stale) throw new CsvUiError('Refresh the preview before downloading diagnostics.')
    const data = await api.downloadCsvImportDiagnostics({ runId: preview.run.id, query: { preview_id: preview.preview_id }, signal: activation.signal })
    if (!live(activation, epoch)) return
    const url = URL.createObjectURL(new Blob([data], { type: 'application/json' })), link = document.createElement('a')
    link.href = url; link.download = 'csv-diagnostics.json'; link.click(); URL.revokeObjectURL(url); status.textContent = 'Static diagnostics downloaded.'
  }))
  purge.addEventListener('click', () => void operation('Purging private input and diagnostics…', async (activation, epoch) => {
    if (!run?.purge_allowed) return
    await api.purgeCsvImportInput({ runId: run.id, signal: activation.signal })
    if (!live(activation, epoch)) return
    clearPreview(); run = null; locator(null); source.hidden = true; workspace.value = zone.value = ''; find<HTMLElement>('[data-csv-run-facts]').replaceChildren(); find<HTMLElement>('[data-csv-run-facts]').hidden = true
    status.textContent = 'Private input and diagnostics purged. Organization records are unchanged.'
  }))
  const activate = async (activation: Activation) => {
    lastActivation = activation
    clear(true); owner = new AbortController(); active = { ...activation, signal: AbortSignal.any([activation.signal, owner.signal]) }
    const current = active
    const abort = () => { if (active === current) clear() }
    activation.signal.addEventListener('abort', abort, { once: true })
    const leave = (event: BeforeUnloadEvent) => { if (live() && busy) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', leave)
    detach = () => { activation.signal.removeEventListener('abort', abort); window.removeEventListener('beforeunload', leave) }
    if (activation.signal.aborted) { abort(); return }
    if (!activation.administrator) { status.textContent = 'Browser CSV import requires an administrator session.'; return }
    await operation('Checking browser import availability…', async (session, epoch) => {
      const capability = (await api.getCsvImportCapabilities({ signal: session.signal })).data
      if (!live(session, epoch)) return
      ready = capability.runtime === 'container' && capability.staging_supported && capability.browser_ready
      if (!ready) { status.textContent = 'Browser import is unavailable on this runtime. Use the operator CSV migration tool; no file has been read or uploaded.'; return }
      status.textContent = 'Choose a Clockify Detailed CSV to review. Applying is not enabled.'
      const id = new URL(location.href).searchParams.get(stageParameter)
      if (id) await restore(id, session, epoch)
    })
  }
  retry.addEventListener('click', () => { if (lastActivation) void activate(lastActivation) })
  return { activate, clear }
}
