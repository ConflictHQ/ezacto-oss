import type { ApiContractOperation } from './contract.js'
const string = { type: 'string' } as const
const integer = { type: 'integer', minimum: 1 } as const
const version = { type: 'integer', minimum: 0 } as const
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] })
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const config = {
  action: { type: 'string', const: 'month_end_pack' },
  name: { type: 'string', minLength: 1, maxLength: 200 },
  scope: object({ client_ids: { type: 'array', items: integer } }, []),
  cadence: {
    type: 'string',
    description: 'Monthly M H D * * on the organization clock; skipped calendar days do not run.',
  },
  confirmation: { type: 'string', const: 'required' },
  confirm_within_minutes: { type: 'integer', minimum: 1, maximum: 20160 },
  is_active: { type: 'boolean' },
}
export const scheduledJobSchemas = {
  ScheduledJobCreate: object(config, ['name']),
  ScheduledJobPatch: object({ ...config, expected_version: version }, ['expected_version']),
  ScheduledJob: object({
    ...config,
    confirmation: { type: 'string', enum: ['required', 'none'] },
    scope: {},
    id: integer,
    version,
    created_by: integer,
    created_at: string,
    updated_at: string,
    last_checked_at: nullable(string),
    last_error: nullable(string),
    last_run_id: nullable(integer),
  }),
  ScheduledJobEnvelope: object({ data: ref('ScheduledJob') }),
  ScheduledJobsPage: object({
    data: { type: 'array', items: ref('ScheduledJob') },
    links: ref('PageLinks'),
    page: ref('PageMetadata'),
  }),
}
const id = { name: 'id', location: 'path', required: true, schema: integer } as const
export const scheduledJobOperations: readonly ApiContractOperation[] = [
  {
    method: 'get',
    path: '/api/v1/scheduled-jobs',
    operationId: 'listScheduledJobs',
    summary: 'List monthly job definitions and their latest proposal status',
    tag: 'scheduled-jobs',
    responseStatus: 200,
    responseSchema: 'ScheduledJobsPage',
    sessionOnly: true,
    parameters: [
      { name: 'cursor', location: 'query', schema: string },
      {
        name: 'per_page',
        location: 'query',
        schema: { type: 'integer', minimum: 1, maximum: 200 },
      },
    ],
  },
  {
    method: 'get',
    path: '/api/v1/scheduled-jobs/:id',
    operationId: 'getScheduledJob',
    summary: 'Read a month-end job definition',
    tag: 'scheduled-jobs',
    responseStatus: 200,
    responseSchema: 'ScheduledJobEnvelope',
    sessionOnly: true,
    parameters: [id],
  },
  {
    method: 'post',
    path: '/api/v1/scheduled-jobs',
    operationId: 'createScheduledJob',
    summary: 'Create a monthly job requiring authenticated confirmation',
    tag: 'scheduled-jobs',
    responseStatus: 201,
    responseSchema: 'ScheduledJobEnvelope',
    requestSchema: 'ScheduledJobCreate',
    requestRequired: true,
    sessionOnly: true,
  },
  {
    method: 'patch',
    path: '/api/v1/scheduled-jobs/:id',
    operationId: 'updateScheduledJob',
    summary: 'Update or pause a job against its reviewed version',
    tag: 'scheduled-jobs',
    responseStatus: 200,
    responseSchema: 'ScheduledJobEnvelope',
    requestSchema: 'ScheduledJobPatch',
    requestRequired: true,
    sessionOnly: true,
    parameters: [id],
  },
]
