import { expect, it, vi } from 'vitest'
import {
  scheduledRunWorkflowId,
  scheduleConfirmedRunWorkflows,
} from '../src/scheduled-run-workflow-scheduler.js'
const candidate = { id: 7, proposed_at: '2026-10-01T00:00:00.000Z', generation: 6 }
it('uses stable IDs and distinguishes explicit retry and database-reset identities', async () => {
  const id = await scheduledRunWorkflowId(candidate)
  expect(await scheduledRunWorkflowId({ ...candidate })).toBe(id)
  expect(await scheduledRunWorkflowId({ ...candidate, generation: 9 })).not.toBe(id)
  expect(
    await scheduledRunWorkflowId({ ...candidate, proposed_at: '2026-10-02T00:00:00.000Z' }),
  ).not.toBe(id)
})
it('creates once, recovers errored instances and respects operator pauses', async () => {
  const restart = vi.fn(async () => {}),
    status = vi.fn(async () => ({ status: 'running' })),
    create = vi.fn(async () => ({})),
    workflow = { create, get: vi.fn(async () => ({ restart, status })) },
    dispatch = { workflowCandidates: async () => [candidate] }
  expect(await scheduleConfirmedRunWorkflows(workflow as never, dispatch)).toEqual({ failed: [] })
  expect(create).toHaveBeenCalledWith({
    id: await scheduledRunWorkflowId(candidate),
    params: { runId: 7, proposedAt: candidate.proposed_at },
  })
  create.mockRejectedValue(new Error('already exists'))
  for (const state of ['running', 'paused', 'terminated', 'complete', 'waiting']) {
    status.mockResolvedValue({ status: state })
    expect(await scheduleConfirmedRunWorkflows(workflow as never, dispatch)).toEqual({ failed: [] })
  }
  expect(restart).not.toHaveBeenCalled()
  status.mockResolvedValue({ status: 'errored' })
  await scheduleConfirmedRunWorkflows(workflow as never, dispatch)
  expect(restart).toHaveBeenCalledOnce()
  status.mockResolvedValue({ status: 'unknown' })
  expect((await scheduleConfirmedRunWorkflows(workflow as never, dispatch)).failed).toEqual([
    { runId: 7, message: 'already exists' },
  ])
})
it('isolates a control-plane failure so later runs can start', async () => {
  const workflow = {
    create: vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce({}),
    get: vi.fn(async () => {
      throw new Error('unavailable')
    }),
  }
  expect(
    await scheduleConfirmedRunWorkflows(workflow as never, {
      workflowCandidates: async () => [candidate, { ...candidate, id: 8 }],
    }),
  ).toEqual({ failed: [{ runId: 7, message: 'unavailable' }] })
  expect(workflow.create).toHaveBeenCalledTimes(2)
})
