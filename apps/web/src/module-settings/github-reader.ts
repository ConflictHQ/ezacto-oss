import { EzactoApiError, type EzactoClient, type GithubReaderStatusEnvelope, type GithubReaderMapRequest, type GithubReaderDisconnectRequest } from '@conflict-hq/ezacto-client'
import type { SessionPresenter } from '../session.js'
import { isDemoDeployment } from '../demo.js'
import { setRequestBusy } from '../request-feedback.js'

type Choice = { id: number; name: string }
type SelectControl = HTMLElement & { value: string; disabled: boolean; options: HTMLOptionsCollection }
export interface GithubReaderCatalog {
  projects: Choice[]
  tasks: Choice[]
  assignments: { project_id: number; task_id: number }[]
}
export type GithubReaderUiApi = Pick<EzactoClient, 'getGithubReaderStatus' | 'beginGithubAppSetup' | 'listGithubReaderInstallations' | 'listGithubReaderRepositories' | 'mapGithubRepository' | 'disconnectGithubReader' | 'reconcileGithubReader'> & {
  catalog(signal?: AbortSignal): Promise<GithubReaderCatalog>
}
interface Active extends SessionPresenter { signal: AbortSignal; identity: { profile: string } }
type ReaderStatus = GithubReaderStatusEnvelope['data']
const note = (error: unknown): string => {
  if (error instanceof EzactoApiError) {
    const message = (error.body as { error?: { message?: string } } | null)?.error?.message
    return `${message ?? 'GitHub could not be reached. Refresh its status and try again.'}${error.requestId ? ` Reference: ${error.requestId}` : ''}`
  }
  return 'GitHub could not be reached. Refresh its status and try again.'
}
const option = (value: string, label: string) => {
  const node = document.createElement('option'); node.value = value; node.textContent = label; return node
}
const githubUrl = (value: string, registration: boolean): string => {
  const url = new URL(value)
  if (url.origin !== 'https://github.com' || url.username || url.password ||
      !(registration ? /^\/(?:organizations\/[A-Za-z0-9-]+\/)?settings\/apps\/new$/.test(url.pathname) : /^\/apps\/[A-Za-z0-9-]+\/installations\/new$/.test(url.pathname)))
    throw new Error('Invalid GitHub destination')
  return url.href
}

