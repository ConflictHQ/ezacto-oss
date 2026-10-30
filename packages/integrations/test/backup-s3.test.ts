import { AwsClient } from 'aws4fetch'
import { expect, it, vi } from 'vitest'
import { backupSha256 } from '@ezacto/core'
import { createBackupS3Target } from '../src/backup-s3.js'
const credentials = {
  accessKeyId: 'ezacto-backup-fixture',
  secretAccessKey: 'local-backup-fixture-only',
}
const config = {
  ...credentials,
  endpoint: 'https://s3.example.test',
  region: 'us-east-1',
  bucket: 'backup-fixture',
}
it('verifies server bytes when checksum headers are unavailable and refuses conflicting objects', async () => {
  const bytes = new TextEncoder().encode('encrypted fixture bytes')
  const doFetch = vi.fn<typeof fetch>(async (input) => {
    const request = input as Request
    expect(request.redirect).toBe('manual')
    return request.method === 'HEAD'
      ? new Response(null, { headers: { 'content-length': String(bytes.length) } })
      : new Response(bytes)
  })
  const target = createBackupS3Target(config, { fetch: doFetch })
  expect(await target.ensureObject('prefix/users.csv.ezenc', bytes)).toMatchObject({
    outcome: 'reused',
    sha256: await backupSha256(bytes),
  })
  expect(doFetch.mock.calls.map((call) => (call[0] as Request).method)).toEqual(['HEAD', 'GET'])
  doFetch.mockImplementation(async (input) =>
    (input as Request).method === 'HEAD'
      ? new Response(null, { headers: { 'content-length': String(bytes.length) } })
      : new Response(new Uint8Array(bytes.length)),
  )
  await expect(target.ensureObject('prefix/users.csv.ezenc', bytes)).rejects.toThrow('checksum')
  expect(doFetch.mock.calls.every((call) => (call[0] as Request).method !== 'PUT')).toBe(true)
})
it('fails with actionable E14 errors without exposing provider text or credentials', async () => {
  const target = createBackupS3Target(config, {
    fetch: async () => new Response('secret provider diagnostics', { status: 403 }),
  })
  await expect(target.ensureObject('x', new Uint8Array())).rejects.toMatchObject({
    code: 'E14',
    message: expect.stringContaining('bucket policy'),
  })
  expect(() =>
    createBackupS3Target({ ...config, endpoint: 'https://user:password@s3.example.test' }),
  ).toThrow('without credentials')
  expect(() => createBackupS3Target({ ...config, endpoint: 'http://s3.example.test' })).toThrow(
    'HTTPS',
  )
  await expect(target.ensureObject('../escape', new Uint8Array())).rejects.toThrow('path')
})
const endpoint = process.env.EZACTO_TEST_MINIO_ENDPOINT
it.skipIf(!endpoint)(
  '[native MinIO #38] verifies opaque bytes and resumes an interrupted multi-object upload',
  async () => {
    const bucket = `backup-fixture-${crypto.randomUUID()}`
    const aws = new AwsClient({ ...credentials, region: 'us-east-1', service: 's3', retries: 0 })
    const created = await fetch(await aws.sign(`${endpoint}/${bucket}`, { method: 'PUT' }))
    expect(created.status).toBe(200)
    let interrupted = false,
      puts = 0
    const transport: typeof fetch = async (input, init) => {
      const request = input as Request
      if (request.method === 'PUT') {
        puts += 1
        if (puts === 2 && !interrupted) {
          interrupted = true
          throw new Error('fixture connection loss')
        }
      }
      return fetch(input, init)
    }
    const target = createBackupS3Target(
      { ...config, bucket, endpoint: endpoint! },
      { fetch: transport, allowLoopbackHttp: true },
    )
    const first = crypto.getRandomValues(new Uint8Array(256)),
      second = crypto.getRandomValues(new Uint8Array(128))
    expect(await target.ensureObject('run/first.ezenc', first)).toMatchObject({
      outcome: 'uploaded',
    })
    await expect(target.ensureObject('run/second.ezenc', second)).rejects.toMatchObject({
      code: 'E14',
    })
    expect(await target.ensureObject('run/first.ezenc', first)).toMatchObject({ outcome: 'reused' })
    expect(await target.ensureObject('run/second.ezenc', second)).toMatchObject({
      outcome: 'uploaded',
    })
    expect(puts).toBe(3)
    const download = await fetch(await aws.sign(`${endpoint}/${bucket}/run/second.ezenc`))
    expect(await backupSha256(new Uint8Array(await download.arrayBuffer()))).toBe(
      await backupSha256(second),
    )
  },
)
