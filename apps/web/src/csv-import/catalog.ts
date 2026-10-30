import { setRequestBusy } from '../request-feedback.js'
import type { DestinationCandidate, EntityKind, ImportMapping, ImportPreview, ImportStagingApi, SourceEntity } from './contract.js'
import { CsvUiError, csvFailureMessage } from './errors.js'
import { currentCreation, editMapping } from './mapping.js'
import { node } from './view.js'

export interface CatalogContext {
  readonly preview: ImportPreview
  readonly signal: AbortSignal
  isCurrent(): boolean
  canEdit(): boolean
  mapping(): ImportMapping['mapping']
  edit(mapping: ImportMapping['mapping']): void
  failure(error: unknown): void
}
const kinds: readonly EntityKind[] = ['people', 'clients', 'projects', 'tasks']

export const createCsvCatalog = (root: HTMLElement, api: ImportStagingApi) => {
  const host = root.querySelector<HTMLElement>('[data-csv-catalog]')!
  const status = root.querySelector<HTMLElement>('[data-csv-catalog-status]')!
  const more = root.querySelector<HTMLButtonElement>('[data-csv-catalog-more]')!
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-csv-kind]')]
  let active: CatalogContext | null = null, kind: EntityKind = 'people', revision = 0, busy = false, locked = false
  let cursor: string | null = null, total = 0, seen = new Set<string>()
  let rows: SourceEntity[] = []
  const current = (context: CatalogContext, request = revision) => active === context && context.isCurrent() && !context.signal.aborted && request === revision
  const labelCandidate = (candidate: DestinationCandidate): string =>
    `${candidate.name} (#${candidate.id})${candidate.parent_name ? ` · ${candidate.parent_name}${candidate.parent_id === null ? '' : ` (#${candidate.parent_id})`}` : ''}${candidate.currency ? ` · ${candidate.currency} (unpriced)` : ''}${!candidate.is_active ? candidate.selectable ? ' · inactive person' : ' · archived, unavailable' : ''}`

  const card = (source: SourceEntity, context: CatalogContext): HTMLElement => {
    const article = node('article'); article.className = 'csv-import-card'; article.dataset.csvSourceKey = source.source_key
    article.append(node('h5', source.label))
    const ancestry = node('dl'); ancestry.className = 'csv-import-parents'
    for (const parent of source.parents) ancestry.append(node('dt', parent.kind === 'clients' ? 'Source client' : 'Source project'), node('dd', parent.label))
    article.append(ancestry)
    const selected = source.selected_destination
    article.append(node('p', selected ? `Reviewed destination: ${labelCandidate(selected)}` : source.state === 'new' ? 'New setup is proposed; review its name and destination policy.' : source.state === 'excluded' ? 'This source occurs only in explicitly excluded rows.' : 'An explicit destination or creation choice is needed.'))
    const creationValue = currentCreation(context.mapping(), source)
    if (!selected && source.state === 'new') {
      if (source.kind === 'people' && typeof creationValue === 'object' && creationValue !== null && typeof creationValue.firstName === 'string' && typeof creationValue.lastName === 'string') article.append(node('p', `Proposed inactive person: ${creationValue.firstName} ${creationValue.lastName}. No invitation or password.`))
      else if (source.kind !== 'people') article.append(node('p', `Proposed new destination: ${typeof creationValue === 'string' ? creationValue : source.label}.`))
    }
    if (source.ambiguous) article.append(node('p', 'The match is ambiguous or unavailable. No first match will be chosen.'))
    if (source.kind === 'tasks') article.append(node('p', 'New task names are shared for identical source task labels. Choose exact existing task records when projects need different destinations.'))
    const edit = node('button', 'Edit this mapping'); edit.type = 'button'; edit.dataset.csvMappingEdit = ''; edit.dataset.csvSourceExcluded = String(source.state === 'excluded'); edit.disabled = source.state === 'excluded'; article.append(edit)
    const form = node('form'); form.className = 'settings-form'; form.hidden = true
    const actionLabel = node('label', 'Mapping action'), action = node('select')
    for (const [value, text] of [['existing', 'Use an exact existing record'], ['create', source.kind === 'people' ? 'Create an inactive person' : 'Create named setup']] as const) {
      const option = node('option', text); option.value = value; action.append(option)
    }
    actionLabel.append(action); form.append(actionLabel)
    const existing = node('div'), candidates = node('select'), candidateLabel = node('label', 'Exact destination')
    candidateLabel.append(candidates); existing.append(candidateLabel)
    const load = node('button', 'Load destination choices'), next = node('button', 'Load more destination choices')
    load.type = next.type = 'button'; next.hidden = true; existing.append(load, next)
    const creation = node('div'), nameInput = node('input'), first = node('input'), last = node('input')
    for (const input of [nameInput, first, last]) { input.maxLength = 255; input.autocomplete = 'off' }
    if (source.kind === 'people') {
      const firstLabel = node('label', 'First name'), lastLabel = node('label', 'Last name')
      first.value = typeof creationValue === 'object' && creationValue !== null && typeof creationValue.firstName === 'string' ? creationValue.firstName : ''
      last.value = typeof creationValue === 'object' && creationValue !== null && typeof creationValue.lastName === 'string' ? creationValue.lastName : ''
      firstLabel.append(first); lastLabel.append(last); creation.append(firstLabel, lastLabel, node('p', 'The person remains inactive. No invitation, password or account activation is created.'))
    } else {
      const label = node('label', 'New destination name'); nameInput.value = typeof creationValue === 'string' ? creationValue : source.label; label.append(nameInput); creation.append(label)
      if (source.kind === 'clients') creation.append(node('p', `A new client uses organization currency ${context.preview.tallies.organization_currency}; no source rate or price is imported.`))
    }
    const result = node('p'); result.className = 'form-result'; result.setAttribute('role', 'status'); result.setAttribute('aria-live', 'polite')
    const save = node('button', 'Use this mapping'), cancel = node('button', 'Cancel mapping edit'); save.type = 'submit'; cancel.type = 'button'
    form.append(existing, creation, save, cancel, result); article.append(form)
    let candidateCursor: string | null = null, candidateBusy = false
    const candidatePages = new Set<string>(), values = new Map<number, DestinationCandidate>()
    if (selected) values.set(selected.id, selected)
    const fill = () => {
      const chosen = candidates.value || (selected ? String(selected.id) : '')
      const empty = node('option', 'Choose a destination…'); empty.value = ''
      candidates.replaceChildren(empty, ...[...values.values()].map(value => { const option = node('option', labelCandidate(value)); option.value = String(value.id); option.disabled = !value.selectable; return option }))
      if ([...candidates.options].some(option => option.value === chosen)) candidates.value = chosen
    }
    fill()
    const cardCurrent = () => current(context) && article.isConnected
    const loadCandidates = async (append: boolean) => {
      if (!cardCurrent() || !context.canEdit() || candidateBusy) return
      const requestCursor = append ? candidateCursor : null
      if (append && !requestCursor) return
      candidateBusy = true; setRequestBusy(result, true); load.disabled = next.disabled = true; result.textContent = 'Loading destination choices…'
      try {
        if (requestCursor && candidatePages.has(requestCursor)) throw new CsvUiError('The destination catalog repeated a page. Refresh the preview.')
        const page = (await api.listCsvImportCatalog({ runId: context.preview.run.id, query: { kind: source.kind, source_key: source.source_key, preview_id: context.preview.preview_id, per_page: 25, ...(requestCursor ? { cursor: requestCursor } : {}) }, signal: context.signal })).data
        if (!cardCurrent()) return
        if (page.preview_id !== context.preview.preview_id || page.items.some(item => !('id' in item))) throw new CsvUiError('The destination catalog changed. Refresh the preview.')
        if (!append) { values.clear(); candidatePages.clear(); if (selected) values.set(selected.id, selected) }
        for (const item of page.items) { const value = item as DestinationCandidate; values.set(value.id, value) }
        if (requestCursor) candidatePages.add(requestCursor)
        candidateCursor = page.next_cursor; fill(); next.hidden = candidateCursor === null
        result.textContent = `${values.size} destination choices loaded; ${page.total} available in this reviewed scope. Archived choices cannot be selected.`
      } catch (error) { if (cardCurrent()) { result.textContent = csvFailureMessage(error); context.failure(error) } }
      finally { if (cardCurrent()) { candidateBusy = false; setRequestBusy(result, false); load.disabled = next.disabled = !context.canEdit() } }
    }
    const paintAction = () => { existing.hidden = action.value !== 'existing'; creation.hidden = action.value !== 'create' }
    action.addEventListener('change', paintAction)
    edit.addEventListener('click', () => { if (!cardCurrent() || !context.canEdit() || source.state === 'excluded') return; form.hidden = false; edit.hidden = true; action.value = selected ? 'existing' : 'create'; paintAction(); action.focus() })
    cancel.addEventListener('click', () => { form.hidden = true; edit.hidden = false; edit.focus() })
    load.addEventListener('click', () => void loadCandidates(false)); next.addEventListener('click', () => void loadCandidates(true))
    form.addEventListener('submit', event => {
      event.preventDefault()
      if (!cardCurrent() || !context.canEdit() || candidateBusy || source.state === 'excluded') return
      try {
        const chosen = values.get(Number(candidates.value))
        const change = action.value === 'existing'
          ? chosen?.selectable ? { action: 'existing' as const, id: chosen.id } : null
          : source.kind === 'people' ? { action: 'person' as const, firstName: first.value, lastName: last.value } : { action: 'create' as const, name: nameInput.value }
        if (!change) throw new CsvUiError('Choose a selectable exact destination record.')
        context.edit(editMapping(context.mapping(), source, change))
        result.textContent = 'Mapping changed locally. Save the choices and review a fresh preview before applying.'
      } catch (error) { result.textContent = csvFailureMessage(error) }
    })
    return article
  }

  const load = async (append: boolean) => {
    const context = active, request = revision
    if (!context || !current(context, request) || busy) return
    const requestCursor = append ? cursor : null
    if (append && !requestCursor) return
    busy = true; setRequestBusy(status, true); more.disabled = true; status.textContent = 'Loading source mappings…'
    try {
      if (requestCursor && seen.has(requestCursor)) throw new CsvUiError('The source catalog repeated a page. Refresh the preview.')
      const page = (await api.listCsvImportCatalog({ runId: context.preview.run.id, query: { kind, preview_id: context.preview.preview_id, per_page: 25, ...(requestCursor ? { cursor: requestCursor } : {}) }, signal: context.signal })).data
      if (!current(context, request)) return
      if (page.preview_id !== context.preview.preview_id || page.items.some(item => !('source_key' in item))) throw new CsvUiError('The source catalog changed. Refresh the preview.')
      if (!append) { rows = []; seen = new Set() }
      if (requestCursor) seen.add(requestCursor)
      rows.push(...page.items as SourceEntity[]); total = page.total; cursor = page.next_cursor
      host.replaceChildren(...rows.map(source => card(source, context)))
      if (!rows.length) host.append(node('p', 'No source entities in this category.'))
      status.textContent = `${rows.length} of ${total} source entities shown. Parent identities remain separate.`
      more.hidden = cursor === null
    } catch (error) { if (current(context, request)) { status.textContent = csvFailureMessage(error); context.failure(error) } }
    finally { if (current(context, request)) { busy = false; setRequestBusy(status, false); more.disabled = locked } }
  }
  for (const button of buttons) button.addEventListener('click', () => {
    const chosen = button.dataset.csvKind
    if (!active || !kinds.includes(chosen as EntityKind) || button.disabled) return
    kind = chosen as EntityKind; revision++; busy = false; rows = []; cursor = null; seen.clear(); host.replaceChildren(); more.hidden = true
    for (const item of buttons) item.setAttribute('aria-pressed', String(item === button))
    void load(false)
  })
  more.addEventListener('click', () => void load(true))
  return {
    async activate(context: CatalogContext) { active = context; revision++; busy = false; rows = []; cursor = null; seen.clear(); await load(false) },
    dirty(value: boolean) {
      locked = value; for (const button of buttons) button.disabled = value; more.disabled = value
      for (const button of host.querySelectorAll<HTMLButtonElement>('[data-csv-mapping-edit]')) button.disabled = button.dataset.csvSourceExcluded === 'true' || !active?.canEdit()
    },
    clear() { active = null; revision++; busy = false; rows = []; cursor = null; seen.clear(); host.replaceChildren(); status.textContent = ''; setRequestBusy(status, false); more.hidden = true },
  }
}
