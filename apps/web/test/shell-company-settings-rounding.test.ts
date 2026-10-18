/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TimeRoundingPatch } from '@conflict-hq/ezacto-client'
import {
  EzactoApiError,
  browserApi,
  mountShell,
  renderBrowserShell,
} from './support/shell-harness.js'

/**
 * Settings > Time: the rounding rule and recalculating open entries (issue
 * 949). These tests live in their own file, not in
 * shell-company-settings.test.ts, because happy-dom keeps every parse of the
 * shell markup until the file's Window is dropped (issue 456). With these seven
 * tests that file needed more than the 4 GB heap a CI fork has, and the fork
 * died partway through it.
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

  // The company page's API, as far as the Time section reads it: the time
  // settings come from browserApi, and the notes policy sits beside the rule.
  // Other sections are read only when they are shown (issue 809), and every
  // test here opens the page on Time.
  const companyApi = () => ({
    ...browserApi(),
    getTimeEntryNoteSettings: vi.fn(async () => ({ required: true, minimum_length: 12 })),
    updateTimeEntryNoteSettings: vi.fn(async (patch: { required?: boolean; minimum_length?: number }) => ({
      required: patch.required ?? true,
      minimum_length: patch.minimum_length ?? 12,
    })),
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

  // A section is read the first time it is shown (issue 809), so a test opens
  // the page on the section it reads, the way an operator following a link
  // would.
  const openCompanySettings = (section: string): void => {
    renderBrowserShell({ view: 'settings-company' })
    globalThis.location.hash = `#${section}`
  }

  describe('time rounding (issue 949)', () => {
    const preview = (over: Record<string, unknown> = {}) => ({
      scope: { project_id: null, from: null, to: null },
      open_entries: 4,
      changed_entries: 2,
      rounded_seconds_before: 5_400,
      rounded_seconds_after: 3_600,
      earliest_spent_date: '2026-09-02',
      latest_spent_date: '2026-09-14',
      projects: [
        {
          project_id: 1,
          project_name: 'Alpha',
          time_rounding: { mode: 'down' as const, minutes: 30 as const, source: 'organization' as const },
          changed_entries: 2,
          rounded_seconds_before: 5_400,
          rounded_seconds_after: 3_600,
        },
      ],
      kept: { invoiced: 1, approved: 0, locked: 2, other: 0 },
      fingerprint: 'a'.repeat(64),
      ...over,
    })

    const roundingApi = () => ({
      ...companyApi(),
      getTimeEntrySettings: vi.fn(async () => ({
        time_entry_mode: 'duration' as const,
        time_format: 'decimal' as const,
        clock: '12h' as const,
        week_start_day: 'monday' as const,
        time_rounding: { mode: 'up' as const, minutes: 30 as const },
      })),
      updateTimeEntryRoundingSettings: vi.fn(async (patch: TimeRoundingPatch) => ({
        mode: patch.mode ?? ('up' as const),
        minutes: patch.minutes ?? (30 as const),
      })),
      previewTimeRoundingRecalculation: vi.fn(async () => preview()),
      applyTimeRoundingRecalculation: vi.fn(async () => ({
        recalculated_entries: 2,
        preview: preview(),
      })),
    })

    const submit = (form: string): void => {
      document
        .querySelector<HTMLFormElement>(form)!
        .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
    }
    const click = (selector: string): void => {
      document.querySelector<HTMLElement>(selector)!.click()
    }

    it('[unit] shows the organization rule and saves a new one without touching saved time', async () => {
      stubModulesEndpoint()
      openCompanySettings('time')
      const api = roundingApi()
      await mountShell(api)

      const mode = document.querySelector<HTMLSelectElement>('[data-rounding-mode]')!
      const minutes = document.querySelector<HTMLSelectElement>('[data-rounding-minutes]')!
      await vi.waitFor(() => expect(mode.value).toBe('up'))
      expect(minutes.value).toBe('30')
      expect(document.querySelector<HTMLElement>('[data-rounding-form]')!.hidden).toBe(false)
      expect(document.querySelector<HTMLElement>('[data-rounding-recalculate]')!.hidden).toBe(false)
      // Every direction and every increment is offered.
      expect([...mode.options].map((option) => option.value)).toEqual(['exact', 'up', 'down', 'nearest'])
      expect([...minutes.options].map((option) => option.value)).toEqual(['6', '10', '15', '20', '30', '60'])

      mode.value = 'down'
      minutes.value = '10'
      submit('[data-rounding-form]')

      await vi.waitFor(() =>
        expect(api.updateTimeEntryRoundingSettings).toHaveBeenCalledWith(
          { mode: 'down', minutes: 10 },
          expect.any(AbortSignal),
        ),
      )
      await vi.waitFor(() =>
        expect(document.querySelector('[data-rounding-result]')?.textContent).toBe(
          'Saved. New time is rounded down to 10 min. Time already saved keeps its hours.',
        ),
      )
      expect(api.previewTimeRoundingRecalculation).not.toHaveBeenCalled()
      expect(api.applyTimeRoundingRecalculation).not.toHaveBeenCalled()
    })

    it('[unit] says who may change rounding when the API refuses', async () => {
      stubModulesEndpoint()
      openCompanySettings('time')
      const api = roundingApi()
      api.updateTimeEntryRoundingSettings.mockRejectedValueOnce(
        new EzactoApiError(403, { error: { code: 'profile_forbidden' } }, 'req-403'),
      )
      await mountShell(api)
      await vi.waitFor(() =>
        expect(document.querySelector<HTMLSelectElement>('[data-rounding-mode]')!.value).toBe('up'),
      )
      submit('[data-rounding-form]')
      await vi.waitFor(() =>
        expect(document.querySelector('[data-rounding-result]')?.textContent).toBe(
          'Only executive managers and administrators can change time rounding.',
        ),
      )
    })

    it('[unit] previews what would change, then applies exactly that preview', async () => {
      stubModulesEndpoint()
      openCompanySettings('time')
      const api = roundingApi()
      await mountShell(api)
      await vi.waitFor(() =>
        expect(document.querySelector<HTMLElement>('[data-rounding-recalculate]')!.hidden).toBe(false),
      )
      document.querySelector<HTMLInputElement>('[data-rounding-from]')!.value = '2026-09-01'
      click('[data-rounding-preview]')

      await vi.waitFor(() =>
        expect(document.querySelector('[data-rounding-preview-output]')?.textContent).toContain(
          '2 entries of 4 open would change, from 1.50 h to 1.00 h (-0.50 h).',
        ),
      )
      const text = document.querySelector('[data-rounding-preview-output]')!.textContent!
      expect(text).toContain('Dated 2026-09-02 to 2026-09-14.')
      expect(text).toContain('Alpha: 2 entries, 1.50 h to 1.00 h, rounded down to 30 min (organization setting).')
      expect(text).toContain('Left exactly as they are: 1 invoiced, 2 in locked periods.')
      expect(api.previewTimeRoundingRecalculation).toHaveBeenCalledWith(
        { from: '2026-09-01' },
        expect.any(AbortSignal),
      )
      // Nothing is written by looking.
      expect(api.applyTimeRoundingRecalculation).not.toHaveBeenCalled()

      const apply = document.querySelector<HTMLButtonElement>('[data-rounding-apply]')!
      expect(apply.hidden).toBe(false)
      expect(apply.textContent).toBe('Apply to 2 entries')
      apply.click()

      await vi.waitFor(() =>
        expect(api.applyTimeRoundingRecalculation).toHaveBeenCalledWith(
          { fingerprint: 'a'.repeat(64), from: '2026-09-01' },
          expect.any(AbortSignal),
        ),
      )
      await vi.waitFor(() =>
        expect(document.querySelector('[data-rounding-recalculate-result]')?.textContent).toBe(
          'Recalculated 2 entries.',
        ),
      )
      expect(apply.hidden).toBe(true)
      expect(document.querySelector('[data-rounding-preview-output]')?.textContent).toBe('')
    })

    it('[unit] offers no apply when nothing would change', async () => {
      stubModulesEndpoint()
      openCompanySettings('time')
      const api = roundingApi()
      api.previewTimeRoundingRecalculation.mockResolvedValueOnce(
        preview({ changed_entries: 0, projects: [], rounded_seconds_before: 0, rounded_seconds_after: 0 }),
      )
      await mountShell(api)
      await vi.waitFor(() =>
        expect(document.querySelector<HTMLElement>('[data-rounding-recalculate]')!.hidden).toBe(false),
      )
      click('[data-rounding-preview]')
      await vi.waitFor(() =>
        expect(document.querySelector('[data-rounding-preview-output]')?.textContent).toContain(
          "Nothing to recalculate: the open entries already hold the hours today's rules give.",
        ),
      )
      expect(document.querySelector<HTMLElement>('[data-rounding-apply]')!.hidden).toBe(true)
    })

    it('[unit] drops a preview when the range or the rule moves under it', async () => {
      stubModulesEndpoint()
      openCompanySettings('time')
      const api = roundingApi()
      await mountShell(api)
      await vi.waitFor(() =>
        expect(document.querySelector<HTMLElement>('[data-rounding-recalculate]')!.hidden).toBe(false),
      )
      click('[data-rounding-preview]')
      await vi.waitFor(() =>
        expect(document.querySelector<HTMLElement>('[data-rounding-apply]')!.hidden).toBe(false),
      )
      const to = document.querySelector<HTMLInputElement>('[data-rounding-to]')!
      to.value = '2026-09-30'
      to.dispatchEvent(new Event('input', { bubbles: true }))
      expect(document.querySelector<HTMLElement>('[data-rounding-apply]')!.hidden).toBe(true)

      click('[data-rounding-preview]')
      await vi.waitFor(() =>
        expect(document.querySelector<HTMLElement>('[data-rounding-apply]')!.hidden).toBe(false),
      )
      submit('[data-rounding-form]')
      await vi.waitFor(() =>
        expect(document.querySelector<HTMLElement>('[data-rounding-apply]')!.hidden).toBe(true),
      )
      expect(document.querySelector('[data-rounding-preview-output]')?.textContent).toBe('')
    })

    it('[unit] reports a stale preview and asks for a new one', async () => {
      stubModulesEndpoint()
      openCompanySettings('time')
      const api = roundingApi()
      api.applyTimeRoundingRecalculation.mockRejectedValueOnce(
        new EzactoApiError(409, { error: { code: 'preview_stale' } }, 'req-409'),
      )
      await mountShell(api)
      await vi.waitFor(() =>
        expect(document.querySelector<HTMLElement>('[data-rounding-recalculate]')!.hidden).toBe(false),
      )
      click('[data-rounding-preview]')
      await vi.waitFor(() =>
        expect(document.querySelector<HTMLElement>('[data-rounding-apply]')!.hidden).toBe(false),
      )
      click('[data-rounding-apply]')
      await vi.waitFor(() =>
        expect(document.querySelector('[data-rounding-recalculate-result]')?.textContent).toBe(
          'The open entries changed since that preview, so nothing was recalculated. Preview again.',
        ),
      )
      expect(document.querySelector<HTMLElement>('[data-rounding-apply]')!.hidden).toBe(true)
    })

    it('[unit] hides the controls on a build without the routes', async () => {
      stubModulesEndpoint()
      openCompanySettings('time')
      const api = companyApi()
      await mountShell(api)
      await vi.waitFor(() =>
        expect(document.querySelector<HTMLElement>('[data-note-settings-form]')!.hidden).toBe(false),
      )
      expect(document.querySelector<HTMLElement>('[data-rounding-form]')!.hidden).toBe(true)
      expect(document.querySelector<HTMLElement>('[data-rounding-recalculate]')!.hidden).toBe(true)
    })
  })
})
