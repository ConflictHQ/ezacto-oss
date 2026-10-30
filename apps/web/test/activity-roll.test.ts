/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createActivityController, type ActivityApi } from '../src/activity/browser.js'
import { renderActivityLogPage } from '../src/module-settings/render.js'

const roll = (): HTMLElement => document.querySelector<HTMLElement>('[data-activity-roll]')!
const buttons = (): HTMLButtonElement[] => [
  ...document.querySelectorAll<HTMLButtonElement>('[data-activity-roll-year]'),
]
const status = (): string =>
  document.querySelector<HTMLElement>('[data-activity-log-status]')?.textContent ?? ''

const mount = async (
  options: {
    administrator?: boolean
    years?: { year: number; entries: number }[]
    rollActivityYear?: ActivityApi['rollActivityYear'] | null
    listRollableYears?: ActivityApi['listRollableYears'] | null
  } = {},
) => {
  document.body.innerHTML = renderActivityLogPage('settings-activity')
  const years = options.years ?? [{ year: 2026, entries: 12 }]
  const listActivityLog = vi.fn(async () => ({ data: [] }))
  const rollActivityYear = vi.fn<NonNullable<ActivityApi['rollActivityYear']>>(async () => {
    years.splice(0)
  })
  const api: ActivityApi = {
    listActivityLog,
    ...(options.listRollableYears === null
      ? {}
      : { listRollableYears: options.listRollableYears ?? (async () => [...years]) }),
    ...(options.rollActivityYear === null
      ? {}
      : { rollActivityYear: options.rollActivityYear ?? rollActivityYear }),
  }
  await createActivityController(api).activate(new AbortController().signal, {
    administrator: options.administrator ?? true,
  })
  return { listActivityLog, rollActivityYear }
}

describe('activity log roll prompt (web)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('[unit] prompts an administrator for each finished year the log still holds', async () => {
    await mount({
      years: [
        { year: 2025, entries: 1 },
        { year: 2026, entries: 12 },
      ],
    })

    expect(roll().hidden).toBe(false)
    expect(buttons().map((button) => button.textContent)).toEqual([
      'Archive 2025 (1 entry)',
      'Archive 2026 (12 entries)',
    ])
  })

  it('[unit] shows nothing when there is no finished year to roll', async () => {
    await mount({ years: [] })

    expect(roll().hidden).toBe(true)
  })

  it('[security] never asks for the years, or shows the prompt, to anyone but an administrator', async () => {
    const listRollableYears = vi.fn<NonNullable<ActivityApi['listRollableYears']>>(async () => [
      { year: 2026, entries: 3 },
    ])
    await mount({ administrator: false, listRollableYears })

    expect(roll().hidden).toBe(true)
    expect(listRollableYears).not.toHaveBeenCalled()
  })

  it('[unit] stays hidden where the build cannot roll', async () => {
    await mount({ listRollableYears: null, rollActivityYear: null })

    expect(roll().hidden).toBe(true)
  })

  it('[unit] a failure to list the years leaves the log readable and the prompt hidden', async () => {
    const { listActivityLog } = await mount({
      listRollableYears: async () => {
        throw new Error('nope')
      },
    })

    expect(roll().hidden).toBe(true)
    expect(listActivityLog).toHaveBeenCalled()
  })

  it('[e2e] rolls the year after the administrator confirms, then reloads the log', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    const { rollActivityYear, listActivityLog } = await mount()
    const before = listActivityLog.mock.calls.length

    buttons()[0]!.click()

    await vi.waitFor(() => expect(rollActivityYear).toHaveBeenCalledTimes(1))
    expect(rollActivityYear.mock.calls[0]![0]).toBe(2026)
    await vi.waitFor(() => expect(roll().hidden).toBe(true))
    expect(listActivityLog.mock.calls.length).toBeGreaterThan(before)
    await vi.waitFor(() => expect(status()).toContain('2026 archived.'))
  })

  it('[unit] does nothing when the administrator declines the confirmation', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false))
    const { rollActivityYear } = await mount()

    buttons()[0]!.click()
    await Promise.resolve()

    expect(rollActivityYear).not.toHaveBeenCalled()
    expect(roll().hidden).toBe(false)
  })

  it('[unit] says plainly why a roll was refused and leaves the button usable', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    await mount({
      rollActivityYear: async () => {
        throw new Error('That year has already been rolled.')
      },
    })

    buttons()[0]!.click()

    await vi.waitFor(() => expect(status()).toBe('That year has already been rolled.'))
    expect(buttons()[0]!.disabled).toBe(false)
  })
})
