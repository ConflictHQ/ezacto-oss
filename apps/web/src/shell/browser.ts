import { EzactoApiError } from '@ezacto/client'
import {
  createSameOriginShellApi,
  loadShellSnapshot,
  navigationDestination,
  quickAdd,
  runningElapsedSeconds,
  startTimer,
  type DisplayTimeEntry,
  type ShellApi,
  type ShellSnapshot,
} from './model.js'

const required = <ElementType extends Element>(
  selector: string,
): ElementType => {
  const element = document.querySelector<ElementType>(selector)
  if (element === null) throw new Error(`shell element missing: ${selector}`)
  return element
}

const formatSeconds = (seconds: number): string => {
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  return `${hours}:${String(minutes).padStart(2, '0')}`
}

const cell = (value: string): HTMLTableCellElement => {
  const element = document.createElement('td')
  element.textContent = value
  return element
}

const renderRows = (entries: readonly DisplayTimeEntry[]): void => {
  const rows = required<HTMLTableSectionElement>('[data-entry-rows]')
  if (entries.length === 0) {
    const row = document.createElement('tr')
    const empty = cell(
      'No time logged this week. Press ⌘K to add the first entry.',
    )
    empty.colSpan = 5
    row.append(empty)
    rows.replaceChildren(row)
    return
  }
  rows.replaceChildren(
    ...entries.map((entry) => {
      const row = document.createElement('tr')
      if (entry.is_running) row.dataset.running = 'true'
      row.append(
        cell(entry.project_label),
        cell(entry.task_label),
        cell(entry.spent_date),
        cell(formatSeconds(entry.seconds)),
        cell(entry.is_running ? 'Running' : entry.approval_status),
      )
      return row
    }),
  )
}

let timerInterval: ReturnType<typeof globalThis.setInterval> | undefined

const renderTimer = (running: DisplayTimeEntry | null): void => {
  const chip = required<HTMLButtonElement>('[data-timer-chip]')
  const label = required<HTMLElement>('[data-timer-label]')
  const elapsed = required<HTMLElement>('[data-timer-elapsed]')
  if (timerInterval !== undefined) globalThis.clearInterval(timerInterval)
  if (running === null) {
    chip.dataset.state = 'stopped'
    label.textContent = 'Start timer'
    elapsed.textContent = '0:00'
    return
  }
  chip.dataset.state = 'running'
  label.textContent = `${running.project_label} / ${running.task_label}`
  const update = (): void => {
    elapsed.textContent = formatSeconds(runningElapsedSeconds(running))
  }
  update()
  timerInterval = globalThis.setInterval(update, 1_000)
}

const renderSnapshot = (snapshot: ShellSnapshot): void => {
  renderRows(snapshot.entries)
  renderTimer(snapshot.running)
  required<HTMLElement>('[data-week-total]').textContent = formatSeconds(
    snapshot.entries.reduce((total, entry) => total + entry.seconds, 0),
  )
}

const messageFor = (error: unknown): string => {
  if (error instanceof EzactoApiError && error.status === 401)
    return 'Sign in is required.'
  return error instanceof Error
    ? error.message
    : 'The request could not be completed.'
}

const open = (dialog: HTMLDialogElement): void => {
  if (!dialog.open) dialog.showModal()
}

export const mountShell = async (
  api: ShellApi = createSameOriginShellApi(),
): Promise<void> => {
  const status = required<HTMLElement>('[data-session-status]')
  const commandDialog = required<HTMLDialogElement>('[data-command-dialog]')
  const timerDialog = required<HTMLDialogElement>('[data-timer-dialog]')
  const menuDialog = required<HTMLDialogElement>('[data-menu-dialog]')
  const commandForm = required<HTMLFormElement>('[data-command-form]')
  const timerForm = required<HTMLFormElement>('[data-timer-form]')
  let snapshot: ShellSnapshot | null = null

  const refresh = async (): Promise<void> => {
    snapshot = await loadShellSnapshot(api)
    renderSnapshot(snapshot)
  }

  for (const trigger of document.querySelectorAll<HTMLElement>(
    '[data-command-trigger]',
  )) {
    trigger.addEventListener('click', () => open(commandDialog))
  }
  required<HTMLButtonElement>('[data-timer-chip]').addEventListener(
    'click',
    () => open(timerDialog),
  )
  required<HTMLButtonElement>('[data-menu-trigger]').addEventListener(
    'click',
    () => open(menuDialog),
  )
  for (const close of document.querySelectorAll<HTMLButtonElement>(
    '[data-dialog-close]',
  )) {
    close.addEventListener('click', () => close.closest('dialog')?.close())
  }
  document.addEventListener('keydown', (event) => {
    if (
      (event.metaKey || event.ctrlKey) &&
      event.key.toLocaleLowerCase('en-US') === 'k'
    ) {
      event.preventDefault()
      open(commandDialog)
    }
  })

  commandForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const result = required<HTMLElement>('[data-command-result]')
    const command = new FormData(commandForm).get('command')
    if (typeof command !== 'string') return
    const destination = navigationDestination(command)
    if (destination !== null) {
      globalThis.location.assign(destination)
      return
    }
    result.textContent = 'Logging time…'
    void quickAdd(api, command)
      .then(async (entry) => {
        await refresh()
        result.textContent = `Logged ${formatSeconds(entry.seconds)}.`
        document.dispatchEvent(
          new CustomEvent('ezacto:time-entry-created', { detail: entry }),
        )
      })
      .catch((error: unknown) => {
        result.textContent = messageFor(error)
      })
  })

  timerForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const result = required<HTMLElement>('[data-timer-result]')
    const form = new FormData(timerForm)
    const project = form.get('project')
    const task = form.get('task')
    if (typeof project !== 'string' || typeof task !== 'string') return
    result.textContent = 'Starting timer…'
    void startTimer(api, project, task)
      .then(async (entry) => {
        await refresh()
        result.textContent = 'Timer started.'
        document.dispatchEvent(
          new CustomEvent('ezacto:time-entry-created', { detail: entry }),
        )
      })
      .catch((error: unknown) => {
        result.textContent = messageFor(error)
      })
  })

  required<HTMLButtonElement>('[data-stop-timer]').addEventListener(
    'click',
    () => {
      const result = required<HTMLElement>('[data-timer-result]')
      if (snapshot === null || snapshot.running === null) {
        result.textContent = 'No timer is running.'
        return
      }
      result.textContent = 'Stopping timer…'
      void api
        .stopTimeEntry(snapshot.running.id)
        .then(async () => {
          await refresh()
          result.textContent = 'Timer stopped.'
        })
        .catch((error: unknown) => {
          result.textContent = messageFor(error)
        })
    },
  )

  try {
    await api.whoami()
    await refresh()
    status.textContent = 'Connected. Changes save directly to ezacto.'
    status.dataset.state = 'ready'
  } catch (error) {
    const message = messageFor(error)
    status.textContent = `${message} Native browser sessions are the next delivery dependency.`
    status.dataset.state = 'signed-out'
    required<HTMLButtonElement>('[data-timer-chip]').dataset.state =
      'signed-out'
    required<HTMLElement>('[data-timer-label]').textContent = 'Sign in required'
    required<HTMLElement>('[data-timer-elapsed]').textContent = '—'
    renderRows([])
    required<HTMLElement>('[data-week-total]').textContent = '—'
  }
}

document.addEventListener('DOMContentLoaded', () => {
  void mountShell()
})
