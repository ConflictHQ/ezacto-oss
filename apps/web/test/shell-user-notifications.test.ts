/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest'
import type { ProfileNotificationInput, TeamNotificationPreference } from '@conflict-hq/ezacto-client'
import { browserApi, mountShell, renderBrowserShell } from './support/shell-harness.js'

/**
 * Your own reminders, on the one page that is yours (issue 935).
 *
 * The Team page lets whoever administers people edit anybody's, but a member
 * cannot open it at all, and "per-person opt-out" that means asking an
 * administrator is not an opt-out. Every reminder links here.
 */
describe('your reminders in your own settings', () => {
  const stored = (over: Partial<TeamNotificationPreference> = {}): TeamNotificationPreference => ({
    delivery_active: true,
    daily_reminder_enabled: false,
    reminder_time: null,
    reminder_days: [],
    channels: { email: false, desktop: false, slack: false },
    include_in_team_reminders: true,
    weekly_digest: false,
    notify_project_deleted: false,
    updated_at: '2026-10-14T12:00:00.000Z',
    ...over,
  })

  const remindersApi = (overrides: Record<string, unknown> = {}) => ({
    ...browserApi(),
    getProfileNotifications: vi.fn(async () => stored()),
    updateProfileNotifications: vi.fn(async (input: ProfileNotificationInput) =>
      stored({
        daily_reminder_enabled: input.daily_reminder_enabled,
        reminder_time: input.reminder_time,
        reminder_days: input.reminder_days,
        channels: input.channels,
        include_in_team_reminders: input.include_in_team_reminders,
        weekly_digest: input.weekly_digest,
      }),
    ),
    ...overrides,
  })

  const form = (): HTMLFormElement =>
    document.querySelector<HTMLFormElement>('[data-settings-notifications-form]')!
  const box = (name: string): HTMLInputElement => form().elements.namedItem(name) as HTMLInputElement
  const result = (): string =>
    document.querySelector<HTMLElement>('[data-settings-notifications-result]')!.textContent ?? ''

  it('shows what is set, saves a change for yourself, and shows what the server kept', async () => {
    renderBrowserShell({ view: 'settings-user' })
    const api = remindersApi()
    await mountShell(api)

    await vi.waitFor(() => expect(form().hidden).toBe(false))
    // Everybody starts opted in to the week-end reminder; the rest is off.
    expect(box('include_in_team_reminders').checked).toBe(true)
    expect(box('daily_reminder_enabled').checked).toBe(false)

    box('daily_reminder_enabled').checked = true
    box('reminder_time').value = '17:00'
    for (const day of form().querySelectorAll<HTMLInputElement>('[name="reminder_days"]')) {
      day.checked = day.value === 'monday' || day.value === 'friday'
    }
    box('channel_email').checked = true
    box('include_in_team_reminders').checked = false
    form().requestSubmit()

    await vi.waitFor(() => expect(result()).toBe('Saved.'))
    expect(api.updateProfileNotifications).toHaveBeenCalledWith({
      daily_reminder_enabled: true,
      reminder_time: '17:00',
      reminder_days: ['monday', 'friday'],
      channels: { email: true, desktop: false, slack: false },
      include_in_team_reminders: false,
      weekly_digest: false,
      notify_project_deleted: false,
    })
    expect(box('include_in_team_reminders').checked).toBe(false)
  })

  it('says what is missing before it asks the server', async () => {
    renderBrowserShell({ view: 'settings-user' })
    const api = remindersApi()
    await mountShell(api)
    await vi.waitFor(() => expect(form().hidden).toBe(false))

    box('daily_reminder_enabled').checked = true
    form().requestSubmit()
    expect(result()).toBe('Choose a time for the daily reminder.')
    expect(api.updateProfileNotifications).not.toHaveBeenCalled()
  })

  it('shows the server\'s reason when it refuses, and leaves the form as typed', async () => {
    renderBrowserShell({ view: 'settings-user' })
    const refusal = Object.assign(new Error('refused'), {
      status: 422,
      body: { error: { fields: [{ message: 'Daily reminders require a time, at least one day, and the email channel.' }] } },
    })
    const api = remindersApi({
      updateProfileNotifications: vi.fn(async () => {
        throw refusal
      }),
    })
    await mountShell(api)
    await vi.waitFor(() => expect(form().hidden).toBe(false))

    box('weekly_digest').checked = true
    form().requestSubmit()
    await vi.waitFor(() =>
      expect(result()).toBe('Daily reminders require a time, at least one day, and the email channel.'),
    )
    expect(box('weekly_digest').checked).toBe(true)
  })

  it('never offers what is not delivered', async () => {
    renderBrowserShell({ view: 'settings-user' })
    await mountShell(
      remindersApi({
        getProfileNotifications: vi.fn(async () =>
          stored({ channels: { email: true, desktop: true, slack: true }, notify_project_deleted: true }),
        ),
      }),
    )
    await vi.waitFor(() => expect(form().hidden).toBe(false))
    for (const name of ['channel_desktop', 'channel_slack', 'notify_project_deleted']) {
      expect(box(name).disabled, name).toBe(true)
      expect(box(name).checked, name).toBe(false)
    }
  })

  it('[security] on the public demo, sets nothing and says why', async () => {
    renderBrowserShell({ view: 'settings-user', demo: true })
    const api = remindersApi()
    await mountShell(api)
    await vi.waitFor(() =>
      expect(
        document.querySelector<HTMLElement>('[data-settings-notifications-status]')!.textContent,
      ).toBe('Setting reminders: not available on the public demo.'),
    )
    expect(form().hidden).toBe(true)
    expect(api.getProfileNotifications).not.toHaveBeenCalled()
  })

  it('stays hidden for a build whose API has no such route', async () => {
    renderBrowserShell({ view: 'settings-user' })
    await mountShell(browserApi())
    expect(document.querySelector<HTMLElement>('[data-settings-notifications]')!.hidden).toBe(true)
  })
})
