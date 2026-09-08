import { describe, expect, it, vi } from 'vitest'
import { sessionPresenter } from '../src/session.js'

describe('session presenter', () => {
  it('paints for the session on screen and answers that it did', () => {
    const paint = vi.fn()
    const presenter = sessionPresenter(() => true, () => false)

    expect(presenter.present(paint)).toBe(true)
    expect(paint).toHaveBeenCalledTimes(1)
  })

  it('[security] drops a paint from a session that is no longer on screen', () => {
    let current = true
    const paint = vi.fn()
    const presenter = sessionPresenter(() => current, () => false)

    current = false

    expect(presenter.present(paint)).toBe(false)
    expect(paint).not.toHaveBeenCalled()
  })

  it('[security] neither paints nor reports a failure once the session has ended', () => {
    // The old boolean returned false for an ended session, which read at the
    // call site as "not handled -- carry on and paint". Both halves have to
    // stop: the write, and the report that could sign the next user out.
    const paint = vi.fn()
    const onSessionFailure = vi.fn(() => false)
    const presenter = sessionPresenter(() => false, onSessionFailure)

    expect(presenter.presentFailure(new Error('stale'), paint)).toBe(false)
    expect(paint).not.toHaveBeenCalled()
    expect(onSessionFailure).not.toHaveBeenCalled()
  })

  it('paints a failure the shell declines to take over', () => {
    const paint = vi.fn()
    const onSessionFailure = vi.fn(() => false)
    const presenter = sessionPresenter(() => true, onSessionFailure)
    const error = new Error('The list could not be loaded.')

    expect(presenter.presentFailure(error, paint)).toBe(true)
    expect(onSessionFailure).toHaveBeenCalledWith(error)
    expect(paint).toHaveBeenCalledTimes(1)
  })

  it('[security] leaves the page to the shell when the shell takes the failure over', () => {
    // A 401 signs the session out and puts the sign-in screen up. Writing the
    // error into the page after that addresses it to whoever is there next.
    const paint = vi.fn()
    const presenter = sessionPresenter(() => true, () => true)

    expect(presenter.presentFailure(new Error('Unauthorized'), paint)).toBe(false)
    expect(paint).not.toHaveBeenCalled()
  })
})
