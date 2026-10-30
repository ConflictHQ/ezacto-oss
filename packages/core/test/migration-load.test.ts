import { expect, it } from 'vitest'
import {
  parseMigrationSnapshotCatalog,
  parseMigrationLoadMessage,
  queuedMigrationLimits,
  migrationInputPrefix,
  parseMigrationLoadOptions,
} from '../src/migration-load.js'
const id = '00000000-0000-4000-8000-000000000001'
const catalog = () => ({
  version: 1,
  jobId: id,
  snapshotSha256: '1'.repeat(64),
  manifestSha256: '2'.repeat(64),
  checksumsSha256: '3'.repeat(64),
  sourceFingerprint: '4'.repeat(64),
  sourceRows: 1,
  indexBytes: 111,
  files: [
    { path: 'manifest.json', bytes: 2, sha256: '2'.repeat(64), etag: 'manifest' },
    { path: 'checksums.json', bytes: 2, sha256: '3'.repeat(64), etag: 'checksums' },
    { path: 'raw/users.jsonl', bytes: 20, sha256: '5'.repeat(64), etag: 'users', maxLineBytes: 19 },
  ],
})
it('accepts explicit identity decisions without accepting credential-bearing options', () => {
  expect(
    parseMigrationLoadOptions({
      organizationCurrency: 'usd',
      userIdentity: {
        aliases: [{ duplicate: 2, canonical: 1 }],
        workEmails: [{ user: 1, address: ' work@example.test ' }],
      },
    }),
  ).toEqual({
    organizationCurrency: 'USD',
    userIdentity: {
      aliases: [{ duplicate: 2, canonical: 1 }],
      workEmails: [{ user: 1, address: 'work@example.test' }],
    },
  })
  for (const value of [
    { token: 'secret' },
    { userIdentity: { token: 'secret' } },
    { userIdentity: { aliases: [{ duplicate: 2, canonical: 1, token: 'secret' }] } },
    {
      userIdentity: {
        aliases: [
          { duplicate: 2, canonical: 1 },
          { duplicate: 1, canonical: 3 },
        ],
      },
    },
    {
      userIdentity: {
        aliases: [{ duplicate: 2, canonical: 1 }],
        workEmails: [{ user: 2, address: 'work@example.test' }],
      },
    },
    {
      userIdentity: {
        workEmails: [
          { user: 1, address: 'same@example.test' },
          { user: 2, address: 'SAME@example.test' },
        ],
      },
    },
  ])
    expect(() => parseMigrationLoadOptions(value)).toThrow()
})
it('binds a bounded credential-free catalog to one run and its metadata identities', () => {
  const parsed = parseMigrationSnapshotCatalog(catalog())
  expect(parsed.jobId).toBe(id)
  expect(parsed.files).toHaveLength(3)
  expect(migrationInputPrefix(id)).toBe(`migrate/${id}/input/`)
  expect(() =>
    parseMigrationSnapshotCatalog({ ...catalog(), manifestSha256: '0'.repeat(64) }),
  ).toThrow()
})
it('rejects extra credential fields, arbitrary files and path traversal', () => {
  for (const value of [
    { ...catalog(), accessToken: 'private-provider-value' },
    {
      ...catalog(),
      files: [
        ...catalog().files,
        { path: 'auth.json', bytes: 1, sha256: '1'.repeat(64), etag: 'auth' },
      ],
    },
    {
      ...catalog(),
      files: [
        ...catalog().files,
        { path: '../.dev.vars', bytes: 1, sha256: '1'.repeat(64), etag: 'escape' },
      ],
    },
  ])
    expect(() => parseMigrationSnapshotCatalog(value)).toThrow()
  expect(() => migrationInputPrefix('../escape')).toThrow()
})
it('refuses duplicate entries, unsafe etags and oversized raw/binary/metadata inputs', () => {
  expect(() =>
    parseMigrationSnapshotCatalog({
      ...catalog(),
      files: [...catalog().files, catalog().files[0]],
    }),
  ).toThrow()
  for (const patch of [
    { bytes: queuedMigrationLimits.metadataBytes + 1 },
    { etag: 'unsafe\r\nheader' },
  ]) {
    const value = catalog()
    value.files[0] = { ...value.files[0]!, ...patch }
    expect(() => parseMigrationSnapshotCatalog(value)).toThrow()
  }
  const value = catalog()
  value.files[2] = { ...value.files[2]!, maxLineBytes: queuedMigrationLimits.lineBytes + 1 }
  expect(() => parseMigrationSnapshotCatalog(value)).toThrow()
  expect(() =>
    parseMigrationSnapshotCatalog({
      ...catalog(),
      indexBytes: queuedMigrationLimits.maxIndexBytes + 1,
    }),
  ).toThrow()
})
it('permits only content-addressed declared binary paths', () => {
  const file = {
    path: `receipts/${'6'.repeat(64)}.pdf`,
    bytes: 128,
    sha256: '6'.repeat(64),
    etag: 'binary',
  }
  expect(
    parseMigrationSnapshotCatalog({ ...catalog(), files: [...catalog().files, file] }).files,
  ).toHaveLength(4)
  expect(() =>
    parseMigrationSnapshotCatalog({
      ...catalog(),
      files: [...catalog().files, { ...file, sha256: '7'.repeat(64) }],
    }),
  ).toThrow()
})
it('queue messages contain only the versioned kind, run id and nonnegative sequence', () => {
  expect(parseMigrationLoadMessage({ kind: 'migration-load-v1', runId: id, sequence: 0 })).toEqual({
    kind: 'migration-load-v1',
    runId: id,
    sequence: 0,
  })
  for (const patch of [
    { kind: 'email' },
    { sequence: -1 },
    { sequence: 0.5 },
    { runId: '../target' },
    { credentials: 'never' },
  ])
    expect(() =>
      parseMigrationLoadMessage({ kind: 'migration-load-v1', runId: id, sequence: 0, ...patch }),
    ).toThrow()
})
