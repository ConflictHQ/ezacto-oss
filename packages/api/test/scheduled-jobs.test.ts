import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import {
  ScheduledJobError,
  scheduledJobConfig,
  type ScheduledJob,
  type ScheduledJobsService,
} from '@ezacto/core'
import type { ApiContext } from '../src/context.js'
import { errorResponse } from '../src/errors.js'
import { installScheduledJobRoutes } from '../src/scheduled-jobs.js'
const now = '2026-10-01T09:00:00.000Z'
const job: ScheduledJob = {
  ...scheduledJobConfig({ name: 'Monthly' }),
  id: 1,
  version: 0,
  created_by: 7,
  created_at: now,
  updated_at: now,
  last_checked_at: null,
  last_error: null,
  last_run_id: null,
}
const fixture = (profile = 'administrator', kind = 'session') => {
  const service = {
    snapshot: vi.fn(async () => 1),
    list: vi.fn(async () => [job]),
    read: vi.fn(async () => job as ScheduledJob | null),
    create: vi.fn<ScheduledJobsService['create']>(async () => job),
    update: vi.fn<ScheduledJobsService['update']>(async () => ({
      ...job,
      version: 1,
      is_active: false,
    })),
  }
  const api = new Hono<ApiContext<object>>()
  api.use('*', async (c, next) => {
    c.set('principal', {
      type: 'user',
      userId: 7,
      profile,
      managerGrants: [],
      authentication: { kind, sessionId: 'session' },
    } as never)
    c.set('requestId', 'test')
    await next()
  })
  api.onError(errorResponse)
  installScheduledJobRoutes(api, service, {
    cursorSigningKey: new Uint8Array(32).fill(17),
    now: () => now,
  })
  return { api, service }
}
const body = (method: string, value: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(value),
})
describe('scheduled job administration (#63)', () => {
  it.each([
    ['member', 'session'],
    ['accounting', 'session'],
    ['executive_manager', 'session'],
    ['administrator', 'token'],
  ])('[security] denies %s %s before reading or changing jobs', async (profile, kind) => {
    const { api, service } = fixture(profile, kind)
    for (const [path, request] of [
      ['/scheduled-jobs', undefined],
      ['/scheduled-jobs/1', undefined],
      ['/scheduled-jobs', body('POST', { name: 'Monthly' })],
      ['/scheduled-jobs/1', body('PATCH', { expected_version: 0, is_active: false })],
    ] as const)
      expect((await api.request(path, request)).status).toBe(403)
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled()
  })
  it('[api] pages and reads only the published fields', async () => {
    const { api, service } = fixture()
    service.read.mockResolvedValue({ ...job, private_material: 'not-for-the-wire' } as ScheduledJob)
    const response = await api.request('/scheduled-jobs?per_page=1')
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      data: [job],
      page: { per_page: 1, next_cursor: null },
    })
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await (await api.request('/scheduled-jobs/1')).json()).toEqual({ data: job })
    expect((await api.request('/scheduled-jobs?actor_id=7')).status).toBe(422)
  })
  it('[security] binds creation and pause to the session actor and refuses forged metadata', async () => {
    const { api, service } = fixture()
    expect((await api.request('/scheduled-jobs', body('POST', { name: 'Monthly' }))).status).toBe(
      201,
    )
    expect(service.create).toHaveBeenCalledWith(7, scheduledJobConfig({ name: 'Monthly' }), now)
    expect(
      (
        await api.request(
          '/scheduled-jobs/1',
          body('PATCH', { expected_version: 0, is_active: false }),
        )
      ).status,
    ).toBe(200)
    expect(service.update).toHaveBeenCalledWith(7, 1, 0, { is_active: false }, now)
    expect(
      (await api.request('/scheduled-jobs', body('POST', { name: 'Forged', created_by: 1 })))
        .status,
    ).toBe(422)
    expect(
      (
        await api.request(
          '/scheduled-jobs/1',
          body('PATCH', { expected_version: 1, created_by: 1 }),
        )
      ).status,
    ).toBe(422)
    expect(
      (await api.request('/scheduled-jobs/1', body('PATCH', { is_active: false }))).status,
    ).toBe(422)
    expect(service.create).toHaveBeenCalledOnce()
    expect(service.update).toHaveBeenCalledOnce()
  })
  it('[api] reports missing jobs, stale versions and invalid job policy', async () => {
    const { api, service } = fixture()
    service.read.mockResolvedValueOnce(null)
    expect((await api.request('/scheduled-jobs/9')).status).toBe(404)
    expect((await api.request('/scheduled-jobs/0')).status).toBe(422)
    service.update.mockRejectedValueOnce(
      new ScheduledJobError('state_conflict', 'Refresh the job.'),
    )
    expect(
      (
        await api.request(
          '/scheduled-jobs/1',
          body('PATCH', { expected_version: 0, is_active: false }),
        )
      ).status,
    ).toBe(409)
    expect(
      (await api.request('/scheduled-jobs', body('POST', { name: 'Unsafe', confirmation: 'none' })))
        .status,
    ).toBe(422)
  })
})
