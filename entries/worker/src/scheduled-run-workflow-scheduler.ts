export interface ScheduledRunWorkflowParams {
  runId: number
  proposedAt: string
}
interface Candidate {
  id: number
  proposed_at: string
  generation: number
}
/** Stable across cron retries, distinct after explicit retry or database reset. */
export const scheduledRunWorkflowId = async (candidate: Candidate) => {
  const bytes = new TextEncoder().encode(
    `scheduled-run:v1:${candidate.id}:${candidate.proposed_at}:${candidate.generation}`,
  )
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  return `scheduled-run-${candidate.id}-${hash.slice(0, 32)}`
}
export const scheduleConfirmedRunWorkflows = async (
  workflow: Pick<Workflow<ScheduledRunWorkflowParams>, 'create' | 'get'>,
  dispatch: { workflowCandidates(): Promise<Candidate[]> },
) => {
  const failed: { runId: number; message: string }[] = []
  for (const candidate of await dispatch.workflowCandidates()) {
    try {
      const id = await scheduledRunWorkflowId(candidate)
      try {
        await workflow.create({
          id,
          params: { runId: candidate.id, proposedAt: candidate.proposed_at },
        })
      } catch (creationError) {
        // A duplicate ID is expected. Do not mistake a control-plane failure
        // for success: status must prove the original instance exists.
        const instance = await workflow.get(id)
        const status = await instance.status()
        if (status.status === 'unknown') throw creationError
        if (status.status === 'errored') await instance.restart()
        // Respect an operator's pause/termination; never resume it from cron.
      }
    } catch (error) {
      failed.push({
        runId: candidate.id,
        message: error instanceof Error ? error.message : 'Workflow scheduling failed.',
      })
    }
  }
  return { failed }
}
