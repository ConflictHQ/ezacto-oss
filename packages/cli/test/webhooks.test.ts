import { afterEach, expect, it, vi } from 'vitest'
import { webhookCommand } from '../src/webhooks.js'
afterEach(() => vi.unstubAllGlobals())
const cookie = '__Host-ezacto_session=' + 'a'.repeat(43)
const runtime = () => ({
  readStdin: async () =>
    JSON.stringify({ base_url: 'https://books.example', session_cookie: cookie }),
  stdout: vi.fn(),
})
it('pages logs using an administrator session and never sends an API token or follows redirects', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ data: [{ id: 'a' }], page: { next_cursor: 'page-two' } }),
    )
    .mockResolvedValueOnce(Response.json({ data: [{ id: 'b' }], page: { next_cursor: null } }))
  vi.stubGlobal('fetch', fetch)
  const io = runtime()
  expect(await webhookCommand(['log'], io)).toBe(0)
  expect(io.stdout.mock.calls).toEqual([['{"id":"a"}'], ['{"id":"b"}']])
  for (const [url, init] of fetch.mock.calls) {
    expect(String(url)).toContain('https://books.example/api/v1/webhook-deliveries')
    const headers = new Headers(init.headers)
    expect(headers.get('cookie')).toBe(cookie)
    expect(headers.get('origin')).toBe('https://books.example')
    expect(headers.has('authorization')).toBe(false)
    expect(init.redirect).toBe('error')
  }
  expect(String(fetch.mock.calls[1]![0])).toContain('cursor=page-two')
  expect(io.stdout.mock.calls.flat().join('')).not.toContain(cookie)
})
it('replays only the requested delivery with a fresh idempotency key', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ data: { status: 'pending' } }))
  vi.stubGlobal('fetch', fetch)
  await webhookCommand(['replay', 'a'.repeat(32)], runtime())
  expect(fetch).toHaveBeenCalledOnce()
  const [url, init] = fetch.mock.calls[0]!
  expect(String(url)).toContain('/' + 'a'.repeat(32) + '/replay')
  expect(init.method).toBe('POST')
  expect(new Headers(init.headers).get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/)
  expect(init.body).toBe('{}')
})
it('refuses private session input errors without reflecting credential material', async () => {
  const io = runtime()
  await expect(webhookCommand(['replay', 'bad'], io)).rejects.toThrow('Expected a delivery ID.')
  for (const input of [
    { base_url: 'http://books.example', session_cookie: cookie },
    { base_url: 'https://books.example', session_cookie: cookie + '; evil=private' },
    { base_url: 'https://books.example', session_cookie: cookie, token: 'private' },
  ]) {
    await expect(
      webhookCommand(['log'], { ...io, readStdin: async () => JSON.stringify(input) }),
    ).rejects.toThrow(/https|Invalid session input/i)
  }
})
