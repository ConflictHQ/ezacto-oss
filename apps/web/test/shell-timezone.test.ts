/** @vitest-environment happy-dom */

import { describe, expect, it, vi } from 'vitest'
import {
  browserApi,
  mountShell,
  renderBrowserShell,
  type ShellApi,
} from './support/shell-harness.js'

/**
 * Issue 798. The menu's timezone box focused and dropped nothing.
 *
 * It was a text box fed by a shared `<datalist>`, and a datalist popup filters
 * by what the box already holds: `loadProfileTimezone` pre-fills it with the
 * zone on file, so the list collapsed to the one value already chosen and the
 * browser showed no popup at all. That is the same failure the entry editor's
 * project and task boxes had (issues 497 and 506). The list also sat outside
 * the menu dialog, which `showModal()` makes inert while it is open.
 *
 * Both are properties of the control, not of the data, so the control changed.
 * A select carries its own options, which is also why a DOM test can now see
 * what the popup never let one see.
 */

const openMenu = (): HTMLDialogElement => {
  document.querySelector<HTMLButtonElement>('[data-menu-trigger]')!.click()
  return document.querySelector<HTMLDialogElement>('[data-menu-dialog]')!
}

const profileTimezone = (): HTMLSelectElement =>
  document.querySelector<HTMLSelectElement>('[data-profile-timezone]')!

const submitProfileTimezone = (): void => {
  document
    .querySelector<HTMLFormElement>('[data-profile-timezone-form]')!
    .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
}

const shellWithProfile = (timezone: string) => {
  const getProfile = vi.fn(async () => ({ user_id: 1, timezone }))
  const updateProfile = vi.fn(async (zone: string) => ({ user_id: 1, timezone: zone }))
  const api: ShellApi = { ...browserApi(), getProfile, updateProfile }
  return { api, getProfile, updateProfile }
}

describe('personal timezone', () => {
  it('[browser][regression] offers the zone list inside the menu dialog (issue 798)', async () => {
    renderBrowserShell()
    const { api, getProfile } = shellWithProfile('UTC')
    await mountShell(api)

    const dialog = openMenu()
    await vi.waitFor(() => expect(getProfile).toHaveBeenCalled())

    const control = profileTimezone()
    // The options are the control's own, so whatever a browser does with a
    // datalist popup, this is the list the person is choosing from.
    expect(control.tagName).toBe('SELECT')
    const zones = [...control.options].map((option) => option.value)
    expect(zones.length).toBeGreaterThan(100)
    expect(zones).toContain('America/Costa_Rica')
    expect(zones).toContain('Europe/Madrid')
    // Inside the dialog rather than beside it: a modal dialog makes the rest of
    // the document inert, which is where the shared list used to sit.
    for (const option of control.options) expect(dialog.contains(option)).toBe(true)
    expect(control.getAttribute('list')).toBeNull()
    expect(document.getElementById('timezone-options')).toBeNull()
    // 'UTC' is the column's "unset": nothing chosen, and the hint says why.
    expect(control.value).toBe('')
    expect(
      document.querySelector('[data-profile-timezone-hint]')!.textContent,
    ).toContain('organization timezone')
  })

  it('[browser] saves the zone the person picks through the profile endpoint', async () => {
    renderBrowserShell()
    const { api, getProfile, updateProfile } = shellWithProfile('UTC')
    await mountShell(api)
    openMenu()
    await vi.waitFor(() => expect(getProfile).toHaveBeenCalled())

    const control = profileTimezone()
    const chosen = [...control.options].find((option) => option.value === 'Europe/Madrid')!
    control.value = chosen.value
    // A select refuses a value it does not offer, so this is also the proof the
    // option is really in the list rather than merely named by the test.
    expect(control.value).toBe('Europe/Madrid')
    submitProfileTimezone()

    await vi.waitFor(() =>
      expect(updateProfile).toHaveBeenCalledWith('Europe/Madrid', expect.any(AbortSignal)),
    )
    await vi.waitFor(() =>
      expect(document.querySelector('[data-profile-timezone-result]')!.textContent).toContain(
        'Europe/Madrid',
      ),
    )
  })

  it('[browser][regression] offers UTC while a different zone is on file', async () => {
    // 'UTC' is the profile column's "unset", and the only way back to filing on
    // the organization timezone once a zone is on file (an empty submit is
    // refused). V8's `Intl.supportedValuesOf` leaves 'UTC' out, and a select
    // offers nothing but its own options, so the list has to carry it whether
    // or not the engine does -- not only while UTC is already the held value.
    renderBrowserShell()
    const { api, updateProfile } = shellWithProfile('America/Costa_Rica')
    await mountShell(api)
    openMenu()

    const control = profileTimezone()
    await vi.waitFor(() => expect(control.value).toBe('America/Costa_Rica'))
    control.value = 'UTC'
    expect(control.value).toBe('UTC')
    submitProfileTimezone()

    await vi.waitFor(() =>
      expect(updateProfile).toHaveBeenCalledWith('UTC', expect.any(AbortSignal)),
    )
  })

  it('[browser] keeps a stored zone the browser does not enumerate', async () => {
    // `US/Pacific` is a valid IANA link that `Intl.supportedValuesOf` omits, as
    // is the 'UTC' the organization setting defaults to. A select drops a value
    // it does not offer, so the box would show the first zone in the list and
    // then save it -- the wrong zone rather than a refused one.
    renderBrowserShell()
    const { api, updateProfile } = shellWithProfile('US/Pacific')
    await mountShell(api)
    openMenu()

    const control = profileTimezone()
    await vi.waitFor(() => expect(control.value).toBe('US/Pacific'))
    submitProfileTimezone()

    await vi.waitFor(() =>
      expect(updateProfile).toHaveBeenCalledWith('US/Pacific', expect.any(AbortSignal)),
    )
  })
})
