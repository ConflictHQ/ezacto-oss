/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createGithubPublicationController, type GithubPublicationUiApi } from '../src/module-settings/github-publication.js'
import { renderGithubPublicationSettings } from '../src/module-settings/github-publication-render.js'
import { sessionPresenter } from '../src/session.js'
import type { GithubPublicationsEnvelope, GithubReaderStatusEnvelope } from '@conflict-hq/ezacto-client'

const reader: GithubReaderStatusEnvelope['data'] = {
  publication_enabled: true, configured: true, setup_supported: true, available: true, owned_acceptance_required: true,
  app: null,
  connections: [{ id: 'connection', generation: 1, installation_id: '55', state: 'active', deferred_until: null, failure_codes: [], resources: [{ repository_id: '77', full_name: 'owned/project', project_id: 10, task_id: 100, state: 'active', checkpoint_status: 'complete', attempts: 0, next_retry_at: 0, failure_code: null, items_visible: 1, items_unavailable: 0 }] }],
}
const initial = (): GithubPublicationsEnvelope['data'] => ({ policies: [{ connection_id: 'connection', enabled: true, generation: 3 }], publications: [], candidates: [{ link_id: 12, entry_id: 45 }] })
const api = () => ({
  getGithubPublications: vi.fn<GithubPublicationUiApi['getGithubPublications']>(async () => ({ data: initial() })),
  getGithubReaderStatus: vi.fn<GithubPublicationUiApi['getGithubReaderStatus']>(async () => ({ data: reader })),
  previewGithubPublication: vi.fn<GithubPublicationUiApi['previewGithubPublication']>(async () => ({ data: { link_id: 12, connection_id: 'connection', destination: 'owned/project#9', spent_date: '2026-09-17', seconds: 3661, source_version: 'source-hash', policy_enabled: true } })),
  setGithubPublicationPolicy: vi.fn<GithubPublicationUiApi['setGithubPublicationPolicy']>(async () => {}),
  consentGithubPublication: vi.fn<GithubPublicationUiApi['consentGithubPublication']>(async () => {}),
  actGithubPublication: vi.fn<GithubPublicationUiApi['actGithubPublication']>(async () => {}),
}) satisfies GithubPublicationUiApi
const session = (profile = 'administrator') => {
  const abort = new AbortController()
  return { abort, active: { identity: { profile }, signal: abort.signal, ...sessionPresenter(() => !abort.signal.aborted, () => false) } }
}
const el = <T extends Element>(name: string) => document.querySelector<T>(`[data-gh-pub-${name}]`)!
const submit = (form: Element) => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
const preview = async () => {
  el<HTMLSelectElement>('candidate').value = '12'
  submit(el('preview-form'))
  await vi.waitFor(() => expect(el<HTMLElement>('preview').hidden).toBe(false))
}
beforeEach(() => { document.body.innerHTML = renderGithubPublicationSettings() })
describe('GitHub publication settings', () => {
  it('requires the destination/date/duration preview and explicit consent before writing', async () => {
    const mock = api(); await createGithubPublicationController(mock).load(session().active)
    expect(mock.consentGithubPublication).not.toHaveBeenCalled()
    await preview()
    expect(el('preview-text').textContent).toContain('owned/project#9 · 2026-09-17 · 1h 1m 1s')
    expect(el<HTMLButtonElement>('publish').disabled).toBe(true)
    el<HTMLInputElement>('consent').checked = true; el('consent').dispatchEvent(new Event('change'))
    el<HTMLButtonElement>('publish').click()
    await vi.waitFor(() => expect(mock.consentGithubPublication).toHaveBeenCalledOnce())
    expect(mock.consentGithubPublication.mock.calls[0]![0].body).toEqual({ link_id: 12, source_version: 'source-hash', command_id: expect.any(String) })
    await vi.waitFor(() => expect(el('status').textContent).toContain('Consent recorded'))
  })
  it('disables duplicate submits, shows progress and reuses the command after an unknown response', async () => {
    const mock = api(); let reject!: (error: Error) => void
    mock.consentGithubPublication.mockImplementationOnce(() => new Promise((_, no) => { reject = no }))
    await createGithubPublicationController(mock).load(session().active); await preview()
    el<HTMLInputElement>('consent').checked = true; el('consent').dispatchEvent(new Event('change'))
    el<HTMLButtonElement>('publish').click(); el<HTMLButtonElement>('publish').click()
    expect(el('status').getAttribute('aria-busy')).toBe('true')
    expect(mock.consentGithubPublication).toHaveBeenCalledOnce()
    reject(new Error('Response lost'))
    await vi.waitFor(() => expect(el('status').getAttribute('aria-busy')).toBe('false'))
    el<HTMLButtonElement>('publish').click()
    await vi.waitFor(() => expect(mock.consentGithubPublication).toHaveBeenCalledTimes(2))
    expect(mock.consentGithubPublication.mock.calls[1]![0].body).toEqual(mock.consentGithubPublication.mock.calls[0]![0].body)
  })
  it('requires permission review before enabling an off connection', async () => {
    const mock = api(); mock.getGithubPublications.mockResolvedValue({ data: { ...initial(), policies: [] } })
    await createGithubPublicationController(mock).load(session().active)
    const form = el('policies').querySelector('form')!, checkbox = form.querySelector<HTMLInputElement>('input')!, button = form.querySelector<HTMLButtonElement>('button')!
    expect(button.disabled).toBe(true); submit(form); expect(mock.setGithubPublicationPolicy).not.toHaveBeenCalled()
    checkbox.checked = true; checkbox.dispatchEvent(new Event('change')); submit(form)
    await vi.waitFor(() => expect(mock.setGithubPublicationPolicy).toHaveBeenCalledOnce())
    expect(mock.setGithubPublicationPolicy.mock.calls[0]![0].body).toMatchObject({ connection_id: 'connection', expected_generation: 0, enabled: true, confirm_permission: true })
  })
  it('defaults conflict resolution to unlink and explicitly warns before restoration', async () => {
    const mock = api(); mock.getGithubPublications.mockResolvedValue({ data: { ...initial(), publications: [{ id: 4, connection_id: 'connection', entry_id: 45, destination: 'owned/project#9', spent_date: '2026-09-17', seconds: 3661, status: 'conflicted', source_version: 5, version: 5, remote_id: '99', failure_code: null, next_retry_at: null }] } })
    await createGithubPublicationController(mock).load(session().active)
    const form = el('rows').querySelector('form')!, choice = form.querySelector<HTMLSelectElement>('select')!, checkbox = form.querySelector<HTMLInputElement>('input')!
    expect(choice.value).toBe('unlink'); submit(form); expect(mock.actGithubPublication).not.toHaveBeenCalled()
    choice.value = 'restore'; choice.dispatchEvent(new Event('change'))
    expect(form.textContent).toContain('overwrites the edited comment, or creates it again')
    checkbox.checked = true; checkbox.dispatchEvent(new Event('change')); submit(form)
    await vi.waitFor(() => expect(mock.actGithubPublication).toHaveBeenCalledOnce())
    expect(mock.actGithubPublication.mock.calls[0]![0]).toMatchObject({ id: 4, body: { expected_version: 5, action: 'restore', confirm: true } })
  })
  it('keeps previous-instance receipts for review and offers only explicit unlink', async () => {
    const mock = api(); mock.getGithubPublications.mockResolvedValue({ data: { ...initial(), publications: [{ id: 4, connection_id: 'connection', entry_id: 45, destination: 'owned/project#9', spent_date: '2026-09-17', seconds: 3661, status: 'prior_instance', source_version: 5, version: 5, remote_id: '99', failure_code: null, next_retry_at: null }] } })
    await createGithubPublicationController(mock).load(session().active)
    expect(el('rows').textContent).toContain('Previous instance — review required')
    expect(el('rows').textContent).toContain('a later consent can create another note')
    const select = el('rows').querySelector<HTMLSelectElement>('select')!
    expect([...select.options].map(item => item.value)).toEqual(['unlink'])
    expect(mock.actGithubPublication).not.toHaveBeenCalled()
  })
  it('discards private previews after logout and ignores stale responses', async () => {
    const mock = api(); let finish!: (value: Awaited<ReturnType<GithubPublicationUiApi['previewGithubPublication']>>) => void
    mock.previewGithubPublication.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const { active, abort } = session(); await createGithubPublicationController(mock).load(active)
    el<HTMLSelectElement>('candidate').value = '12'; submit(el('preview-form')); abort.abort()
    finish({ data: { link_id: 12, connection_id: 'connection', destination: 'private/project#8', spent_date: '2026-09-17', seconds: 60, source_version: 'old', policy_enabled: true } })
    await vi.waitFor(() => expect(el('status').getAttribute('aria-busy')).toBe('false'))
    expect(el<HTMLElement>('content').hidden).toBe(true); expect(document.body.textContent).not.toContain('private/project')
  })
  it.each([false, undefined])('does not request publication data unless the deployment explicitly enables it (%s)', async enabled => {
    const mock = api()
    const { publication_enabled: ignored, ...oldReader } = reader
    void ignored
    mock.getGithubReaderStatus.mockResolvedValue({ data: { ...oldReader, ...(enabled === undefined ? {} : { publication_enabled: enabled }) } })
    await createGithubPublicationController(mock).load(session().active)
    expect(mock.getGithubPublications).not.toHaveBeenCalled()
    expect(el<HTMLElement>('content').hidden).toBe(true)
    expect(el('status').textContent).toContain('not enabled for this deployment')
  })
  it('does not call the admin endpoints for members', async () => {
    const mock = api(); await createGithubPublicationController(mock).load(session('member').active)
    expect(mock.getGithubPublications).not.toHaveBeenCalled(); expect(el<HTMLElement>('content').hidden).toBe(true)
  })
})
