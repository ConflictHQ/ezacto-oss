import type { ApiContractOperation } from './contract.js'
const s = { type: 'string' } as const
const n = { type: 'integer' } as const
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] })
const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  required: Object.keys(properties),
  additionalProperties: false,
  properties,
})
export const scheduledRunSchemas = {
  ScheduledReviewLinkInput: {
    type: 'object',
    required: ['token'],
    additionalProperties: false,
    properties: {
      token: {
        type: 'string',
        pattern: '^[A-Za-z0-9_-]{43}\\.[A-Za-z0-9_-]{43}$',
        writeOnly: true,
      },
    },
  },
  ScheduledReviewLinkEnvelope: object({ data: object({ path: s }) }),
  ScheduledRunConfirmInput: {
    type: 'object',
    additionalProperties: false,
    properties: { acknowledge_report_warnings: { type: 'boolean' } },
  },
  ScheduledRunItem: object({
    report_people: { type: 'array', items: object({ id: n, name: s, seconds: n }) },
    report_name: nullable(s),
    report_warnings: {
      type: 'array',
      items: object({
        entryId: n,
        kind: { type: 'string', enum: ['url', 'mention', 'ticket_reference', 'teammate_name'] },
        match: s,
      }),
    },
    attempt_limit: n,
    delivery_id: nullable(n),
    delivery_status: nullable(s),
    id: n,
    subject_type: s,
    subject_id: n,
    description: s,
    amount_cents: nullable(n),
    currency: nullable(s),
    target: nullable(s),
    quantity_seconds: nullable({ type: 'integer', minimum: 0 }),
    client_name: nullable(s),
    state: {
      type: 'string',
      enum: ['pending', 'running', 'done', 'failed'],
    },
    attempt_count: n,
    failure_reason: nullable(s),
    completed_at: nullable(s),
  }),
  ScheduledRun: object({
    id: n,
    job_id: n,
    occurrence_key: s,
    state: {
      type: 'string',
      enum: ['proposed', 'confirmed', 'cancelled', 'expired', 'completed'],
    },
    proposed_at: s,
    expires_at: s,
    confirmed_by: nullable(n),
    confirmed_at: nullable(s),
    settled_reason: nullable(s),
    items: { type: 'array', items: ref('ScheduledRunItem') },
  }),
  ScheduledRunEnvelope: object({ data: ref('ScheduledRun') }),
}
const id = { name: 'id', location: 'path', required: true, schema: n } as const
export const scheduledRunOperations: readonly ApiContractOperation[] = [
  {
    method: 'post',
    path: '/api/v1/scheduled-runs/:id/review-link',
    operationId: 'consumeScheduledReviewLink',
    summary:
      'Record the single authenticated opening of an expiring email review link; never confirm or execute',
    tag: 'scheduled-runs',
    responseStatus: 200,
    responseSchema: 'ScheduledReviewLinkEnvelope',
    requestSchema: 'ScheduledReviewLinkInput',
    sessionOnly: true,
    parameters: [id],
  },
  {
    method: 'get',
    path: '/api/v1/scheduled-runs/:id/items/:itemId/report',
    operationId: 'downloadScheduledRunReport',
    summary: 'Download the exact saved report an administrator is reviewing',
    tag: 'scheduled-runs',
    responseStatus: 200,
    binaryResponse: true,
    sessionOnly: true,
    parameters: [id, { ...id, name: 'itemId' }],
  },
  {
    method: 'post',
    path: '/api/v1/scheduled-runs/:id/retry',
    operationId: 'retryScheduledRun',
    summary: 'Authorize another bounded attempt window for exhausted failed items only',
    tag: 'scheduled-runs',
    responseStatus: 200,
    responseSchema: 'ScheduledRunEnvelope',
    sessionOnly: true,
    parameters: [id],
  },
  {
    method: 'get',
    path: '/api/v1/scheduled-runs/:id',
    operationId: 'getScheduledRun',
    summary: 'Read a proposed run and the concrete items it would act on',
    tag: 'scheduled-runs',
    responseStatus: 200,
    responseSchema: 'ScheduledRunEnvelope',
    sessionOnly: true,
    parameters: [id],
  },
  {
    method: 'post',
    path: '/api/v1/scheduled-runs/:id/confirm',
    operationId: 'confirmScheduledRun',
    requestSchema: 'ScheduledRunConfirmInput',
    requestRequired: false,
    summary: 'Confirm a proposed run; a second confirmation changes nothing',
    description:
      'Refused with 409 once the run has lapsed, which also settles it as expired, or if it was cancelled.',
    tag: 'scheduled-runs',
    responseStatus: 200,
    responseSchema: 'ScheduledRunEnvelope',
    sessionOnly: true,
    parameters: [id],
  },
  {
    method: 'post',
    path: '/api/v1/scheduled-runs/:id/cancel',
    operationId: 'cancelScheduledRun',
    summary: 'Cancel a proposed run that has not been confirmed',
    tag: 'scheduled-runs',
    responseStatus: 200,
    responseSchema: 'ScheduledRunEnvelope',
    sessionOnly: true,
    parameters: [id],
  },
]