export const createGithubReaderController = (api: GithubReaderUiApi | undefined) => {
  const root = document.querySelector<HTMLElement>('[data-settings-section="work-items"]')
  if (!root) return { clear() {}, async load() {} }
  const find = <T extends Element>(name: string) => root.querySelector<T>(`[data-github-reader-${name}]`)!
  const status = find<HTMLElement>('status'), content = find<HTMLElement>('content')
  const mapping = find<HTMLFormElement>('mapping'), setup = find<HTMLFormElement>('setup')
  const manifestReview = find<HTMLElement>('manifest-review'), manifestForm = find<HTMLFormElement>('manifest-form')
  const reviewed = find<HTMLInputElement>('manifest-reviewed'), manifestSubmit = find<HTMLButtonElement>('manifest-submit')
  const install = find<HTMLAnchorElement>('install'), connections = find<HTMLElement>('connections')
  const sync = find<HTMLButtonElement>('sync'), refresh = find<HTMLButtonElement>('refresh')
  const moreInstallations = find<HTMLButtonElement>('more-installations'), moreRepositories = find<HTMLButtonElement>('more-repositories')
  const field = (name: string) => mapping.querySelector<SelectControl>(`select[name="${name}"]`)!
  let active: Active | null = null, busy = false, revision = 0
  let state: ReaderStatus | null = null, catalog: GithubReaderCatalog = { projects: [], tasks: [], assignments: [] }
  let installations: { id: string; account: string; repository_selection: 'all' | 'selected' }[] = []
  let repositories: { id: string; full_name: string }[] = []
  let nextInstallations: number | null = null, nextRepositories: number | null = null
  let pendingMap: GithubReaderMapRequest | null = null
  const pendingDisconnects = new Map<string, GithubReaderDisconnectRequest>()
  const current = (owner: Active, generation = revision) => active === owner && !owner.signal.aborted && generation === revision
  const controls = () => {
    setRequestBusy(status, busy)
    for (const node of root.querySelectorAll<HTMLElement & { disabled: boolean }>('input,button,select')) {
      if (!node.closest('[data-github-publications]')) node.disabled = busy || active === null
    }
    field('repository').disabled = busy || repositories.length === 0
    field('task').disabled = busy || !field('project').value || field('task').options.length < 2
    manifestSubmit.disabled = busy || !reviewed.checked || manifestReview.hidden || active === null
    moreInstallations.hidden = nextInstallations === null
    moreRepositories.hidden = nextRepositories === null
  }
  const clear = () => {
    revision++; active = null; busy = false; state = null
    catalog = { projects: [], tasks: [], assignments: [] }; installations = []; repositories = []
    nextInstallations = nextRepositories = null; pendingMap = null; pendingDisconnects.clear()
    content.hidden = true; mapping.hidden = true; setup.hidden = true; sync.hidden = true; install.hidden = true
    install.removeAttribute('href'); connections.replaceChildren(); status.textContent = ''
    manifestReview.hidden = true; find<HTMLElement>('manifest').textContent = ''
    manifestForm.removeAttribute('action'); (manifestForm.elements.namedItem('manifest') as HTMLInputElement).value = ''
    reviewed.checked = false; setup.reset(); mapping.reset(); controls()
    find<HTMLElement>('setup-return').hidden = true; find<HTMLElement>('setup-return').textContent = ''
    field('installation').replaceChildren(option('', 'Choose an installation'))
    field('repository').replaceChildren(option('', 'Choose an installation first'))
    field('project').replaceChildren(option('', 'Choose a project'))
    field('task').replaceChildren(option('', 'Choose a project first'))
  }
  const run = async (message: string, operation: (owner: Active, generation: number) => Promise<void>) => {
    const owner = active, generation = revision
    if (!owner || busy || !api || owner.signal.aborted) return
    busy = true; status.textContent = message; controls()
    try { await operation(owner, generation) }
    catch (error) { if (current(owner, generation)) owner.presentFailure(error, () => { status.textContent = note(error) }) }
    finally { if (current(owner, generation)) { busy = false; controls() } }
  }
  const paintConnections = () => {
    connections.replaceChildren()
    for (const connection of state?.connections ?? []) {
      const card = document.createElement('section'), heading = document.createElement('h4')
      heading.textContent = `${installations.find(row => row.id === connection.installation_id)?.account ?? `Installation ${connection.installation_id}`} · ${connection.state}`
      card.appendChild(heading)
      for (const resource of connection.resources) {
        const line = document.createElement('p')
        const project = catalog.projects.find(row => row.id === resource.project_id)?.name ?? `Project ${resource.project_id ?? 'not assigned'}`
        const task = catalog.tasks.find(row => row.id === resource.task_id)?.name ?? `Task ${resource.task_id ?? 'not assigned'}`
        const retryAt = Math.max(resource.next_retry_at, connection.deferred_until ?? 0)
        line.textContent = `${resource.full_name ?? `Repository ${resource.repository_id}`} → ${project} / ${task}. ${resource.state}; sync ${resource.checkpoint_status}. ${resource.items_visible} issues available, ${resource.items_unavailable} unavailable.${resource.failure_code ? ` ${resource.failure_code.replaceAll('_', ' ')}.` : ''}${retryAt > Date.now() ? ` Retry after ${new Date(retryAt).toLocaleString()}.` : ''}`
        card.appendChild(line)
      }
      if (connection.failure_codes.length) {
        const line = document.createElement('p'); line.textContent = connection.failure_codes.map(code => code.replaceAll('_', ' ')).join('; '); card.appendChild(line)
      }
      if (connection.state === 'active') {
        const disconnect = document.createElement('button'); disconnect.type = 'button'; disconnect.textContent = 'Disconnect installation'
        disconnect.setAttribute('aria-label', `Disconnect GitHub installation ${installations.find(row => row.id === connection.installation_id)?.account ?? connection.installation_id}`)
        disconnect.addEventListener('click', () => {
          void run('Disconnecting GitHub…', async (owner, generation) => {
            const command = pendingDisconnects.get(connection.id) ?? { command_id: crypto.randomUUID(), connection_id: connection.id, expected_generation: connection.generation }
            pendingDisconnects.set(connection.id, command)
            await api!.disconnectGithubReader({ body: command, signal: owner.signal })
            if (!current(owner, generation)) return
            pendingDisconnects.delete(connection.id); await refreshStatus(owner, generation)
            if (current(owner, generation)) status.textContent = 'GitHub installation disconnected. Existing local links are retained.'
          })
        }); card.appendChild(disconnect)
      }
      connections.appendChild(card)
    }
    if (!state?.connections.length) connections.textContent = 'No repository connections yet.'
    sync.hidden = !state?.available || !state.connections.some(row => row.state === 'active')
  }
  const refreshStatus = async (owner: Active, generation: number) => {
    const response = await api!.getGithubReaderStatus({ signal: owner.signal })
    if (!current(owner, generation)) return
    state = response.data; paintConnections()
  }
  const paintTasks = () => {
    const projectId = Number(field('project').value)
    const ids = new Set(catalog.assignments.filter(row => row.project_id === projectId).map(row => row.task_id))
    field('task').replaceChildren(option('', projectId ? 'Choose a task' : 'Choose a project first'), ...catalog.tasks.filter(row => ids.has(row.id)).map(row => option(String(row.id), row.name)))
    controls()
  }
  const loadInstallations = async (owner: Active, generation: number, page: number) => {
    const response = await api!.listGithubReaderInstallations({ query: { page }, signal: owner.signal })
    if (!current(owner, generation)) return
    installations = [...new Map([...installations, ...response.data.items].map(row => [row.id, row])).values()]
    const selected = field('installation').value
    field('installation').replaceChildren(option('', 'Choose an installation'), ...installations.map(row => option(row.id, `${row.account} (${row.repository_selection === 'all' ? 'all repositories' : 'selected repositories'})`)))
    field('installation').value = selected; nextInstallations = response.data.next_page; paintConnections()
    status.textContent = installations.length ? 'Choose a GitHub installation.' : 'No installations are available. Install the GitHub App for the repositories you want to connect, then refresh.'
  }
  const loadRepositories = async (owner: Active, generation: number, page: number) => {
    const installationId = field('installation').value
    const response = await api!.listGithubReaderRepositories({ query: { installation_id: installationId, page }, signal: owner.signal })
    if (!current(owner, generation) || field('installation').value !== installationId) return
    repositories = [...new Map([...repositories, ...response.data.items].map(row => [row.id, row])).values()]
    const selected = field('repository').value
    field('repository').replaceChildren(option('', 'Choose a repository'), ...repositories.map(row => option(row.id, row.full_name)))
    field('repository').value = selected; nextRepositories = response.data.next_page
    status.textContent = repositories.length ? 'Choose a repository, project and task.' : 'No repositories are available. Review the App installation access in GitHub.'
  }
  field('installation').addEventListener('change', () => {
    if (busy) return
    pendingMap = null; repositories = []; nextRepositories = null
    field('repository').replaceChildren(option('', 'Choose an installation first')); controls()
    if (field('installation').value) void run('Loading GitHub repositories…', (owner, generation) => loadRepositories(owner, generation, 1))
  })
  field('project').addEventListener('change', () => { pendingMap = null; paintTasks() })
  mapping.addEventListener('change', () => { if (!busy) pendingMap = null })
  moreInstallations.addEventListener('click', () => { if (nextInstallations) void run('Loading more installations…', (owner, generation) => loadInstallations(owner, generation, nextInstallations!)) })
  moreRepositories.addEventListener('click', () => { if (nextRepositories) void run('Loading more repositories…', (owner, generation) => loadRepositories(owner, generation, nextRepositories!)) })
  mapping.addEventListener('submit', event => {
    event.preventDefault()
    if (mapping.hidden || !mapping.reportValidity()) return
    void run('Saving repository mapping…', async (owner, generation) => {
      pendingMap ??= { command_id: crypto.randomUUID(), expected_generation: state?.connections.find(row => row.installation_id === field('installation').value)?.generation ?? 0, installation_id: field('installation').value, repository_id: field('repository').value, project_id: Number(field('project').value), task_id: Number(field('task').value) }
      await api!.mapGithubRepository({ body: pendingMap, signal: owner.signal })
      if (!current(owner, generation)) return
      pendingMap = null; await refreshStatus(owner, generation)
      if (current(owner, generation)) status.textContent = 'Repository mapped. Sync GitHub issues when ready.'
    })
  })
  setup.addEventListener('submit', event => {
    event.preventDefault(); if (setup.hidden || !setup.reportValidity()) return
    void run('Preparing the GitHub App manifest…', async (owner, generation) => {
      const organization = (setup.elements.namedItem('organization') as HTMLInputElement).value.trim()
      const response = await api!.beginGithubAppSetup({ body: organization ? { organization } : {}, signal: owner.signal })
      if (!current(owner, generation)) return
      const action = githubUrl(response.data.registration_url, true)
      const manifest = JSON.parse(response.data.manifest) as unknown
      find<HTMLElement>('manifest').textContent = JSON.stringify(manifest, null, 2)
      manifestForm.action = action; (manifestForm.elements.namedItem('manifest') as HTMLInputElement).value = response.data.manifest
      reviewed.checked = false; manifestReview.hidden = false
      status.textContent = 'Review the App permissions, then continue to GitHub to create and install it.'
    })
  })
  setup.addEventListener('input', () => {
    if (busy) return
    reviewed.checked = false; manifestReview.hidden = true; manifestForm.removeAttribute('action')
    ;(manifestForm.elements.namedItem('manifest') as HTMLInputElement).value = ''
    find<HTMLElement>('manifest').textContent = ''; controls()
  })
  reviewed.addEventListener('change', controls)
  manifestForm.addEventListener('submit', event => {
    if (!active || active.signal.aborted || busy || !reviewed.checked || manifestReview.hidden) event.preventDefault()
  })
  sync.addEventListener('click', () => { void run('Scheduling GitHub issue sync…', async (owner, generation) => {
    await api!.reconcileGithubReader({ body: {}, signal: owner.signal })
    if (!current(owner, generation)) return
    await refreshStatus(owner, generation)
    if (current(owner, generation)) status.textContent = 'GitHub sync requested. Refresh status to see progress.'
  }) })
  const load = async (owner: Active) => {
    clear(); active = owner
    if (owner.identity.profile !== 'administrator') { status.textContent = 'Only administrators can manage GitHub connections.'; return }
    if (!api || isDemoDeployment()) { status.textContent = 'GitHub connections are unavailable on this instance.'; return }
    const returned = new URLSearchParams(location.search).get('github_setup')
    if (returned === 'failed' || returned === 'complete') {
      const message = find<HTMLElement>('setup-return')
      message.hidden = false
      message.textContent = returned === 'failed'
        ? 'GitHub App setup was not completed here. The App may already exist in GitHub. Review your GitHub Apps before starting another registration, or ask the administrator to connect the existing App.'
        : 'GitHub App setup completed. Install the App for the repositories you want to connect, then refresh this status.'
    }
    content.hidden = false
    await run('Loading GitHub connection…', async (a, generation) => {
      await refreshStatus(a, generation)
      if (!current(a, generation) || !state) return
      setup.hidden = state.configured || !state.setup_supported
      mapping.hidden = !state.available
      install.hidden = !state.app
      if (state.app) install.href = githubUrl(state.app.installation_url, false)
      if (state.available) {
        const local = await api.catalog(a.signal)
        if (!current(a, generation)) return
        catalog = local; field('project').replaceChildren(option('', 'Choose a project'), ...catalog.projects.map(row => option(String(row.id), row.name)))
        await loadInstallations(a, generation, 1); paintTasks()
      }
      if (current(a, generation)) status.textContent = state.available
        ? installations.length ? 'GitHub App is configured. Choose repositories to read.' : 'GitHub App is configured, but no installations are available. Install it, then refresh.'
        : state.setup_supported ? 'Create and install a private GitHub App to connect repositories.' : 'GitHub App credentials are not configured for this instance.'
    })
  }
  refresh.addEventListener('click', () => { if (active && !busy) void load(active) })
  return { clear, load }
}
