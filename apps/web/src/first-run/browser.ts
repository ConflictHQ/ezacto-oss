import type { Whoami } from '@conflict-hq/ezacto-client'
import type { FirstRunApi, FirstRunStatus } from './model.js'

export const createFirstRunController = (api: Partial<FirstRunApi>) => {
  const panel = document.querySelector<HTMLElement>('[data-first-run-checklist]')
  const help = document.querySelector<HTMLButtonElement>('[data-first-run-help]')
  const steps = document.querySelector<HTMLOListElement>('[data-first-run-steps]')
  const status = document.querySelector<HTMLElement>('[data-first-run-status]')
  const refresh = document.querySelector<HTMLButtonElement>('[data-first-run-refresh]')
  let session: {
    identity: Whoami
    signal: AbortSignal
    onFailure: (error: unknown) => boolean
  } | null = null
  let generation = 0
  let forceOpen = false
  let entrySaved = false
  const storageKey = (id: number) => `ezacto:first-run-dismissed:${id}`
  const dismissed = (id: number): boolean => {
    try {
      return localStorage.getItem(storageKey(id)) === 'true'
    } catch {
      return false
    }
  }
  const paint = (state: FirstRunStatus): void => {
    if (!steps) return
    const project = state.projectId === null ? '/projects' : `/projects/${state.projectId}`
    const items = [
      [state.hasClient, 'Create a client', '/clients'],
      [state.hasProject, 'Create a project for the client', '/projects'],
      [state.hasTask, 'Create a task', '/tasks'],
      [state.hasProjectTask, 'Add the task to the project', `${project}#project-tasks-heading`],
      [state.hasOwnAssignment, 'Assign yourself to the project', `${project}#project-team-heading`],
      [state.hasTimeEntry, 'Log time on your timesheet', '/'],
    ] as const
    steps.replaceChildren(
      ...items.map(([complete, label, href]) => {
        const item = document.createElement('li')
        item.dataset.complete = String(complete)
        const marker = document.createElement('span')
        marker.textContent = complete ? '✓ ' : '○ '
        marker.setAttribute('aria-hidden', 'true')
        const link = document.createElement('a')
        link.href = href
        link.textContent = label
        link.setAttribute('aria-label', `${complete ? 'Completed' : 'Next step'}: ${label}`)
        item.append(marker, link)
        return item
      }),
    )
  }
  const load = async (): Promise<void> => {
    const active = session
    if (!active || active.signal.aborted || !api.getFirstRunStatus || !panel || !help || !status)
      return
    const request = ++generation
    if (refresh) refresh.disabled = true
    try {
      const state = await api.getFirstRunStatus(active.identity.user_id, active.signal, forceOpen)
      if (session !== active || active.signal.aborted || request !== generation) return
      help.hidden = state === null
      if (state === null) {
        panel.hidden = true
        return
      }
      paint(state)
      panel.hidden =
        !forceOpen && (state.hasTimeEntry || entrySaved || dismissed(active.identity.user_id))
      status.textContent = state.hasTimeEntry
        ? 'Your first time entry is saved. You can keep using these setup links.'
        : 'Complete the missing steps, then return to Time and choose Log time.'
    } catch (error) {
      if (session !== active || active.signal.aborted || request !== generation) return
      if (active.onFailure(error)) return
      if (forceOpen) {
        panel.hidden = false
        status.textContent = 'Setup could not be checked. Try checking again.'
      }
    } finally {
      if (session === active && !active.signal.aborted && request === generation && refresh)
        refresh.disabled = false
    }
  }
  help?.addEventListener('click', () => {
    forceOpen = true
    if (session) {
      try {
        localStorage.removeItem(storageKey(session.identity.user_id))
      } catch {
        /* Help still opens without storage. */
      }
    }
    if (panel) panel.hidden = false
    void load().then(() => panel?.scrollIntoView({ block: 'start', behavior: 'auto' }))
  })
  refresh?.addEventListener('click', () => {
    void load()
  })
  document.querySelector('[data-first-run-dismiss]')?.addEventListener('click', () => {
    if (!session) return
    try {
      localStorage.setItem(storageKey(session.identity.user_id), 'true')
    } catch {
      /* The current view can still be dismissed. */
    }
    forceOpen = false
    if (panel) panel.hidden = true
  })
  return {
    activate(identity: Whoami, signal: AbortSignal, onFailure: (error: unknown) => boolean): void {
      generation++
      session = null
      forceOpen = false
      entrySaved = false
      if (panel) panel.hidden = true
      if (help) help.hidden = true
      if (
        identity.profile !== 'administrator' ||
        identity.authentication.kind !== 'session' ||
        signal.aborted
      )
        return
      const active = { identity, signal, onFailure }
      session = active
      signal.addEventListener(
        'abort',
        () => {
          if (session !== active) return
          session = null
          generation++
          if (panel) panel.hidden = true
          if (help) help.hidden = true
        },
        { once: true },
      )
      void load()
    },
    markTimeEntrySaved(): void {
      if (entrySaved) return
      entrySaved = true
      forceOpen = false
      // The successfully loaded own timesheet is already authoritative; no
      // second setup fan-out is needed to hide a finished first-run guide.
      if (panel && !forceOpen) panel.hidden = true
    },
  }
}
