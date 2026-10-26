/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderGithubReaderSettings } from '../src/module-settings/github-reader-render.js'
import { createGithubReaderController, type GithubReaderUiApi } from '../src/module-settings/github-reader.js'
import { sessionPresenter } from '../src/session.js'
import type { GithubReaderStatusEnvelope } from '@conflict-hq/ezacto-client'

const status = (): GithubReaderStatusEnvelope['data'] => ({
  configured: true, setup_supported: true, available: true, owned_acceptance_required: true,
  app: { id: '9', slug: 'fixture-reader', installation_url: 'https://github.com/apps/fixture-reader/installations/new' },
  connections: [{ id: '1:9:55', generation: 2, installation_id: '55', state: 'active', deferred_until: null, failure_codes: [], resources: [{ repository_id: '77', full_name: 'acme/work', project_id: 10, task_id: 100, state: 'active', checkpoint_status: 'complete', attempts: 0, next_retry_at: 0, failure_code: null, items_visible: 8, items_unavailable: 0 }] }],
})
const api = () => ({
  getGithubReaderStatus: vi.fn<GithubReaderUiApi['getGithubReaderStatus']>(async () => ({ data: status() })),
  beginGithubAppSetup: vi.fn<GithubReaderUiApi['beginGithubAppSetup']>(async () => ({ data: { registration_url: 'https://github.com/organizations/acme/settings/apps/new?state=fixture', manifest: JSON.stringify({ name: 'Reader', public: false, default_permissions: { issues: 'read', metadata: 'read' } }) } })),
  listGithubReaderInstallations: vi.fn<GithubReaderUiApi['listGithubReaderInstallations']>(async () => ({ data: { items: [{ id: '55', account: 'Acme', repository_selection: 'selected' }], next_page: null } })),
  listGithubReaderRepositories: vi.fn<GithubReaderUiApi['listGithubReaderRepositories']>(async () => ({ data: { items: [{ id: '77', full_name: 'acme/work' }], next_page: null } })),
  mapGithubRepository: vi.fn<GithubReaderUiApi['mapGithubRepository']>(async () => ({ data: { connection_id: '1:9:55', generation: 3 } })),
  disconnectGithubReader: vi.fn<GithubReaderUiApi['disconnectGithubReader']>(async () => ({ data: { generation: 3 } })),
  reconcileGithubReader: vi.fn<GithubReaderUiApi['reconcileGithubReader']>(async () => {}),
  catalog: vi.fn<GithubReaderUiApi['catalog']>(async () => ({ projects: [{ id: 10, name: 'Website' }, { id: 20, name: 'Mobile' }], tasks: [{ id: 100, name: 'Development' }, { id: 200, name: 'Design' }], assignments: [{ project_id: 10, task_id: 100 }, { project_id: 20, task_id: 200 }] })),
}) satisfies GithubReaderUiApi
const session = (profile = 'administrator') => {
  const abort = new AbortController()
  return { abort, active: { identity: { profile }, signal: abort.signal, ...sessionPresenter(() => !abort.signal.aborted, () => false) } }
}
const el = <T extends Element>(name: string) => document.querySelector<T>(`[data-github-reader-${name}]`)!
const field = (name: string) => el<HTMLFormElement>('mapping').elements.namedItem(name) as HTMLSelectElement
const choose = (name: string, value: string) => { field(name).value = value; field(name).dispatchEvent(new Event('change', { bubbles: true })) }
const submit = (name: string) => el<HTMLFormElement>(name).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
beforeEach(() => { document.body.innerHTML = renderGithubReaderSettings(); window.history.replaceState({}, '', '/settings/company#work-items') })

