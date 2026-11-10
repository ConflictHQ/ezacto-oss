import { DeelApiError } from './client.js'

/** Persist only bounded provider status; arbitrary errors may contain credentials. */
export const safeDeelFailure = (error: unknown): string => {
  try {
    if (error instanceof DeelApiError) {
      const status = Object.getOwnPropertyDescriptor(error, 'status')?.value
      if (typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599)
        return `Deel request failed with status ${status}`
    }
  } catch { /* An untrusted error or proxy cannot alter failure reporting. */ }
  return 'Deel synchronization failed; retry or inspect the connection.'
}
