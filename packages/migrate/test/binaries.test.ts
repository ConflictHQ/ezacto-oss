import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadBinaries } from '../src/binaries.js'
import type { ManifestBinaries } from '../src/manifest.js'

describe('binary snapshot archive', () => {
  let dir: string
  let server: Server
  let hits: number
  let baseUrl: string
  let requestHeaders: Array<{
    authorization: string | undefined
    account: string | undefined
    userAgent: string | undefined
  }>

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ezacto-binaries-'))
    await mkdir(join(dir, 'raw'))
    hits = 0
    requestHeaders = []
    server = createServer((req, res) => {
      hits += 1
      requestHeaders.push({
        authorization: req.headers.authorization,
        account: req.headers['harvest-account-id'] as string | undefined,
        userAgent: req.headers['user-agent'],
      })
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(Buffer.from('receipt bytes'))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/asset`
    await writeFile(join(dir, 'raw', 'users.jsonl'), '')
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(dir, { recursive: true, force: true })
  })

  it('[unit] file_size mismatch records an anomaly and extraction can continue', async () => {
    await writeFile(
      join(dir, 'raw', 'expenses.jsonl'),
      `${JSON.stringify({ id: 7, receipt: { url: baseUrl, file_name: 'proof.png', file_size: 999 } })}\n`,
    )
    const result = await downloadBinaries({ snapshotDir: dir })
    expect(result.anomalies).toEqual([
      expect.objectContaining({ kind: 'size_mismatch', resource: 'receipt', source_id: 7 }),
    ])
    expect(await readFile(join(dir, result.receipts['7'].path), 'utf8')).toBe('receipt bytes')
  })

  it('[unit] re-run fetches only an asset whose content-addressed file is missing', async () => {
    await writeFile(
      join(dir, 'raw', 'expenses.jsonl'),
      `${JSON.stringify({ id: 7, receipt: { url: baseUrl, file_name: 'proof.png', file_size: 13 } })}\n`,
    )
    const first = await downloadBinaries({ snapshotDir: dir })
    const second = await downloadBinaries({ snapshotDir: dir, prior: first })
    expect(hits).toBe(1)
    expect(second.anomalies).toEqual([])
    await unlink(join(dir, second.receipts['7'].path))
    await downloadBinaries({ snapshotDir: dir, prior: second })
    expect(hits).toBe(2)
  })

  it('[unit] refetches a current receipt when its declared file_size changes', async () => {
    await writeFile(
      join(dir, 'raw', 'expenses.jsonl'),
      `${JSON.stringify({ id: 7, receipt: { url: baseUrl, file_name: 'proof.png', file_size: 13 } })}\n`,
    )
    const first = await downloadBinaries({ snapshotDir: dir })
    await writeFile(
      join(dir, 'raw', 'expenses.jsonl'),
      `${JSON.stringify({ id: 7, receipt: { url: baseUrl, file_name: 'proof.png', file_size: 14 } })}\n`,
    )

    const second = await downloadBinaries({ snapshotDir: dir, prior: first })

    expect(hits).toBe(2)
    expect(second.receipts['7']).toEqual(first.receipts['7'])
    expect(second.anomalies).toEqual([
      {
        kind: 'size_mismatch',
        resource: 'receipt',
        source_id: 7,
        message: 'size_mismatch',
      },
    ])
  })

  it('[unit] receipt and avatar files are named by their content hash', async () => {
    await writeFile(
      join(dir, 'raw', 'expenses.jsonl'),
      `${JSON.stringify({ id: 7, receipt: { url: baseUrl, file_name: 'proof.png', file_size: 13 } })}\n`,
    )
    await writeFile(
      join(dir, 'raw', 'users.jsonl'),
      `${JSON.stringify({ id: 9, avatar_url: baseUrl })}\n`,
    )
    const result = await downloadBinaries({ snapshotDir: dir })
    expect(result.receipts['7'].path).toMatch(/^receipts\/[a-f0-9]{64}\.png$/)
    expect(result.avatars['9'].path).toMatch(/^avatars\/[a-f0-9]{64}$/)
  })

  it('[unit] authenticates account-web receipts only on the exact trusted origin', async () => {
    await writeFile(
      join(dir, 'raw', 'expenses.jsonl'),
      `${JSON.stringify({ id: 7, receipt: { url: baseUrl, file_name: 'proof.png', file_size: 13 } })}\n`,
    )
    await downloadBinaries({
      snapshotDir: dir,
      fetchImpl: fetch,
      testWebAuthOrigin: new URL(baseUrl).origin,
      webAuth: {
        origin: new URL(baseUrl).origin,
        pat: 'pat-secret',
        accountId: '42',
        userAgentEmail: 'test@ezacto.dev',
      },
    })
    expect(requestHeaders).toEqual([
      {
        authorization: 'Bearer pat-secret',
        account: '42',
        userAgent: 'ezacto-migrate (test@ezacto.dev)',
      },
    ])

    requestHeaders.length = 0
    await downloadBinaries({
      snapshotDir: dir,
      testWebAuthOrigin: new URL(baseUrl).origin,
      webAuth: {
        origin: new URL(baseUrl).origin,
        pat: 'test-seam-must-not-bypass-injection',
        accountId: '42',
        userAgentEmail: 'test@ezacto.dev',
      },
    })
    expect(requestHeaders).toHaveLength(1)
    expect(requestHeaders[0]).toMatchObject({ authorization: undefined, account: undefined })

    requestHeaders.length = 0
    await downloadBinaries({
      snapshotDir: dir,
      fetchImpl: fetch,
      webAuth: {
        origin: 'https://different.harvestapp.com',
        pat: 'must-not-leak',
        accountId: '42',
        userAgentEmail: 'test@ezacto.dev',
      },
    })
    expect(requestHeaders).toHaveLength(1)
    expect(requestHeaders[0]).toMatchObject({ authorization: undefined, account: undefined })
  })

  it('[unit] sends PAT headers only for receipts on an official HTTPS account-web origin', async () => {
    const origin = 'https://acme.harvestapp.com'
    await writeFile(
      join(dir, 'raw', 'expenses.jsonl'),
      `${JSON.stringify({ id: 7, receipt: { url: `${origin}/receipt`, file_name: 'proof.png' } })}\n`,
    )
    await writeFile(
      join(dir, 'raw', 'users.jsonl'),
      `${JSON.stringify({ id: 9, avatar_url: `${origin}/avatar` })}\n`,
    )
    const requests: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((input, init = {}) => {
      requests.push({ url: String(input), init })
      return Promise.resolve(
        new Response('receipt bytes', { status: 200, headers: { 'content-type': 'image/png' } }),
      )
    })

    await downloadBinaries({
      snapshotDir: dir,
      fetchImpl,
      webAuth: {
        origin,
        pat: 'official-pat',
        accountId: '42',
        userAgentEmail: 'test@ezacto.dev',
      },
    })

    expect(requests.map((request) => request.url)).toEqual([
      `${origin}/receipt`,
      `${origin}/avatar`,
    ])
    expect(new Headers(requests[0].init.headers).get('authorization')).toBe('Bearer official-pat')
    expect(new Headers(requests[0].init.headers).get('harvest-account-id')).toBe('42')
    expect(requests[0].init.redirect).toBe('manual')
    expect(new Headers(requests[1].init.headers).has('authorization')).toBe(false)
    expect(new Headers(requests[1].init.headers).has('harvest-account-id')).toBe(false)
    expect(requests[1].init.redirect).toBe('follow')
  })

  it('[unit] never authenticates off-origin receipts or an untrusted HTTP Harvest origin', async () => {
    await writeFile(
      join(dir, 'raw', 'expenses.jsonl'),
      [
        { id: 7, receipt: { url: 'https://signed.example.test/receipt-one' } },
        { id: 8, receipt: { url: 'http://acme.harvestapp.com/receipt-two' } },
        {
          id: 9,
          receipt: { url: 'https://acme.harvestapp.com.attacker.example/receipt-three' },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    )
    const requests: RequestInit[] = []
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_input, init = {}) => {
      requests.push(init)
      return Promise.resolve(
        new Response('receipt bytes', { status: 200, headers: { 'content-type': 'image/png' } }),
      )
    })

    await downloadBinaries({
      snapshotDir: dir,
      fetchImpl,
      webAuth: {
        origin: 'https://acme.harvestapp.com',
        pat: 'must-not-leak',
        accountId: '42',
        userAgentEmail: 'test@ezacto.dev',
      },
    })
    await downloadBinaries({
      snapshotDir: dir,
      fetchImpl,
      webAuth: {
        origin: 'http://acme.harvestapp.com',
        pat: 'also-must-not-leak',
        accountId: '42',
        userAgentEmail: 'test@ezacto.dev',
      },
    })

    for (const request of requests) {
      expect(new Headers(request.headers).has('authorization')).toBe(false)
      expect(new Headers(request.headers).has('harvest-account-id')).toBe(false)
      expect(request.redirect).toBe('follow')
    }
  })

  it('[unit] refuses authenticated redirects without following or reflecting external details', async () => {
    const origin = 'https://acme.harvestapp.com'
    await writeFile(
      join(dir, 'raw', 'expenses.jsonl'),
      `${JSON.stringify({ id: 7, receipt: { url: `${origin}/redirect` } })}\n`,
    )
    const redirects: RequestRedirect[] = []
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation((_input, init = {}) => {
      redirects.push(init.redirect ?? 'follow')
      return Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: 'https://attacker.example.test/steal' },
        }),
      )
    })

    const result = await downloadBinaries({
      snapshotDir: dir,
      fetchImpl,
      webAuth: {
        origin,
        pat: 'redirect-pat',
        accountId: '42',
        userAgentEmail: 'test@ezacto.dev',
      },
    })

    expect(redirects).toEqual(['manual', 'manual'])
    expect(result.receipts).toEqual({})
    expect(result.anomalies).toEqual([
      {
        kind: 'download_failed',
        resource: 'receipt',
        source_id: 7,
        message: 'redirect_refused',
      },
    ])
  })

  it('[unit] discards PATs and signed URLs from caught errors, logs, and prior anomalies', async () => {
    const pat = 'known-pat-value-never-log'
    const signedUrl = 'https://signed.example.test/receipt?signature=external-url-secret'
    await writeFile(
      join(dir, 'raw', 'expenses.jsonl'),
      `${JSON.stringify({ id: 7, receipt: { url: signedUrl } })}\n`,
    )
    const logs: string[] = []
    const prior: ManifestBinaries = {
      receipts: {},
      avatars: {},
      anomalies: [
        {
          kind: 'download_failed',
          resource: 'avatar',
          source_id: 99,
          message: `${pat} ${signedUrl}` as never,
        },
      ],
    }
    const result = await downloadBinaries({
      snapshotDir: dir,
      prior,
      fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error(`${pat} ${signedUrl}`)),
      log: (line) => logs.push(line),
    })

    const diagnostics = `${JSON.stringify(result)}\n${logs.join('\n')}`
    expect(diagnostics).not.toContain(pat)
    expect(diagnostics).not.toContain(signedUrl)
    expect(result.anomalies).toContainEqual({
      kind: 'download_failed',
      resource: 'receipt',
      source_id: 7,
      message: 'request_failed',
    })
    expect(result.anomalies).toContainEqual({
      kind: 'download_failed',
      resource: 'avatar',
      source_id: 99,
      message: 'request_failed',
    })
  })

  it('[unit] checkpoints a secret-free result after every receipt and avatar outcome', async () => {
    await writeFile(
      join(dir, 'raw', 'expenses.jsonl'),
      [
        { id: 7, receipt: { url: `${baseUrl}/one`, file_name: 'one.png' } },
        { id: 8, receipt: { url: `${baseUrl}/two`, file_name: 'two.png' } },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    )
    await writeFile(
      join(dir, 'raw', 'users.jsonl'),
      `${JSON.stringify({ id: 9, avatar_url: `${baseUrl}/avatar` })}\n`,
    )
    const checkpoints: ManifestBinaries[] = []

    await downloadBinaries({
      snapshotDir: dir,
      onProgress: async (archive) => {
        checkpoints.push(archive)
      },
    })

    expect(checkpoints).toHaveLength(3)
    expect(Object.keys(checkpoints[0].receipts)).toEqual(['7'])
    expect(Object.keys(checkpoints[1].receipts)).toEqual(['7', '8'])
    expect(Object.keys(checkpoints[2].avatars)).toEqual(['9'])
  })

  it('[unit] rejects malformed prior metadata and repairs corrupt receipt and avatar objects', async () => {
    await writeFile(
      join(dir, 'raw', 'expenses.jsonl'),
      `${JSON.stringify({ id: 7, receipt: { url: baseUrl, file_name: 'proof.png', content_type: 'image/png' } })}\n`,
    )
    await writeFile(
      join(dir, 'raw', 'users.jsonl'),
      `${JSON.stringify({ id: 9, avatar_url: baseUrl })}\n`,
    )
    const first = await downloadBinaries({ snapshotDir: dir })
    const pristine = structuredClone(first)

    const mutations: Array<(prior: ManifestBinaries) => void> = [
      (prior) => {
        prior.receipts['7'].path = '../outside.png'
      },
      (prior) => {
        prior.receipts['7'].source_id = 70
      },
      (prior) => {
        prior.receipts['7'].sha256 = 'a'.repeat(64)
      },
      (prior) => {
        prior.receipts['7'].bytes += 1
      },
      (prior) => {
        prior.receipts['7'].content_type = 'text/plain'
      },
    ]
    for (const mutate of mutations) {
      const prior = structuredClone(pristine)
      mutate(prior)
      const before = hits
      const repaired = await downloadBinaries({ snapshotDir: dir, prior })
      expect(hits).toBeGreaterThan(before)
      expect(repaired.receipts['7']).toEqual(pristine.receipts['7'])
      expect(repaired.receipts['7'].path).toMatch(/^receipts\/[a-f0-9]{64}\.png$/)
    }

    await writeFile(join(dir, pristine.receipts['7'].path), 'corrupt receipt bytes')
    await writeFile(join(dir, pristine.avatars['9'].path), 'corrupt avatar bytes')
    const repaired = await downloadBinaries({ snapshotDir: dir, prior: pristine })
    expect(await readFile(join(dir, repaired.receipts['7'].path), 'utf8')).toBe('receipt bytes')
    expect(await readFile(join(dir, repaired.avatars['9'].path), 'utf8')).toBe('receipt bytes')
    expect(repaired.anomalies).toEqual([])
  })

  it('[unit] retains Windows-style historical receipt and avatar paths and normalizes them', async () => {
    await writeFile(
      join(dir, 'raw', 'expenses.jsonl'),
      `${JSON.stringify({ id: 7, receipt: { url: baseUrl, file_name: 'proof.png' } })}\n`,
    )
    await writeFile(
      join(dir, 'raw', 'users.jsonl'),
      `${JSON.stringify({ id: 9, avatar_url: baseUrl })}\n`,
    )
    const first = await downloadBinaries({ snapshotDir: dir })
    const prior = structuredClone(first)
    prior.receipts['7'].path = prior.receipts['7'].path.replace('/', '\\')
    prior.avatars['9'].path = prior.avatars['9'].path.replace('/', '\\')
    await writeFile(join(dir, 'raw', 'expenses.jsonl'), '')
    await writeFile(join(dir, 'raw', 'users.jsonl'), '')

    const retained = await downloadBinaries({ snapshotDir: dir, prior })

    expect(hits).toBe(2)
    expect(retained.receipts).toEqual(first.receipts)
    expect(retained.avatars).toEqual(first.avatars)
    expect(retained.receipts['7'].path).toMatch(/^receipts\//)
    expect(retained.avatars['9'].path).toMatch(/^avatars\//)
  })

  it('[unit] rejects malformed runtime prior containers without throwing', async () => {
    const retained = await downloadBinaries({
      snapshotDir: dir,
      prior: {
        receipts: [],
        avatars: 'not-a-map',
        anomalies: { message: 'not-an-array' },
      } as unknown as ManifestBinaries,
    })

    expect(retained.receipts).toEqual({})
    expect(retained.avatars).toEqual({})
    expect(retained.anomalies).toEqual([])
  })

  it('[unit] rejects symlinked receipt and avatar files without changing their targets', async () => {
    await writeFile(
      join(dir, 'raw', 'expenses.jsonl'),
      `${JSON.stringify({ id: 7, receipt: { url: baseUrl, file_name: 'proof.png' } })}\n`,
    )
    await writeFile(
      join(dir, 'raw', 'users.jsonl'),
      `${JSON.stringify({ id: 9, avatar_url: baseUrl })}\n`,
    )
    const first = await downloadBinaries({ snapshotDir: dir })
    const outsideReceipt = join(dir, 'outside-receipt')
    const outsideAvatar = join(dir, 'outside-avatar')
    await writeFile(outsideReceipt, 'receipt bytes')
    await writeFile(outsideAvatar, 'receipt bytes')
    await unlink(join(dir, first.receipts['7'].path))
    await unlink(join(dir, first.avatars['9'].path))
    try {
      await symlink(outsideReceipt, join(dir, first.receipts['7'].path), 'file')
      await symlink(outsideAvatar, join(dir, first.avatars['9'].path), 'file')
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        return
      }
      throw error
    }

    const repaired = await downloadBinaries({ snapshotDir: dir, prior: first })

    expect(repaired.receipts).toEqual({})
    expect(repaired.avatars).toEqual({})
    expect(repaired.anomalies).toEqual([
      {
        kind: 'download_failed',
        resource: 'receipt',
        source_id: 7,
        message: 'archive_write_failed',
      },
      {
        kind: 'download_failed',
        resource: 'avatar',
        source_id: 9,
        message: 'archive_write_failed',
      },
    ])
    expect(await readFile(outsideReceipt, 'utf8')).toBe('receipt bytes')
    expect(await readFile(outsideAvatar, 'utf8')).toBe('receipt bytes')
  })

  it('[unit] refuses receipt and avatar writes through symlinked resource roots', async () => {
    const outsideReceipts = join(dir, 'outside-receipts-root')
    const outsideAvatars = join(dir, 'outside-avatars-root')
    await mkdir(outsideReceipts)
    await mkdir(outsideAvatars)
    try {
      await symlink(outsideReceipts, join(dir, 'receipts'), 'dir')
      await symlink(outsideAvatars, join(dir, 'avatars'), 'dir')
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        return
      }
      throw error
    }
    await writeFile(
      join(dir, 'raw', 'expenses.jsonl'),
      `${JSON.stringify({ id: 7, receipt: { url: baseUrl, file_name: 'proof.png' } })}\n`,
    )
    await writeFile(
      join(dir, 'raw', 'users.jsonl'),
      `${JSON.stringify({ id: 9, avatar_url: baseUrl })}\n`,
    )

    const result = await downloadBinaries({ snapshotDir: dir })

    expect(result.receipts).toEqual({})
    expect(result.avatars).toEqual({})
    expect(result.anomalies.map((anomaly) => anomaly.message)).toEqual([
      'archive_write_failed',
      'archive_write_failed',
    ])
    expect(await readdir(outsideReceipts)).toEqual([])
    expect(await readdir(outsideAvatars)).toEqual([])
  })
})
