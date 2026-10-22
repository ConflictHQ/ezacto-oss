import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import type { WorkerEnv } from './app.js'
import { createRuntimeServices } from './runtime.js'
import type { ScheduledRunWorkflowParams } from './scheduled-run-workflow-scheduler.js'
export { default } from './index.js'

/** Platform checkpoints resume the same database-fenced delivery intents. */
export class ScheduledRunWorkflow extends WorkflowEntrypoint<
  WorkerEnv,
  ScheduledRunWorkflowParams
> {
  async run(event: WorkflowEvent<ScheduledRunWorkflowParams>, step: WorkflowStep) {
    const { runId, proposedAt } = event.payload
    if (!Number.isSafeInteger(runId) || runId <= 0 || !Number.isFinite(Date.parse(proposedAt)))
      throw new TypeError('Invalid scheduled-run Workflow identity.')
    for (let pass = 0; ; pass += 1) {
      const result = await step.do(
        `dispatch-${pass}`,
        { retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' }, timeout: '1 minute' },
        async () => {
          const services = await createRuntimeServices(this.env)
          if (!services.scheduledRunDispatch)
            throw new Error(
              'Scheduled report delivery requires attachment storage and queued email.',
            )
          return services.scheduledRunDispatch.processRun(runId, proposedAt)
        },
      )
      if (!result.pending) return { runId, dispatchSettled: true }
      // Do not burn a transient item's retry budget in one tight loop. This
      // also lets an interrupted owner's 15-minute lease expire naturally.
      await step.sleep(`retry-wait-${pass}`, '1 minute')
    }
  }
}
