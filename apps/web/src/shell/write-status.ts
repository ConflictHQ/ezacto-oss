import type { PendingWrites } from './net.js'

/**
 * What the shell says while a write is being sent again (issue 953).
 *
 * Nothing shows for a write that lands on its first attempt: that is every
 * save, and a status flashing on each one would be noise. It shows once a write
 * has failed and is waiting for another attempt, and stays until that write
 * lands or is given up on, which is when the screen that sent it says which.
 */
export const writeStatusMessage = (retrying: number): string =>
  retrying === 1 ? 'Saving… retrying' : `Saving ${retrying} changes… retrying`

/**
 * Binds the status line to the page's writes, and holds the page open while
 * any of them is unsent.
 *
 * Leaving cuts off a write still in flight as surely as a dropped connection
 * does, and a closed page cannot retry it. So the browser asks first, for a
 * write on its first attempt as much as for one being retried.
 */
export const bindWriteStatus = (
  status: HTMLElement,
  message: HTMLElement,
  writes: PendingWrites,
  page: Pick<Window, 'addEventListener'> = globalThis.window,
): void => {
  const render = (): void => {
    status.hidden = writes.retrying === 0
    if (writes.retrying > 0) message.textContent = writeStatusMessage(writes.retrying)
  }
  writes.subscribe(render)
  render()
  page.addEventListener('beforeunload', (event) => {
    if (writes.unsent === 0) return
    event.preventDefault()
    // Some browsers still ask only when a return value is set.
    event.returnValue = ''
  })
}
