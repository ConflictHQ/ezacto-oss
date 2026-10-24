/** Server-rendered runtime capability: hosted tenants are backed up by the platform (issue 1216). */
export const backupsAvailable = (): boolean =>
  !document.documentElement.hasAttribute('data-backups-unavailable')
