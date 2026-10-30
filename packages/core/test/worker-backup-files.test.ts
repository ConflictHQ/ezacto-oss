import { describe, expect, it } from 'vitest'
import { workerBackupFiles, WORKER_BACKUP_FILE_MAX_BYTES } from '../src/worker-backup-files.js'
const hash = 'ab'.repeat(32)
const receipt = { sha256: hash, byte_size: 12 }
const schema = { 'schema.json': receipt }
describe('Worker backup file manifest', () => {
  it('supports legacy absence and preserves validated schema, rows and content-addressed attachment receipts', () => {
    expect(workerBackupFiles(undefined)).toEqual([])
    const files = {
      ...schema,
      'rows/users/000001.json': { ...receipt, byte_size: 0 },
      [`attachments/sha256/ab/${hash}`]: receipt
    }
    expect(workerBackupFiles(files).map((file) => file.name)).toEqual(Object.keys(files).sort())
  })
  it.each([
    null,
    [],
    {},
    { ...schema, '../outside': receipt },
    { ...schema, 'rows/../000001.json': receipt },
    { ...schema, 'rows/users/1.json': receipt },
    { ...schema, [`attachments/sha256/aa/${hash}`]: receipt },
    { ...schema, [`attachments/sha256/ab/${hash}`]: { ...receipt, sha256: 'cd'.repeat(32) } },
    { 'schema.json': { ...receipt, byte_size: WORKER_BACKUP_FILE_MAX_BYTES + 1 } },
    { 'schema.json': { ...receipt, byte_size: 1.5 } },
    { 'schema.json': { ...receipt, byte_size: -1 } },
    { 'schema.json': { ...receipt, unexpected: true } }
  ])('rejects malformed, oversized and unsafe descriptors', (value) => {
    expect(() => workerBackupFiles(value)).toThrow('invalid file descriptors')
  })
  it('does not inherit a required schema descriptor from a prototype', () => {
    const files = Object.assign(Object.create(schema) as Record<string, unknown>, {
      'rows/users/000001.json': receipt
    })
    expect(() => workerBackupFiles(files)).toThrow()
  })
})
