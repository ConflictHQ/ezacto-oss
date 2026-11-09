import { EzactoClient } from '@conflict-hq/ezacto-client'
import { describe, expect, it, vi } from 'vitest'
import { editEntryNote, editTimerNote, stopTimer } from '../src/time.js'

const entry = { id: 42, notes: 'before', is_running: true, seconds: 91, project_id: 1, task_id: 2 }
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json' },
})
const setup = (reply: (path: string, init?: RequestInit) => Response) => {
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
    reply(new URL(String(input)).pathname, init))
  return { client: new EzactoClient({ baseUrl: 'https://test.example', token: 'test', fetch }), fetch }
}

describe('CLI note updates', () => {
  it('[unit] sends only notes when replacing and clearing, without fetching stale entry fields', async () => {
    const { client, fetch } = setup((_path, init) => json({ data: { ...entry, ...JSON.parse(String(init?.body)) } }))
    await editEntryNote(client, 42, { note: 'replacement' })
    await editEntryNote(client, 42, { note: '' })
    expect(fetch.mock.calls.map(([, init]) => [init?.method, JSON.parse(String(init?.body))])).toEqual([
      ['PATCH', { notes: 'replacement' }], ['PATCH', { notes: '' }],
    ])
  })

  it.each([null, '', 'before'])('[unit] appends without a leading blank line to %j', async (notes) => {
    const { client, fetch } = setup((_path, init) => json({ data: { ...entry, notes, ...(init?.body ? JSON.parse(String(init.body)) : {}) } }))
    const result = await editEntryNote(client, 42, { note: 'after', append: true })
    expect(result.json).toMatchObject({ notes: notes ? 'before\nafter' : 'after', is_running: true, seconds: 91 })
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'PATCH'])
    expect(JSON.parse(String(fetch.mock.calls[1]![1]?.body))).toEqual({ notes: notes ? 'before\nafter' : 'after' })
  })

  it.each([{ entries: [] }, { entries: [entry, { ...entry, id: 43 }] }])('[unit] refuses absent or ambiguous running timers without writing', async ({ entries }) => {
    const { client, fetch } = setup(() => json({ data: entries, page: { next_cursor: null } }))
    await expect(editTimerNote(client, { note: 'after' })).rejects.toThrow(/no timer|invariant/)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([403, 409, 422])('[unit] a refused note write (%i) never stops the timer or retries', async (status) => {
    const { client, fetch } = setup((path, init) => {
      if (init?.method === 'PATCH') return json({ error: { code: 'locked', message: 'not editable' } }, status)
      if (path.endsWith('/time-entries')) return json({ data: [entry], page: { next_cursor: null } })
      return json({ data: [], page: { next_cursor: null } })
    })
    await expect(stopTimer(client, { note: 'after' })).rejects.toThrow()
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1)
    expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/stop'))).toBe(false)
  })
})
