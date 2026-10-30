import { parseExpectedRevision } from '@ezacto/core'

/** Ninety-day compatibility window from the documented 2026-10-24 rollout. */
export const planningRevisionSunset = '2027-01-22T00:00:00.000Z'
export const expectedPlanningVersion = (
  body: Readonly<Record<string, unknown>>,
  instant: string,
  header: (name: string, value: string) => void,
): number | undefined => {
  const legacy = Date.parse(instant) < Date.parse(planningRevisionSunset)
  const expected = parseExpectedRevision(body, legacy ? 'legacy-unconditioned' : 'required')
  if (expected === null) {
    header('Deprecation', '@1792800000')
    header('Sunset', new Date(planningRevisionSunset).toUTCString())
  }
  return expected ?? undefined
}
