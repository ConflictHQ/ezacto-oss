/**
 * A sentence carried across one navigation.
 *
 * The full-page editors save and then go back to the page they were opened
 * from, and the page they land on is a fresh document: the result of the save
 * has to travel with the navigation, or it is said to nobody. So it is left in
 * session storage, addressed to the path it is for, and taken once on arrival
 * -- a refresh does not say it again, and a notice that arrives somewhere other
 * than where it was sent is dropped rather than shown out of context.
 *
 * Storage that refuses (private mode, a disabled quota) costs the sentence and
 * nothing else: the save has already happened, and the page it lands on shows
 * the saved values either way.
 */

const STORAGE_KEY = 'ezacto.page-notice'

export const leavePageNotice = (pathname: string, message: string): void => {
  try {
    globalThis.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ pathname, message }))
  } catch {
    // See above: the notice is a courtesy, never a dependency.
  }
}

export const takePageNotice = (pathname: string): string | null => {
  try {
    const raw = globalThis.sessionStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    globalThis.sessionStorage.removeItem(STORAGE_KEY)
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const target = Reflect.get(parsed, 'pathname')
    const message = Reflect.get(parsed, 'message')
    return target === pathname && typeof message === 'string' && message !== '' ? message : null
  } catch {
    return null
  }
}
