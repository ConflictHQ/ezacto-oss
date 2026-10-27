import { EzactoApiError, type EzactoClient, type GithubPublicationsEnvelope, type GithubPublicationPreviewEnvelope } from '@conflict-hq/ezacto-client'
import type { SessionPresenter } from '../session.js'
import { isDemoDeployment } from '../demo.js'
import { setRequestBusy } from '../request-feedback.js'

export type GithubPublicationUiApi = Pick<EzactoClient, 'getGithubPublications' | 'getGithubReaderStatus' | 'previewGithubPublication' | 'setGithubPublicationPolicy' | 'consentGithubPublication' | 'actGithubPublication'>
interface Active extends SessionPresenter { signal: AbortSignal; identity: { profile: string } }
type Data = GithubPublicationsEnvelope['data']
type Preview = GithubPublicationPreviewEnvelope['data']
const statusLabels: Record<string, string> = { pending: 'Queued', attempted: 'Confirming GitHub response', published: 'Published', ambiguous: 'Needs review', conflicted: 'Comment changed in GitHub', deferred: 'Waiting for GitHub', retired: 'Removed', failed: 'Needs attention', adopted: 'GitHub edit accepted', unlinked: 'Unlinked' }
const statusLabel = (value: string): string => Object.hasOwn(statusLabels, value) ? statusLabels[value]! : 'Needs review'
const duration = (seconds: number) => `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m ${seconds % 60}s`
const option = (value: string, text: string) => { const el = document.createElement('option'); el.value = value; el.textContent = text; return el }
const message = (error: unknown) => {
  if (error instanceof EzactoApiError) {
    const body = error.body as { error?: { message?: string } } | null
    return body?.error?.message ?? 'The request could not be completed. Refresh status before trying again.'
  }
  return 'The response was not confirmed. Refresh status or retry the same action.'
}
export const createGithubPublicationController = (api: GithubPublicationUiApi | undefined) => {
  const root = document.querySelector<HTMLElement>('[data-github-publications]')
  if (!root) return { clear() {}, async load() {} }
  const find = <T extends Element>(name: string) => root.querySelector<T>(`[data-gh-pub-${name}]`)!
  const status = find<HTMLElement>('status'), content = find<HTMLElement>('content')
  const policies = find<HTMLElement>('policies'), rows = find<HTMLElement>('rows')
  const candidate = find<HTMLSelectElement>('candidate'), previewPanel = find<HTMLElement>('preview')
  const previewText = find<HTMLElement>('preview-text'), consent = find<HTMLInputElement>('consent')
  const publish = find<HTMLButtonElement>('publish')
  let active: Active | null = null, revision = 0, busy = false, preview: Preview | null = null
  let data: Data | null = null
  const commands = new Map<string, string>()
  const command = (key: string) => { const id = commands.get(key) ?? crypto.randomUUID(); commands.set(key, id); return id }
  const current = (owner: Active, version: number) => active === owner && revision === version && !owner.signal.aborted
  const controls = () => {
    setRequestBusy(status, busy)
    for (const el of root.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement>('button,input,select')) el.disabled = busy || !active
    publish.disabled = busy || !active || !preview?.policy_enabled || !consent.checked
    for (const enable of root.querySelectorAll<HTMLButtonElement>('[data-gh-pub-enable]')) {
      const check = enable.closest('form')?.querySelector<HTMLInputElement>('input[type="checkbox"]')
      enable.disabled = busy || !active || !check?.checked
    }
    for (const apply of root.querySelectorAll<HTMLButtonElement>('[data-gh-pub-apply]')) {
      const check = apply.closest('form')?.querySelector<HTMLInputElement>('input[type="checkbox"]')
      apply.disabled = busy || !active || !check?.checked
    }
  }
  const clearPreview = () => { preview = null; previewPanel.hidden = true; previewText.textContent = ''; consent.checked = false }
  const clear = () => {
    revision++; active = null; busy = false; data = null; commands.clear(); clearPreview()
    content.hidden = true; policies.replaceChildren(); rows.replaceChildren(); candidate.replaceChildren(option('', 'Choose a linked time entry')); status.textContent = ''; controls()
  }
  const run = async (text: string, action: (owner: Active, version: number) => Promise<void>) => {
    const owner = active, version = revision
    if (!owner || busy || !api || owner.signal.aborted) return
    busy = true; status.textContent = text; controls()
    try { await action(owner, version) }
    catch (error) { if (current(owner, version)) owner.presentFailure(error, () => { status.textContent = message(error) }) }
    finally { if (current(owner, version)) { busy = false; controls() } }
  }
  const refresh = async (owner: Active, version: number) => {
    const [result, reader] = await Promise.all([api!.getGithubPublications({ signal: owner.signal }), api!.getGithubReaderStatus({ signal: owner.signal })])
    if (!current(owner, version)) return
    data = result.data; clearPreview(); policies.replaceChildren(); rows.replaceChildren()
    candidate.replaceChildren(option('', 'Choose a linked time entry'))
    for (const row of data.candidates) candidate.appendChild(option(String(row.link_id), `Time entry ${row.entry_id}`))
    for (const connection of reader.data.connections.filter(row => row.state === 'active')) {
      const policy = data.policies.find(row => row.connection_id === connection.id)
      const enabled = policy?.enabled ?? false
      const form = document.createElement('form'); form.className = 'settings-form'
      const title = document.createElement('h4'); title.textContent = connection.resources.map(row => row.full_name ?? `Repository ${row.repository_id}`).join(', ') || `Installation ${connection.installation_id}`
      const state = document.createElement('p'); state.textContent = enabled ? 'Time-note publication enabled. Each entry still needs individual consent.' : 'Time-note publication disabled.'
      const label = document.createElement('label'); label.className = 'settings-toggle'
      const reviewed = document.createElement('input'); reviewed.type = 'checkbox'
      label.append(reviewed, document.createTextNode(' I reviewed the selected repositories and granted the GitHub App Issues read and write permission.'))
      const button = document.createElement('button'); button.type = 'submit'; button.textContent = enabled ? 'Disable publication' : 'Enable publication'
      if (!enabled) { button.setAttribute('data-gh-pub-enable', ''); form.append(title, state, label, button) } else form.append(title, state, button)
      reviewed.addEventListener('change', controls)
      form.addEventListener('submit', event => {
        event.preventDefault(); if (!enabled && !reviewed.checked) return
        void run(enabled ? 'Disabling publication…' : 'Checking permission and enabling publication…', async (owner, version) => {
          const key = `policy:${connection.id}:${policy?.generation ?? 0}:${!enabled}`
          await api!.setGithubPublicationPolicy({ body: { connection_id: connection.id, expected_generation: policy?.generation ?? 0, enabled: !enabled, confirm_permission: !enabled && reviewed.checked, command_id: command(key) }, signal: owner.signal })
          if (!current(owner, version)) return
          await refresh(owner, version); if (current(owner, version)) commands.delete(key)
          if (current(owner, version)) status.textContent = enabled ? 'Publication disabled.' : 'Permission verified. Preview a time entry to allow its publication.'
        })
      }); policies.appendChild(form)
    }
    if (!policies.children.length) { const p = document.createElement('p'); p.textContent = 'Connect and map a GitHub repository above before enabling time-note publication.'; policies.appendChild(p) }
    for (const row of data.publications) {
      const card = document.createElement('article'), heading = document.createElement('h4'), detail = document.createElement('p')
      heading.textContent = `${row.destination} · time entry ${row.entry_id}`
      detail.textContent = `${statusLabel(row.status)}${row.spent_date ? ` · ${row.spent_date}` : ''}${row.seconds !== null ? ` · ${duration(row.seconds)}` : ''}${row.failure_code ? ' · Review this publication before retrying.' : ''}${row.next_retry_at ? ` · retry after ${new Date(row.next_retry_at).toLocaleString()}` : ''}`
      card.append(heading, detail)
      if (row.status !== 'unlinked') {
        const form = document.createElement('form'); form.className = 'settings-form'
        const label = document.createElement('label'); label.textContent = 'Resolve publication'
        const select = document.createElement('select'); select.append(option('unlink', 'Unlink — keep the GitHub comment'))
        select.append(option('retry', 'Retry checking this publication'))
        if (row.status === 'conflicted') select.append(option('adopt', 'Adopt the edited GitHub comment'), option('restore', 'Restore the eZacto comment'))
        label.appendChild(select)
        const explanation = document.createElement('p')
        const explain = () => { explanation.textContent = select.value === 'restore' ? 'Restore overwrites the edited comment, or creates it again if it was deleted.' : select.value === 'adopt' ? 'Adopt preserves the GitHub edit until this time entry changes again.' : select.value === 'unlink' ? 'Unlink stops synchronization and leaves the GitHub comment in place.' : 'Retry checks the existing publication before any new comment can be created.'; reviewed.checked = false; controls() }
        const confirmLabel = document.createElement('label'); confirmLabel.className = 'settings-toggle'
        const reviewed = document.createElement('input'); reviewed.type = 'checkbox'; confirmLabel.append(reviewed, document.createTextNode(' I reviewed this action and confirm.'))
        const button = document.createElement('button'); button.type = 'submit'; button.textContent = 'Apply action'; button.setAttribute('data-gh-pub-apply', '')
        form.append(label, explanation, confirmLabel, button); card.appendChild(form)
        select.addEventListener('change', explain); reviewed.addEventListener('change', controls); explain()
        form.addEventListener('submit', event => {
          event.preventDefault(); if (!reviewed.checked) return
          const action = select.value as 'retry' | 'adopt' | 'restore' | 'unlink'
          void run('Applying publication action…', async (owner, version) => {
            const key = `action:${row.id}:${row.version}:${action}`
            await api!.actGithubPublication({ id: row.id, body: { expected_version: row.version, action, confirm: true, command_id: command(key) }, signal: owner.signal })
            if (!current(owner, version)) return
            await refresh(owner, version); if (current(owner, version)) commands.delete(key)
            if (current(owner, version)) status.textContent = 'Action recorded. Refresh status to follow synchronization.'
          })
        })
      }
      rows.appendChild(card)
    }
    content.hidden = false; controls()
  }
  find<HTMLFormElement>('preview-form').addEventListener('submit', event => {
    event.preventDefault(); const id = Number(candidate.value); if (!id) return
    clearPreview()
    void run('Loading the comment preview…', async (owner, version) => {
      const result = await api!.previewGithubPublication({ id, signal: owner.signal })
      if (!current(owner, version)) return
      preview = result.data; previewText.textContent = `${preview.destination} · ${preview.spent_date} · ${duration(preview.seconds)}.${preview.policy_enabled ? '' : ' Enable publication for this connection first.'}`
      previewPanel.hidden = false
    })
  })
  candidate.addEventListener('change', () => { clearPreview(); controls() })
  consent.addEventListener('change', controls)
  publish.addEventListener('click', () => {
    const selected = preview; if (!selected || !selected.policy_enabled || !consent.checked) return
    void run('Recording consent for this time note…', async (owner, version) => {
      const key = `consent:${selected.link_id}:${selected.source_version}`
      await api!.consentGithubPublication({ body: { link_id: selected.link_id, source_version: selected.source_version, command_id: command(key) }, signal: owner.signal })
      if (!current(owner, version)) return
      await refresh(owner, version); if (current(owner, version)) commands.delete(key)
      if (current(owner, version)) status.textContent = 'Consent recorded. The time note is queued; refresh status to follow publication.'
    })
  })
  find('refresh').addEventListener('click', () => { void run('Refreshing publication status…', async (owner, version) => { await refresh(owner, version); if (current(owner, version)) status.textContent = 'Publication status refreshed.' }) })
  return { clear, async load(owner: Active) {
    clear(); active = owner
    owner.signal.addEventListener('abort', () => { if (active === owner) clear() }, { once: true })
    if (owner.signal.aborted) { clear(); return }
    if (owner.identity.profile !== 'administrator') { clear(); status.textContent = 'Only administrators can manage time-note publication.'; return }
    if (!api || isDemoDeployment()) { clear(); status.textContent = 'Time-note publication is unavailable on this instance.'; return }
    await run('Loading publication status…', async (session, version) => { await refresh(session, version); if (current(session, version)) status.textContent = 'Review connection permissions and individual time entries before publishing.' })
  } }
}
