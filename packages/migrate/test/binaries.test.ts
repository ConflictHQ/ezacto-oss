import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, readFile, rm, unlink, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { downloadBinaries } from '../src/binaries.js'

describe('binary snapshot archive', () => {
  let dir: string
  let server: Server
  let hits: number
  let baseUrl: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ezacto-binaries-'))
    await mkdir(join(dir, 'raw'))
    hits = 0
    server = createServer((_req, res) => {
      hits += 1
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

  it('[unit] receipt and avatar files are named by their content hash', async () => {
    await writeFile(
      join(dir, 'raw', 'expenses.jsonl'),
      `${JSON.stringify({ id: 7, receipt: { url: baseUrl, file_name: 'proof.png', file_size: 13 } })}\n`,
    )
    await writeFile(join(dir, 'raw', 'users.jsonl'), `${JSON.stringify({ id: 9, avatar_url: baseUrl })}\n`)
    const result = await downloadBinaries({ snapshotDir: dir })
    expect(result.receipts['7'].path).toMatch(/^receipts\/[a-f0-9]{64}\.png$/)
    expect(result.avatars['9'].path).toMatch(/^avatars\/[a-f0-9]{64}$/)
  })
})
