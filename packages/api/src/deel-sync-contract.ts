import type { ApiContractOperation } from './contract.js'

const string = { type: 'string' } as const
const integer = { type: 'integer' } as const
const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] })
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const array = (items: object) => ({ type: 'array', items })
const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  required: Object.keys(properties),
  additionalProperties: false,
  properties,
})
const mode = { type: 'string', enum: ['manual', 'automatic'] }
const window = object({ from: string, to: string })
const runTime = { type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' }

export const deelSyncOperations: readonly ApiContractOperation[] = [
  {
    method: 'get',
    path: '/api/v1/deel-sync',
    operationId: 'getDeelSync',
    summary: 'Deel time sync mode, schedule and recent runs',
    description:
      'The sync is manual unless an administrator sets it to automatic. Automatic runs once a day at run_time in the organization timezone, through the hourly cron. Nothing is sent to Deel unless configured is true.',
    tag: 'deel-sync',
    responseStatus: 200,
    responseSchema: 'DeelSyncStatus',
    sessionOnly: true,
  },
  {
    method: 'patch',
    path: '/api/v1/deel-sync/settings',
    operationId: 'updateDeelSyncSettings',
    summary: 'Set the Deel sync mode and automatic run time',
    tag: 'deel-sync',
    responseStatus: 204,
    requestSchema: 'DeelSyncSettingsCommand',
    requestRequired: true,
    sessionOnly: true,
  },
  {
    method: 'post',
    path: '/api/v1/deel-sync/preview',
    operationId: 'previewDeelSync',
    summary: 'Preview the timesheets a Deel sync would create, without sending any',
    tag: 'deel-sync',
    responseStatus: 200,
    additionalResponseStatuses: [409, 422],
    responseSchema: 'DeelSyncPreview',
    requestSchema: 'DeelSyncWindow',
    requestRequired: true,
    sessionOnly: true,
  },
  {
    method: 'post',
    path: '/api/v1/deel-sync/runs',
    operationId: 'runDeelSync',
    summary: 'Send the timesheets from a preview to Deel',
    description:
      'Sends only when the plan still holds exactly the entry_ids from the preview. If the plan has changed, nothing is sent and the response is 409 deel_sync_stale; preview again.',
    tag: 'deel-sync',
    responseStatus: 200,
    additionalResponseStatuses: [409, 422],
    responseSchema: 'DeelSyncRunResult',
    requestSchema: 'DeelSyncRunCommand',
    requestRequired: true,
    sessionOnly: true,
  },
]

export const deelSyncSchemas = {
  DeelSyncSettingsCommand: object({ mode, run_time: runTime }),
  DeelSyncWindow: window,
  DeelSyncRun: object({
    id: integer,
    started_at: string,
    finished_at: nullable(string),
    outcome: { type: 'string', enum: ['running', 'completed', 'failed'] },
    timesheets_submitted: integer,
    entries_transferred: integer,
    detail: nullable({}),
  }),
  DeelSyncStatus: object({
    configured: { type: 'boolean' },
    reason: nullable(string),
    mode,
    run_time: runTime,
    updated_at: string,
    updated_by_user_id: nullable(integer),
    runs: array(ref('DeelSyncRun')),
  }),
  DeelSyncPreview: object({
    status: { type: 'string', enum: ['ready'] },
    window,
    entry_ids: array(integer),
    timesheets: integer,
    already_transferred: integer,
    conflicts: array({}),
    unsyncable: array({}),
    unmatched: array({}),
  }),
  DeelSyncRunCommand: object({
    from: string,
    to: string,
    entry_ids: array(integer),
  }),
  DeelSyncRunResult: object({
    status: { type: 'string', enum: ['completed', 'failed'] },
    run_id: integer,
    timesheets_submitted: integer,
    entries_transferred: integer,
    failed: array({}),
    reconciliation: nullable({}),
    error: nullable(string),
  }),
} as const
