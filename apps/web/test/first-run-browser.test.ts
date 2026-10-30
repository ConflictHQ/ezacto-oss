/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EzactoClient, type Whoami } from '@conflict-hq/ezacto-client'
import { createFirstRunController } from '../src/first-run/browser.js'
import { renderFirstRunChecklist } from '../src/first-run/render.js'
import type { FirstRunStatus } from '../src/first-run/model.js'
import { createShellApi } from '../src/shell/model.js'

const identity: Whoami = {
  user_id: 1,
  profile: 'administrator',
  manager_grants: [],
  authentication: { kind: 'session' },
}
const empty: FirstRunStatus = {
  hasTimeEntry: false,
  hasClient: false,
  hasProject: false,
  hasTask: false,
  hasProjectTask: false,
  hasOwnAssignment: false,
  projectId: null,
}
const panel = () => document.querySelector<HTMLElement>('[data-first-run-checklist]')!
const completed = () =>
  document.querySelectorAll('[data-first-run-steps] [data-complete="true"]').length
const click = (selector: string) => document.querySelector<HTMLButtonElement>(selector)!.click()

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = `<button data-first-run-help hidden>Help: setup guide</button>${renderFirstRunChecklist()}`
  HTMLElement.prototype.scrollIntoView = vi.fn()
})

