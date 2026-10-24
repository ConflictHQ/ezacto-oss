/** Server-rendered runtime capability, available before cached identity resumes. */
export const attachmentsAvailable = (): boolean =>
  !document.documentElement.hasAttribute('data-attachments-unavailable')

export const ATTACHMENTS_UNAVAILABLE = 'File attachments are not enabled on this instance.'
