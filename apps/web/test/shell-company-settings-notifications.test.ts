/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NotificationSettingsState } from '../src/module-settings/model.js'
import { browserApi, mountShell, renderBrowserShell } from './support/shell-harness.js'

/**
 * Settings > Company > Notifications: when everyone is reminded to submit
 * their week (issue 935), and whether administrators are copied on budget
 * alerts (issue 934). These tests live in their own file, not in
 * shell-company-settings.test.ts, because happy-dom keeps every parse of the
 * shell markup until the file's Window is dropped (issue 456), and that file
 * already sits close to the 4 GB heap a CI fork has.
 */
describe('company settings', () => {
  // The same stub shell-company-settings.test.ts uses: the page fetches the
  // modules list and the sign-in methods itself rather than through the typed
  // client, keyed by path. It returns a real Response because the shell's fetch
  // reads the response headers (issue 953).
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

  // The company page's API, as far as the Notifications section reads it.
  // Other sections are read only when they are shown (issue 809), and every
  // test here opens the page on Notifications.
  const companyApi = () => ({
    ...browserApi(),
    getNotificationSettings: vi.fn(async () => ({
      budget_alerts_include_admins: false,
      submission_reminder: null,
    })),
    updateNotificationSettings: vi.fn(
      async (patch: {
        budget_alerts_include_admins?: boolean
        submission_reminder?: NotificationSettingsState['submission_reminder']
      }) => ({
        budget_alerts_include_admins: patch.budget_alerts_include_admins ?? false,
        submission_reminder: patch.submission_reminder ?? null,
      }),
    ),
  })

  afterEach(async () => {
    // happy-dom delivers hashchange on a timer. The controllers this file has
    // mounted keep listening, and each answers the cleared hash by reading the
    // first section, so the event is let through before fetch is unstubbed
    // rather than reaching a real one at teardown.
    globalThis.location.hash = ''
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0))
    vi.unstubAllGlobals()
  })

  it('[browser #935] sets, and clears, when everyone is reminded to submit their week', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    globalThis.location.hash = '#notifications'
    const api = companyApi()
    await mountShell(api)

    const form = document.querySelector<HTMLFormElement>('[data-notification-settings-form]')!
    const day = document.querySelector<HTMLSelectElement>('[data-notification-settings-day]')!
    const time = document.querySelector<HTMLInputElement>('[data-notification-settings-time]')!
    const result = document.querySelector<HTMLElement>('[data-notification-settings-result]')!
    await vi.waitFor(() => expect(form.hidden).toBe(false))
    // Off until an administrator turns it on.
    expect(day.value).toBe('')
    expect(time.value).toBe('')

    // Half a schedule is not saved.
    day.value = 'monday'
    form.requestSubmit()
    expect(result.textContent).toBe('Choose a time for the submission reminder.')
    expect(api.updateNotificationSettings).not.toHaveBeenCalled()

    time.value = '09:00'
    form.requestSubmit()
    await vi.waitFor(() => expect(result.textContent).toBe('Saved.'))
    expect(api.updateNotificationSettings).toHaveBeenLastCalledWith(
      {
        budget_alerts_include_admins: false,
        submission_reminder: { day: 'monday', time: '09:00' },
      },
      expect.any(AbortSignal),
    )
    expect(day.value).toBe('monday')
    expect(time.value).toBe('09:00')

    day.value = ''
    time.value = ''
    form.requestSubmit()
    await vi.waitFor(() =>
      expect(api.updateNotificationSettings).toHaveBeenLastCalledWith(
        { budget_alerts_include_admins: false, submission_reminder: null },
        expect.any(AbortSignal),
      ),
    )
    globalThis.location.hash = ''
  })

  it('[browser #934] shows whether administrators are copied on budget alerts, and saves a change', async () => {
    stubModulesEndpoint()
    renderBrowserShell({ view: 'settings-company' })
    globalThis.location.hash = '#notifications'
    const api = companyApi()
    await mountShell(api)

    const form = document.querySelector<HTMLFormElement>('[data-notification-settings-form]')!
    const admins = document.querySelector<HTMLInputElement>('[data-notification-settings-admins]')!
    const result = document.querySelector<HTMLElement>('[data-notification-settings-result]')!
    await vi.waitFor(() => expect(form.hidden).toBe(false))
    expect(admins.checked).toBe(false)

    admins.checked = true
    form.requestSubmit()
    await vi.waitFor(() => expect(result.textContent).toBe('Saved.'))
    expect(api.updateNotificationSettings).toHaveBeenLastCalledWith(
      { budget_alerts_include_admins: true, submission_reminder: null },
      expect.any(AbortSignal),
    )
    expect(admins.checked).toBe(true)
    globalThis.location.hash = ''
  })
})