describe('first-run setup guide', () => {
  it('shows a local checking phase and clears it when refresh is cancelled', async () => {
    let finish!: (value: FirstRunStatus) => void
    const read = vi.fn().mockResolvedValueOnce(empty)
      .mockImplementationOnce(() => new Promise<FirstRunStatus>(resolve => { finish = resolve }))
    const active = new AbortController()
    createFirstRunController({ getFirstRunStatus: read }).activate(identity, active.signal, () => false)
    await vi.waitFor(() => expect(panel().hidden).toBe(false))
    click('[data-first-run-refresh]')
    expect(document.querySelector('[data-first-run-status]')?.textContent).toBe('Checking setup…')
    expect(document.querySelector('[data-first-run-status]')?.getAttribute('aria-busy')).toBe('true')
    active.abort()
    finish(empty)
    await Promise.resolve()
    expect(document.querySelector('[data-first-run-status]')?.getAttribute('aria-busy')).toBe('false')
    expect(document.querySelector('[data-first-run-status]')?.textContent).toBe('')
  })
  it('checks saved steps, dismisses per owner, reopens from Help and hides after the first entry', async () => {
    let state = empty
    const read = vi.fn(async () => state)
    const controller = createFirstRunController({ getFirstRunStatus: read })
    controller.activate(identity, new AbortController().signal, () => false)
    await vi.waitFor(() => expect(panel().hidden).toBe(false))
    expect(completed()).toBe(0)
    state = {
      ...empty,
      hasClient: true,
      hasProject: true,
      hasTask: true,
      hasProjectTask: true,
      hasOwnAssignment: true,
      projectId: 7,
    }
    click('[data-first-run-refresh]')
    await vi.waitFor(() => expect(completed()).toBe(5))
    expect(
      document.querySelector('[data-first-run-steps] a[href="/projects/7#project-tasks-heading"]'),
    ).not.toBeNull()
    click('[data-first-run-dismiss]')
    expect(panel().hidden).toBe(true)
    controller.activate(identity, new AbortController().signal, () => false)
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3))
    expect(panel().hidden).toBe(true)
    click('[data-first-run-help]')
    await vi.waitFor(() => expect(panel().hidden).toBe(false))
    expect(read.mock.calls.at(-1)).toEqual([1, expect.any(AbortSignal), true])
    state = { ...state, hasTimeEntry: true }
    controller.activate(identity, new AbortController().signal, () => false)
    await vi.waitFor(() => expect(completed()).toBe(6))
    expect(panel().hidden).toBe(true)
    click('[data-first-run-help]')
    await vi.waitFor(() => expect(panel().hidden).toBe(false))
    expect(document.querySelector('[data-first-run-status]')?.textContent).toContain(
      'first time entry is saved',
    )
    controller.markTimeEntrySaved()
    expect(panel().hidden).toBe(false)
  })

  it('does not read administrative setup for members or token identities', () => {
    const read = vi.fn(async () => empty)
    const controller = createFirstRunController({ getFirstRunStatus: read })
    controller.activate(
      { ...identity, profile: 'member' },
      new AbortController().signal,
      () => false,
    )
    controller.activate(
      { ...identity, authentication: { kind: 'token', token_id: 9, scopes: [] } },
      new AbortController().signal,
      () => false,
    )
    expect(read).not.toHaveBeenCalled()
    expect(panel().hidden).toBe(true)
  })

  it('clears on abort and ignores a previous owner response', async () => {
    let resolve!: (state: FirstRunStatus) => void
    const pending = new Promise<FirstRunStatus>((done) => {
      resolve = done
    })
    const controller = createFirstRunController({ getFirstRunStatus: async () => pending })
    const signal = new AbortController()
    controller.activate(identity, signal.signal, () => false)
    signal.abort()
    resolve(empty)
    await pending
    await Promise.resolve()
    expect(panel().hidden).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('[data-first-run-help]')!.hidden).toBe(true)
  })

  it('keeps a late empty setup response hidden after the own timesheet saves an entry', async () => {
    let resolve!: (state: FirstRunStatus) => void
    const pending = new Promise<FirstRunStatus>((done) => {
      resolve = done
    })
    const controller = createFirstRunController({ getFirstRunStatus: async () => pending })
    controller.activate(identity, new AbortController().signal, () => false)
    controller.markTimeEntrySaved()
    resolve(empty)
    await pending
    await Promise.resolve()
    expect(panel().hidden).toBe(true)
  })

  it('uses live native resources and checks assignments for the same project and owner', async () => {
    const requested: URL[] = []
    const client = new EzactoClient({
      baseUrl: 'https://setup.test',
      fetch: async (input) => {
        const url = new URL(String(input))
        requested.push(url)
        const path = url.pathname
        const data = path.endsWith('/team/people/1')
          ? { is_owner: true }
          : path.endsWith('/time-entries')
            ? []
            : path.endsWith('/time-entry-options')
              ? [{ project_id: 8, task_id: 4 }]
              : path.endsWith('/task-assignments')
                ? [{ id: 1, task_id: 4 }]
                : [{ id: path.endsWith('/projects') ? 7 : 4 }]
        return new Response(JSON.stringify({ data, page: { next_cursor: null } }), {
          headers: { 'content-type': 'application/json' },
        })
      },
    })
    const state = await createShellApi(client).getFirstRunStatus!(1)
    expect(state).toEqual({
      hasTimeEntry: false,
      hasClient: true,
      hasProject: true,
      hasTask: true,
      hasProjectTask: true,
      hasOwnAssignment: true,
      projectId: 8,
    })
    for (const path of ['/api/v1/task-assignments', '/api/v1/user-assignments']) {
      const url = requested.find((item) => item.pathname === path)!
      expect(url.searchParams.get('project_id')).toBe('8')
      expect(url.searchParams.get('is_active')).toBe('true')
    }
    expect(
      requested
        .find((item) => item.pathname.endsWith('/user-assignments'))!
        .searchParams.get('user_id'),
    ).toBe('1')
    expect(
      requested
        .find((item) => item.pathname.endsWith('/time-entries'))!
        .searchParams.get('per_page'),
    ).toBe('1')
  })

  it('leaves setup hidden for non-owner administrators and avoids setup reads after a first entry', async () => {
    for (const isOwner of [false, true]) {
      const requested: string[] = []
      const client = new EzactoClient({
        baseUrl: 'https://setup.test',
        fetch: async (input) => {
          const path = new URL(String(input)).pathname
          requested.push(path)
          return new Response(
            JSON.stringify({
              data: path.endsWith('/team/people/1') ? { is_owner: isOwner } : [{ id: 1 }],
              page: { next_cursor: null },
            }),
            { headers: { 'content-type': 'application/json' } },
          )
        },
      })
      const state = await createShellApi(client).getFirstRunStatus!(1)
      expect(state === null).toBe(!isOwner)
      if (isOwner) expect(state?.hasTimeEntry).toBe(true)
      expect(requested).toEqual(
        isOwner ? ['/api/v1/team/people/1', '/api/v1/time-entries'] : ['/api/v1/team/people/1'],
      )
    }
  })
})
