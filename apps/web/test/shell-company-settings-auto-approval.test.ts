/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TimesheetAutoApprovalState } from '../src/module-settings/model.js'
import { browserApi, mountShell, renderBrowserShell } from './support/shell-harness.js'

/**
 * Settings > Company > Approval: the optional automatic approval of submitted
 * timesheets (issue 1009). Its own file, not shell-company-settings.test.ts,
 * for the heap reason given in shell-company-settings-notifications.test.ts.
 */
describe('company settings: automatic approval', () => {
  const stubModulesEndpoint = (): void => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const path = String(input)
        const data = path.includes('/admin/sign-in-methods')
          ? [{ method: 'password', configured: true, enabled: true }]
          : [{ module: 'expenses', enabled: true }]
        return new Response(JSON.stringify({ data }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
  }

  const off: TimesheetAutoApprovalState = {
    enabled: false,
    window_days: null,
    clock_starts_at: 'submitted_at',
    effective_from: null,
    approval_module_enabled: true,
  }

  const companyApi = (initial: TimesheetAutoApprovalState = off) => ({
    ...browserApi(),
    getTimesheetAutoApproval: vi.fn(async () => initial),
    updateTimesheetAutoApproval: vi.fn(
      async (patch: { enabled?: boolean; window_days?: number }): Promise<TimesheetAutoApprovalState> => ({
        ...initial,
        enabled: patch.enabled ?? initial.enabled,
        window_days: patch.window_days ?? initial.window_days,
        effective_from: patch.enabled === true ? '2026-10-18T12:00:00.000Z' : null,
      }),
    ),
  })

  afterEach(async () => {
    globalThis.location.hash = ''
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0))
    vi.unstubAllGlobals()
  })

  const open = async (api: ReturnType<typeof companyApi>) => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    globalThis.location.hash = '#approval'
    await mountShell(api)
    const form = document.querySelector<HTMLFormElement>('[data-auto-approval-form]')!
    await vi.waitFor(() => expect(form.hidden).toBe(false))
    return {
      form,
      enabled: document.querySelector<HTMLInputElement>('[data-auto-approval-enabled]')!,
      days: document.querySelector<HTMLInputElement>('[data-auto-approval-days]')!,
      since: document.querySelector<HTMLElement>('[data-auto-approval-since]')!,
      result: document.querySelector<HTMLElement>('[data-auto-approval-result]')!,
    }
  }

  it('[browser #1009] starts off, will not turn on without a window, then saves and says from when it applies', async () => {
    const api = companyApi()
    const { form, enabled, days, since, result } = await open(api)
    expect(enabled.checked).toBe(false)
    expect(days.value).toBe('')
    expect(since.textContent).toContain('does not approve weeks that are already waiting')

    enabled.checked = true
    form.requestSubmit()
    expect(result.textContent).toBe('Choose how many days a week waits before it is approved.')
    expect(api.updateTimesheetAutoApproval).not.toHaveBeenCalled()

    days.value = '7'
    form.requestSubmit()
    await vi.waitFor(() => expect(result.textContent).toBe('Saved.'))
    expect(api.updateTimesheetAutoApproval).toHaveBeenLastCalledWith(
      { enabled: true, window_days: 7 },
      expect.any(AbortSignal),
    )
    expect(since.textContent).toBe('Applies to weeks submitted on or after 2026-10-18.')
  })

  it('[browser #1009] shows a running policy and turns it off', async () => {
    const api = companyApi({
      ...off,
      enabled: true,
      window_days: 5,
      effective_from: '2026-10-01T00:00:00.000Z',
    })
    const { form, enabled, days, since, result } = await open(api)
    expect(enabled.checked).toBe(true)
    expect(days.value).toBe('5')
    expect(since.textContent).toBe('Applies to weeks submitted on or after 2026-10-01.')

    enabled.checked = false
    form.requestSubmit()
    await vi.waitFor(() => expect(result.textContent).toBe('Saved.'))
    expect(api.updateTimesheetAutoApproval).toHaveBeenLastCalledWith(
      { enabled: false, window_days: 5 },
      expect.any(AbortSignal),
    )
  })

  it('[browser #1009] says so when the Approval module is off', async () => {
    const { since } = await open(companyApi({ ...off, approval_module_enabled: false }))
    expect(since.textContent).toBe('Needs the Approval module, which is off.')
  })
})
