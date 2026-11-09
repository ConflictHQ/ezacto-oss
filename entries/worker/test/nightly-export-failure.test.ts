import { beforeEach, expect, it, vi } from 'vitest'
import { completeBackupRun, discardWorkerSnapshot, exportBundle, failBackupRun, recordBackupStart, shouldRunNightlyBackup } from '@ezacto/db/d1'
import { runNightlyExport } from '../src/nightly-export.js'

vi.mock('@ezacto/db/d1', () => ({
  completeBackupRun: vi.fn(), discardWorkerSnapshot: vi.fn(), exportBundle: vi.fn(),
  expireWorkerSnapshots: vi.fn(), failBackupRun: vi.fn(), recordBackupStart: vi.fn(),
  shouldRunNightlyBackup: vi.fn(),
}))
const database = { prepare: vi.fn(() => ({ first: async () => null })) } as unknown as D1Database
const bucket = {} as R2Bucket
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(database.prepare).mockReturnValue({ first: async () => null } as unknown as D1PreparedStatement)
  vi.mocked(shouldRunNightlyBackup).mockResolvedValue(true)
  vi.mocked(recordBackupStart).mockResolvedValue(59)
})
it('records a failed export and propagates the original error to scheduled reporting', async () => {
  const failure = new Error('A Worker backup attachment is missing or differs from its recorded bytes.')
  vi.mocked(exportBundle).mockRejectedValue(failure)
  await expect(runNightlyExport(database, bucket)).rejects.toBe(failure)
  expect(discardWorkerSnapshot).toHaveBeenCalledOnce()
  expect(failBackupRun).toHaveBeenCalledWith(database, 59, failure.message, expect.any(String))
  expect(completeBackupRun).not.toHaveBeenCalled()
})
it.each(['discard', 'record', 'both'])('retains the initiating error when %s cleanup fails and attempts both cleanup steps', async mode => {
  const failure = new Error('original export failure')
  const cleanup = new Error('cleanup failure')
  vi.mocked(exportBundle).mockRejectedValue(failure)
  if (mode !== 'record') vi.mocked(discardWorkerSnapshot).mockRejectedValue(cleanup)
  if (mode !== 'discard') vi.mocked(failBackupRun).mockRejectedValue(cleanup)
  const result = await runNightlyExport(database, bucket).catch(error => error)
  expect(result).toBeInstanceOf(AggregateError)
  expect(result.cause).toBe(failure)
  expect(result.errors[0]).toBe(failure)
  expect(discardWorkerSnapshot).toHaveBeenCalledOnce()
  expect(failBackupRun).toHaveBeenCalledOnce()
})
