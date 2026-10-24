/** Server-rendered runtime capability, available before cached identity resumes. */
export const accountingAvailable = (): boolean =>
  !document.documentElement.hasAttribute('data-accounting-unavailable')
