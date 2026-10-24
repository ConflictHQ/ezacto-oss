import { describe, expect, it } from 'vitest'
import { backupsEnabled } from '../src/backups-enabled.js'

describe('backupsEnabled', () => {
  it('[#1216] is on by default, so self-hosted behaviour is unchanged', () => {
    expect(backupsEnabled({})).toBe(true)
    expect(backupsEnabled({ BACKUPS_ENABLED: '' })).toBe(true)
    expect(backupsEnabled({ BACKUPS_ENABLED: 'true' })).toBe(true)
  })

  it('[#1216] is off only for an explicit false', () => {
    expect(backupsEnabled({ BACKUPS_ENABLED: 'false' })).toBe(false)
  })

  it('[#1216] refuses any other value rather than guessing', () => {
    for (const value of ['0', 'no', 'off', 'False', 'TRUE', 'disabled', '1']) {
      expect(() => backupsEnabled({ BACKUPS_ENABLED: value })).toThrow('BACKUPS_ENABLED')
    }
  })
})