describe('GitHub reader settings', () => {
  it('offers named repositories and only tasks assigned to the chosen project, and sends a durable mapping command', async () => {
    const mock = api(), { active } = session(), controller = createGithubReaderController(mock)
    await controller.load(active)
    expect(el('connections').textContent).toContain('acme/work → Website / Development')
    choose('installation', '55')
    await vi.waitFor(() => expect(field('repository').disabled).toBe(false))
    choose('repository', '77'); choose('project', '10')
    expect([...field('task').options].map(item => item.textContent)).toEqual(['Choose a task', 'Development'])
    choose('task', '100'); submit('mapping')
    await vi.waitFor(() => expect(mock.mapGithubRepository).toHaveBeenCalledOnce())
    expect(mock.mapGithubRepository.mock.calls[0]![0].body).toMatchObject({ expected_generation: 2, installation_id: '55', repository_id: '77', project_id: 10, task_id: 100 })
    expect(mock.mapGithubRepository.mock.calls[0]![0].body.command_id).toMatch(/^[\da-f-]{36}$/)
    await vi.waitFor(() => expect(el('status').textContent).toContain('Repository mapped'))
  })
  it('retries the exact mapping command after an unknown outcome and disables controls while waiting', async () => {
    const mock = api(), { active } = session()
    mock.mapGithubRepository.mockRejectedValueOnce(new Error('Network ended'))
    await createGithubReaderController(mock).load(active)
    choose('installation', '55'); await vi.waitFor(() => expect(field('repository').disabled).toBe(false))
    choose('repository', '77'); choose('project', '10'); choose('task', '100'); submit('mapping')
    expect(el('status').getAttribute('aria-busy')).toBe('true')
    expect(field('project').disabled).toBe(true)
    await vi.waitFor(() => expect(el('status').getAttribute('aria-busy')).toBe('false'))
    submit('mapping'); await vi.waitFor(() => expect(mock.mapGithubRepository).toHaveBeenCalledTimes(2))
    expect(mock.mapGithubRepository.mock.calls[0]![0].body).toEqual(mock.mapGithubRepository.mock.calls[1]![0].body)
  })
  it('requires an explicit permission review before submitting the prepared App manifest to GitHub', async () => {
    const mock = api(), { active } = session()
    mock.getGithubReaderStatus.mockResolvedValue({ data: { ...status(), configured: false, available: false, app: null, connections: [] } })
    await createGithubReaderController(mock).load(active)
    expect(mock.beginGithubAppSetup).not.toHaveBeenCalled()
    expect(el<HTMLElement>('setup').hidden).toBe(false)
    submit('setup')
    await vi.waitFor(() => expect(el<HTMLElement>('manifest-review').hidden).toBe(false))
    expect(el('manifest').textContent).toContain('"issues": "read"')
    expect(el<HTMLButtonElement>('manifest-submit').disabled).toBe(true)
    expect(submit('manifest-form')).toBe(false)
    el<HTMLInputElement>('manifest-reviewed').checked = true
    el('manifest-reviewed').dispatchEvent(new Event('change'))
    expect(el<HTMLButtonElement>('manifest-submit').disabled).toBe(false)
    expect(el<HTMLFormElement>('manifest-form').action).toBe('https://github.com/organizations/acme/settings/apps/new?state=fixture')
    el('setup').dispatchEvent(new Event('input'))
    expect(el<HTMLElement>('manifest-review').hidden).toBe(true)
    expect(el<HTMLButtonElement>('manifest-submit').disabled).toBe(true)
  })
  it('never submits a manifest to an untrusted destination', async () => {
    const mock = api(), { active } = session()
    mock.getGithubReaderStatus.mockResolvedValue({ data: { ...status(), configured: false, available: false, app: null, connections: [] } })
    mock.beginGithubAppSetup.mockResolvedValue({ data: { registration_url: 'https://example.test/steal', manifest: '{}' } })
    await createGithubReaderController(mock).load(active)
    submit('setup')
    await vi.waitFor(() => expect(el('status').textContent).toContain('could not be reached'))
    expect(el<HTMLElement>('manifest-review').hidden).toBe(true)
    expect(el<HTMLFormElement>('manifest-form').hasAttribute('action')).toBe(false)
  })
  it('tells the administrator to inspect GitHub after a failed callback without creating a new App', async () => {
    window.history.replaceState({}, '', '/settings/company?github_setup=failed#work-items')
    const mock = api(), { active } = session()
    await createGithubReaderController(mock).load(active)
    expect(el('setup-return').textContent).toContain('App may already exist')
    expect(mock.beginGithubAppSetup).not.toHaveBeenCalled()
  })
  it('keeps private results out of a later or revoked session', async () => {
    const mock = api(), { active, abort } = session()
    let resolve!: (value: GithubReaderStatusEnvelope) => void
    mock.getGithubReaderStatus.mockImplementationOnce(() => new Promise(finish => { resolve = finish }))
    const controller = createGithubReaderController(mock), pending = controller.load(active)
    abort.abort(); controller.clear(); resolve({ data: status() }); await pending
    expect(el('connections').textContent).toBe('')
    expect(el<HTMLElement>('content').hidden).toBe(true)
    expect(mock.listGithubReaderInstallations).not.toHaveBeenCalled()
  })
  it('does not request administrator connection data for another role', async () => {
    const mock = api()
    await createGithubReaderController(mock).load(session('executive_manager').active)
    expect(mock.getGithubReaderStatus).not.toHaveBeenCalled()
    expect(el('status').textContent).toContain('Only administrators')
  })
  it('loads more installations without losing the current selection', async () => {
    const mock = api(), { active } = session()
    mock.listGithubReaderInstallations.mockResolvedValueOnce({ data: { items: [{ id: '55', account: 'Acme', repository_selection: 'selected' }], next_page: 2 } }).mockResolvedValueOnce({ data: { items: [{ id: '56', account: 'Other', repository_selection: 'all' }], next_page: null } })
    await createGithubReaderController(mock).load(active)
    choose('installation', '55'); await vi.waitFor(() => expect(field('repository').disabled).toBe(false))
    el<HTMLButtonElement>('more-installations').click()
    await vi.waitFor(() => expect(field('installation').options.length).toBe(3))
    expect(field('installation').value).toBe('55')
    expect(mock.listGithubReaderInstallations.mock.calls[1]![0]?.query?.page).toBe(2)
  })
})
