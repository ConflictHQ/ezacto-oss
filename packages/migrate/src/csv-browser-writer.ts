import { CsvBrowserPlannerError } from './csv-browser-errors.js'
import { csvPlanId } from '@ezacto/core'
import type {
  AdministratorActor,
  CsvBrowserDatasetLedger,
  CsvBrowserLease,
  CommitResult,
  GeneralMutationInput,
} from '@ezacto/core'
import {
  csvBrowserSealInput,
  type CsvBrowserDestinationSnapshot,
  type CsvBrowserPlan,
  type PlannedRow,
  type Entity,
} from './csv-planner.js'
import { sha256Hex } from './portable-hash.js'

/** Canonical setup and tracked time writes; never chooses the database owner for HTTP. */
export interface CsvWriterSetupCache {
  /** Trusted native lineage rehydrated under the same revision and execution fence. */
  createdIds: ReadonlyMap<string, number>
  userPairs: readonly string[]
  taskPairs: readonly string[]
}
export const createCsvBrowserWriter = (
  ledger: CsvBrowserDatasetLedger,
  snapshot: CsvBrowserDestinationSnapshot,
  plan: CsvBrowserPlan,
  cache?: CsvWriterSetupCache,
) => {
  const selected = plan.plan.items.filter((row) => row.state !== 'rejected')
  const boundPlanId = csvPlanId(csvBrowserSealInput(plan))
  const createdIds = new Map<string, number>(cache?.createdIds)
  const userPairs = new Set(
    [...snapshot.userAssignments.map((row) => `${row.user_id}:${row.project_id}`), ...(cache?.userPairs ?? [])],
  )
  const taskPairs = new Set(
    [...snapshot.taskAssignments.map((row) => `${row.project_id}:${row.task_id}`), ...(cache?.taskPairs ?? [])],
  )
  const futureUsers = new Set(snapshot.futureProjectUserIds),
    defaultTasks = new Set(snapshot.defaultTaskIds)
  const firstBillable = new Map<string, boolean>()
  for (const row of plan.plan.items)
    if (row.state !== 'rejected' && row.project && row.task) {
      const key = JSON.stringify([row.project.key, row.task.key])
      if (!firstBillable.has(key)) firstBillable.set(key, row.row.billable ?? true)
    }
  return {
    async writeRow(
      actor: AdministratorActor,
      lease: CsvBrowserLease & { runId: string },
      planId: string,
      item: Readonly<PlannedRow>,
      chunkIndex: number,
    ): Promise<CommitResult> {
      if (selected[chunkIndex] !== item || boundPlanId !== planId)
        throw new CsvBrowserPlannerError('plan_row_mismatch')
      if (actor.userId !== snapshot.actor.userId || actor.kind !== 'administrator')
        throw new CsvBrowserPlannerError('administrator_required')
      if (item.state === 'rejected') throw new CsvBrowserPlannerError('row_rejected')
      const base = {
        runId: lease.runId,
        planId,
        holder: lease.holder,
        leaseGeneration: lease.generation,
      }
      if (item.state === 'existing')
        return ledger.acknowledgeExisting(actor, {
          ...base,
          chunkIndex,
          sourceKey: item.key,
          line: item.row.line,
          sourceSeconds: item.row.seconds,
        })
      if (!item.person || !item.project || !item.task)
        throw new CsvBrowserPlannerError('row_rejected')
      const ensure = async (target: Readonly<Entity>): Promise<number> => {
        if (target.id !== null) return target.id
        const cached = createdIds.get(target.key)
        if (cached !== undefined) return cached
        const input: GeneralMutationInput =
          target.kind === 'person'
            ? {
                firstName: target.person!.firstName,
                lastName: target.person!.lastName,
                email: target.email!,
                isActive: false,
                profile: 'member',
              }
            : target.kind === 'client'
              ? { name: target.name, currency: target.currency! }
              : target.kind === 'project'
                ? { name: target.name, clientId: await ensure(target.parent!) }
                : { name: target.name }
        const kind =
          target.kind === 'person'
            ? 'users'
            : target.kind === 'client'
              ? 'clients'
              : target.kind === 'project'
                ? 'projects'
                : 'tasks'
        const row = await ledger.setup(actor, {
          ...base,
          setupKey: sha256Hex(target.key),
          kind,
          input,
        })
        const id = Number(row.id)
        if (!Number.isSafeInteger(id) || id <= 0)
          throw new CsvBrowserPlannerError('setup_identity_invalid')
        createdIds.set(target.key, id)
        return id
      }
      const userId = await ensure(item.person),
        projectId = await ensure(item.project),
        taskId = await ensure(item.task)
      if (
        !userPairs.has(`${userId}:${projectId}`) &&
        !(item.project.id === null && futureUsers.has(userId))
      ) {
        await ledger.setup(actor, {
          ...base,
          setupKey: sha256Hex(`person-project:${userId}:${projectId}`),
          kind: 'user-assignments',
          input: { userId, projectId },
        })
        userPairs.add(`${userId}:${projectId}`)
      }
      if (
        !taskPairs.has(`${projectId}:${taskId}`) &&
        !(item.project.id === null && defaultTasks.has(taskId))
      ) {
        await ledger.setup(actor, {
          ...base,
          setupKey: sha256Hex(`project-task:${projectId}:${taskId}`),
          kind: 'task-assignments',
          input: {
            projectId,
            taskId,
            billable: firstBillable.get(JSON.stringify([item.project.key, item.task.key])) ?? true,
          },
        })
        taskPairs.add(`${projectId}:${taskId}`)
      }
      return ledger.commitEntry(actor, {
        ...base,
        chunkIndex,
        sourceKey: item.key,
        line: item.row.line,
        sourceSeconds: item.row.seconds,
        entry: {
          userId,
          projectId,
          taskId,
          spentDate: item.row.date,
          ...(item.row.startedTime === null
            ? { seconds: item.row.seconds }
            : { startedTime: item.row.startedTime, endedTime: item.row.endedTime! }),
          notes: item.row.notes,
        },
      })
    },
  }
}
