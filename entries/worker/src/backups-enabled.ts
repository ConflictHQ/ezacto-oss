/**
 * Whether this deployment offers its own backup feature (issue 1216).
 *
 * On unless `BACKUPS_ENABLED` is exactly `false`, so a self-hosted install
 * behaves as it always has. A hosted tenant is backed up by the platform and
 * sets it off, because two backup paths invite confusion about which one is
 * authoritative. Anything other than unset, blank, `true` or `false` is
 * refused rather than read as one of them: an operator who set it meant
 * something, and guessing "on" would offer a mechanism they turned off.
 */
export const backupsEnabled = (env: { BACKUPS_ENABLED?: string }): boolean => {
  const value = env.BACKUPS_ENABLED?.trim()
  if (value === undefined || value === '' || value === 'true') return true
  if (value === 'false') return false
  throw new TypeError('BACKUPS_ENABLED must be true or false')
}
