/** Additional authenticated plaintext members of a restorable Worker backup. */
export interface WorkerBackupFileReceipt {
  sha256: string
  byte_size: number
}
export interface WorkerBackupFileEntry extends WorkerBackupFileReceipt {
  name: string
}
export const WORKER_BACKUP_FILE_MAX_BYTES = 16 * 1024 * 1024
export const WORKER_BACKUP_FILE_MAX_COUNT = 65530
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const invalid = (): never => {
  throw new Error('The backup manifest contains invalid file descriptors.')
}
/** Undefined is the legacy export format. Present descriptors must be complete and safe. */
export const workerBackupFiles = (value: unknown): readonly WorkerBackupFileEntry[] => {
  if (value === undefined) return []
  if (!record(value)) return invalid()
  const names = Object.keys(value).sort()
  if (
    names.length === 0 ||
    names.length > WORKER_BACKUP_FILE_MAX_COUNT ||
    !Object.hasOwn(value, 'schema.json')
  )
    return invalid()
  return names.map((name) => {
    if (name.length > 512) return invalid()
    const attachment = /^attachments\/sha256\/([0-9a-f]{2})\/([0-9a-f]{64})$/.exec(name)
    if (
      name !== 'schema.json' &&
      !/^rows\/[A-Za-z0-9_]+\/[0-9]{6}\.json$/.test(name) &&
      !attachment
    )
      return invalid()
    const receipt = value[name]
    if (
      !record(receipt) ||
      Object.keys(receipt).length !== 2 ||
      !Object.hasOwn(receipt, 'sha256') ||
      !Object.hasOwn(receipt, 'byte_size') ||
      typeof receipt.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(receipt.sha256) ||
      !Number.isSafeInteger(receipt.byte_size) ||
      (receipt.byte_size as number) < 0 ||
      (receipt.byte_size as number) > WORKER_BACKUP_FILE_MAX_BYTES
    )
      return invalid()
    if (
      attachment &&
      (attachment[1] !== attachment[2]!.slice(0, 2) || attachment[2] !== receipt.sha256)
    )
      return invalid()
    return { name, sha256: receipt.sha256, byte_size: receipt.byte_size as number }
  })
}
