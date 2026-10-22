/** The bounded, credential-free handoff from a Cloudflare operator to the loader. */
export const queuedMigrationLimits = {
  metadataBytes: 2 * 1024 * 1024,
  catalogBytes: 1024 * 1024,
  optionsBytes: 256 * 1024,
  rawBytes: 256 * 1024 * 1024,
  binaryBytes: 16 * 1024 * 1024,
  lineBytes: 1024 * 1024,
  files: 8192,
  indexBytes: 4 * 1024 * 1024,
  maxIndexBytes: 8 * 1024 * 1024,
} as const
export interface MigrationSnapshotFile {
  path: string
  bytes: number
  sha256: string
  etag: string
  maxLineBytes?: number
}
export interface MigrationSnapshotCatalog {
  version: 1
  jobId: string
  snapshotSha256: string
  manifestSha256: string
  checksumsSha256: string
  sourceFingerprint: string
  sourceRows: number
  indexBytes: number
  files: readonly MigrationSnapshotFile[]
}
export type MigrationLoadState =
  'ready' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
export interface MigrationLoadOptions {
  organizationCurrency?: string
  organizationAddress?: string | null
  userIdentity?: {
    aliases?: readonly { duplicate: number; canonical: number }[]
    workEmails?: readonly { user: number; address: string }[]
  }
}
export interface MigrationLoadStatus {
  id: string
  status: MigrationLoadState
  snapshotSha256: string
  sourceRows: number
  resource: string | null
  rowsDone: number
  sequence: number
  attempts: number
  errorCode: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  sourceCleanedAt: string | null
  updatedAt: string
}
export interface MigrationLoadMessage {
  kind: 'migration-load-v1'
  runId: string
  sequence: number
}
export class QueuedMigrationError extends Error {
  constructor(
    readonly code: string,
    readonly field = 'snapshot',
  ) {
    super('The queued migration input, identity or limits could not be verified.')
    this.name = 'QueuedMigrationError'
  }
}
export const isMigrationLoadId = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value)
export const migrationInputPrefix = (id: string): string => {
  if (!isMigrationLoadId(id)) throw new QueuedMigrationError('invalid_migration_id', 'id')
  return `migrate/${id}/input/`
}
export const isMigrationSnapshotPath = (path: unknown): path is string =>
  typeof path === 'string' &&
  (path === 'manifest.json' ||
    path === 'checksums.json' ||
    /^raw\/[a-z][a-z0-9_]*(?:\.lineage)?\.jsonl$/.test(path) ||
    /^(?:receipts|avatars|invoice-pdfs)\/[a-f0-9]{64}(?:\.[a-zA-Z0-9]{1,10})?$/.test(path))
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const digest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const integer = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
export const parseMigrationSnapshotCatalog = (value: unknown): MigrationSnapshotCatalog => {
  const invalid = (field: string): never => {
    throw new QueuedMigrationError('invalid_migration_snapshot', field)
  }
  if (!object(value) || value.version !== 1 || !isMigrationLoadId(value.jobId))
    return invalid('catalog')
  const keys = [
    'version',
    'jobId',
    'snapshotSha256',
    'manifestSha256',
    'checksumsSha256',
    'sourceFingerprint',
    'sourceRows',
    'indexBytes',
    'files',
  ]
  if (Object.keys(value).some((key) => !keys.includes(key))) return invalid('catalog')
  for (const name of ['snapshotSha256', 'manifestSha256', 'checksumsSha256', 'sourceFingerprint'])
    if (!digest(value[name])) return invalid(name)
  if (!integer(value.sourceRows) || !integer(value.indexBytes, queuedMigrationLimits.maxIndexBytes))
    return invalid('counts')
  if (
    !Array.isArray(value.files) ||
    value.files.length < 2 ||
    value.files.length > queuedMigrationLimits.files
  )
    return invalid('files')
  const files: MigrationSnapshotFile[] = [],
    seen = new Set<string>()
  for (const [index, file] of value.files.entries()) {
    const field = `files.${index}`
    if (
      !object(file) ||
      Object.keys(file).some(
        (key) => !['path', 'bytes', 'sha256', 'etag', 'maxLineBytes'].includes(key),
      ) ||
      !isMigrationSnapshotPath(file.path) ||
      seen.has(file.path) ||
      !digest(file.sha256) ||
      typeof file.etag !== 'string' ||
      !/^[A-Za-z0-9._-]{1,128}$/.test(file.etag)
    )
      return invalid(field)
    const raw = file.path.startsWith('raw/'),
      metadata = file.path === 'manifest.json' || file.path === 'checksums.json'
    const maximum = raw
      ? queuedMigrationLimits.rawBytes
      : metadata
        ? queuedMigrationLimits.metadataBytes
        : queuedMigrationLimits.binaryBytes
    if (
      !integer(file.bytes, maximum) ||
      (raw
        ? !integer(file.maxLineBytes, queuedMigrationLimits.lineBytes)
        : file.maxLineBytes !== undefined)
    )
      return invalid(field + '.bytes')
    if (!raw && !metadata && file.path.split('/')[1]!.split('.')[0] !== file.sha256)
      return invalid(field + '.sha256')
    seen.add(file.path)
    files.push({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
      etag: file.etag,
      ...(raw ? { maxLineBytes: file.maxLineBytes as number } : {}),
    })
  }
  const manifest = files.find((file) => file.path === 'manifest.json'),
    checksums = files.find((file) => file.path === 'checksums.json')
  if (manifest?.sha256 !== value.manifestSha256 || checksums?.sha256 !== value.checksumsSha256)
    return invalid('metadata')
  if (new TextEncoder().encode(JSON.stringify(value)).length > queuedMigrationLimits.catalogBytes)
    return invalid('catalog.bytes')
  return {
    version: 1,
    jobId: value.jobId,
    snapshotSha256: value.snapshotSha256 as string,
    manifestSha256: value.manifestSha256 as string,
    checksumsSha256: value.checksumsSha256 as string,
    sourceFingerprint: value.sourceFingerprint as string,
    sourceRows: value.sourceRows,
    indexBytes: value.indexBytes,
    files,
  }
}
export const parseMigrationLoadMessage = (value: unknown): MigrationLoadMessage => {
  if (
    !object(value) ||
    Object.keys(value).some((key) => !['kind', 'runId', 'sequence'].includes(key)) ||
    value.kind !== 'migration-load-v1' ||
    !isMigrationLoadId(value.runId) ||
    !integer(value.sequence)
  )
    throw new QueuedMigrationError('invalid_migration_message', 'message')
  return { kind: 'migration-load-v1', runId: value.runId, sequence: value.sequence }
}

