/** @vitest-environment happy-dom */
import { Storage } from 'happy-dom'
import { describe, expect, it, vi } from 'vitest'

describe('browser storage environment', () => {
  it('[security #469] uses isolated DOM storage rather than Node host storage', () => {
    expect(globalThis.localStorage).toBeInstanceOf(Storage)
    expect(globalThis.sessionStorage).toBeInstanceOf(Storage)
    expect(window.localStorage).toBe(globalThis.localStorage)
    localStorage.setItem('isolation-proof', 'local')
    expect(sessionStorage.getItem('isolation-proof')).toBeNull()
    expect(localStorage.getItem('isolation-proof')).toBe('local')
    localStorage.clear()
    expect(localStorage.length).toBe(0)
  })

  it('[security #469] restores valid DOM storage after a test simulates storage failure', () => {
    const original = globalThis.localStorage
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('Storage unavailable') } })
    vi.unstubAllGlobals()
    expect(globalThis.localStorage).toBe(original)
    expect(() => globalThis.localStorage.clear()).not.toThrow()
  })
})
