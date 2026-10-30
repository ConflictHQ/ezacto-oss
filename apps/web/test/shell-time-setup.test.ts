/** @vitest-environment happy-dom */
import { describe, expect, it, vi } from 'vitest'
import { browserApi, identity, mountShell, renderBrowserShell } from './support/shell-harness.js'

for (const profile of ['administrator', 'member'] as const) {
  describe(`time setup for ${profile}`, () => {
    it('replaces empty Add row selects with role-aware assignment guidance', async () => {
      renderBrowserShell()
      const api = browserApi()
      vi.spyOn(api, 'listTimeEntryOptions').mockResolvedValue([])
      vi.spyOn(api, 'whoami').mockResolvedValue({ ...identity, profile })
      await mountShell(api)
      document.querySelector<HTMLButtonElement>('[data-add-row-trigger]')!.click()
      expect(document.querySelector<HTMLDialogElement>('[data-row-dialog]')!.open).toBe(true)
      expect(document.querySelector<HTMLElement>('[data-row-empty]')!.hidden).toBe(false)
      for (const label of document.querySelectorAll<HTMLElement>('[data-row-selection]')) {
        expect(label.hidden).toBe(true)
      }
      expect(document.querySelector<HTMLButtonElement>('[data-row-submit]')!.hidden).toBe(true)
      const link = document.querySelector<HTMLAnchorElement>('[data-row-setup]')!
      if (profile === 'administrator') {
        expect(link.hidden).toBe(false)
        expect(link.getAttribute('href')).toBe('/projects/1#project-tasks-heading')
        expect(document.querySelector('[data-row-empty-reason]')!.textContent).toContain(
          'Assign task',
        )
      } else {
        expect(link.hidden).toBe(true)
        expect(document.querySelector('[data-row-empty-reason]')!.textContent).toContain(
          'Ask a project manager',
        )
      }
      expect(api.createTimeEntry).not.toHaveBeenCalled()
    })

    it('opens guidance from the enabled timer instead of an empty entry editor', async () => {
      renderBrowserShell()
      const api = browserApi()
      vi.spyOn(api, 'listTimeEntryOptions').mockResolvedValue([])
      vi.spyOn(api, 'whoami').mockResolvedValue({ ...identity, profile })
      await mountShell(api)
      const timer = document.querySelector<HTMLButtonElement>('[data-timer-chip]')!
      expect(timer.disabled).toBe(false)
      timer.click()
      await vi.waitFor(() =>
        expect(document.querySelector<HTMLDialogElement>('[data-row-dialog]')!.open).toBe(true),
      )
      expect(document.querySelector('#row-title')!.textContent).toBe('Start timer')
      expect(document.querySelector('[data-row-empty]')!.textContent).toContain(
        'Set up a project and task',
      )
      expect(document.querySelector<HTMLDialogElement>('[data-entry-dialog]')!.open).toBe(false)
    })
  })
}

it('uses the normal timer editor and creates a running entry once a task is available', async () => {
  renderBrowserShell()
  const api = browserApi()
  await mountShell(api)
  document.querySelector<HTMLButtonElement>('[data-timer-chip]')!.click()
  await vi.waitFor(() =>
    expect(document.querySelector<HTMLDialogElement>('[data-entry-dialog]')!.open).toBe(true),
  )
  document
    .querySelector<HTMLFormElement>('[data-entry-form]')!
    .dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }))
  await vi.waitFor(() => expect(api.createTimeEntry).toHaveBeenCalled())
  expect(api.createTimeEntry).toHaveBeenCalledWith(
    expect.objectContaining({ project_id: 1, task_id: 1 }),
    expect.anything(),
  )
  const input = vi.mocked(api.createTimeEntry).mock.calls[0]![0]
  expect(input.seconds).toBeUndefined()
})

it('clears project names from setup guidance and timer labels at sign-out', async () => {
  renderBrowserShell()
  const api = browserApi()
  vi.spyOn(api, 'listTimeEntryOptions').mockResolvedValue([])
  vi.spyOn(api, 'whoami').mockResolvedValue({ ...identity, profile: 'administrator' })
  await mountShell(api)
  expect(document.querySelector('[data-row-setup]')!.textContent).toContain('Northpeak')
  document.querySelector<HTMLButtonElement>('[data-logout]')!.click()
  await vi.waitFor(() =>
    expect(document.querySelector('[data-row-setup]')!.textContent).toBe('Set up a project'),
  )
  expect(document.querySelector('[data-row-setup]')!.getAttribute('href')).toBe('/projects')
  expect(document.querySelector('[data-timer-chip]')!.getAttribute('aria-label')).toBe('Timer')
})