/** Only explicit loader decisions cross the queue boundary; provider credentials never do. */
export const parseMigrationLoadOptions = (value: unknown): MigrationLoadOptions => {
  const invalid = (): never => {
    throw new QueuedMigrationError('invalid_migration_options', 'options')
  }
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) => !['organizationCurrency', 'organizationAddress', 'userIdentity'].includes(key),
    )
  )
    return invalid()
  if (new TextEncoder().encode(JSON.stringify(value)).length > queuedMigrationLimits.optionsBytes)
    return invalid()
  const result: MigrationLoadOptions = {}
  if (value.organizationCurrency !== undefined) {
    if (
      typeof value.organizationCurrency !== 'string' ||
      !/^[A-Za-z]{3}$/.test(value.organizationCurrency)
    )
      return invalid()
    result.organizationCurrency = value.organizationCurrency.toUpperCase()
  }
  if (value.organizationAddress !== undefined) {
    if (
      value.organizationAddress !== null &&
      (typeof value.organizationAddress !== 'string' || value.organizationAddress.length > 4000)
    )
      return invalid()
    result.organizationAddress = value.organizationAddress
  }
  if (value.userIdentity !== undefined) {
    const identity = value.userIdentity
    if (
      !object(identity) ||
      Object.keys(identity).some((key) => !['aliases', 'workEmails'].includes(key))
    )
      return invalid()
    const aliases: { duplicate: number; canonical: number }[] = [],
      workEmails: { user: number; address: string }[] = []
    for (const key of ['aliases', 'workEmails'])
      if (
        identity[key] !== undefined &&
        (!Array.isArray(identity[key]) || identity[key].length > 10000)
      )
        return invalid()
    const duplicates = new Set<number>(),
      addresses = new Map<string, number>()
    for (const alias of (identity.aliases ?? []) as unknown[]) {
      if (
        !object(alias) ||
        Object.keys(alias).some((key) => !['duplicate', 'canonical'].includes(key)) ||
        !integer(alias.duplicate) ||
        alias.duplicate === 0 ||
        !integer(alias.canonical) ||
        alias.canonical === 0 ||
        alias.duplicate === alias.canonical ||
        duplicates.has(alias.duplicate)
      )
        return invalid()
      duplicates.add(alias.duplicate)
      aliases.push({ duplicate: alias.duplicate, canonical: alias.canonical })
    }
    if (aliases.some((alias) => duplicates.has(alias.canonical))) return invalid()
    for (const email of (identity.workEmails ?? []) as unknown[]) {
      if (
        !object(email) ||
        Object.keys(email).some((key) => !['user', 'address'].includes(key)) ||
        !integer(email.user) ||
        email.user === 0 ||
        duplicates.has(email.user) ||
        typeof email.address !== 'string' ||
        email.address.trim().length === 0 ||
        email.address.length > 254
      )
        return invalid()
      const address = email.address.trim(),
        key = address.toLowerCase(),
        claimant = addresses.get(key)
      if (claimant !== undefined && claimant !== email.user) return invalid()
      if (claimant === undefined) workEmails.push({ user: email.user, address })
      addresses.set(key, email.user)
    }
    result.userIdentity = { aliases, workEmails }
  }
  return result
}
