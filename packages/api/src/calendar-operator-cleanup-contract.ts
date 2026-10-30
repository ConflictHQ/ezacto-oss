import type { ApiContractOperation } from './contract.js'
const text = { type: 'string', minLength: 1, maxLength: 256 } as const
const positive = { type: 'integer', minimum: 1 } as const
const identity = {
  id: text,
  user_id: positive,
  provider: { type: 'string', enum: ['google', 'microsoft'] },
  instance_nonce: text,
  generation: positive,
  credential_revision: positive,
  key_id: text,
  request_id: { anyOf: [text, { type: 'null' }] },
  reason: { type: 'string', enum: ['disconnect', 'closure', 'reauth', 'restore', 'reset'] },
  review_instance: text,
}
export const calendarOperatorCleanupOperations: readonly ApiContractOperation[] = [
  {
    method: 'get',
    path: '/api/v1/admin/calendar-cleanup',
    operationId: 'listCalendarOperatorCleanup',
    summary: 'Review retained old-incarnation and closed-account calendar cleanup',
    tag: 'time-entries',
    sessionOnly: true,
    responseStatus: 200,
    responseSchema: 'CalendarOperatorCleanupList',
    parameters: [{ name: 'after', location: 'query', schema: text }],
  },
  {
    method: 'post',
    path: '/api/v1/admin/calendar-cleanup/confirm',
    operationId: 'confirmCalendarOperatorCleanup',
    summary: 'Record administrator evidence of exact calendar permission removal',
    description:
      'Operator attestation only; never provider verification. Requires the complete reviewed custody identity.',
    tag: 'time-entries',
    sessionOnly: true,
    responseStatus: 200,
    responseSchema: 'CalendarOperatorCleanupReceiptEnvelope',
    requestSchema: 'CalendarOperatorCleanupInput',
    requestRequired: true,
  },
]
export const calendarOperatorCleanupSchemas = {
  CalendarOperatorCleanupList: {
    type: 'object',
    additionalProperties: false,
    required: ['data', 'page'],
    properties: {
      data: {
        type: 'array',
        maxItems: 100,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            ...Object.keys(identity),
            'status',
            'created_at',
            'provider_cleanup_in_progress',
          ],
          properties: {
            ...identity,
            status: { type: 'string', enum: ['pending', 'manual_required'] },
            created_at: { type: 'string' },
            provider_cleanup_in_progress: { type: 'boolean' },
          },
        },
      },
      page: {
        type: 'object',
        additionalProperties: false,
        required: ['next_cursor'],
        properties: { next_cursor: { anyOf: [text, { type: 'null' }] } },
      },
    },
  },
  CalendarOperatorCleanupInput: {
    type: 'object',
    additionalProperties: false,
    required: [
      ...Object.keys(identity),
      'expected_status',
      'evidence_reference',
      'confirm_provider_removed',
    ],
    properties: {
      ...identity,
      expected_status: { type: 'string', enum: ['pending', 'manual_required'] },
      evidence_reference: { type: 'string', minLength: 20, maxLength: 1000 },
      confirm_provider_removed: { type: 'boolean', const: true },
    },
  },
  CalendarOperatorCleanupReceiptEnvelope: {
    type: 'object',
    additionalProperties: false,
    required: ['data'],
    properties: {
      data: {
        type: 'object',
        additionalProperties: false,
        required: ['obligation_id', 'kind', 'provider_verified', 'attested_at', 'evidence_sha256'],
        properties: {
          obligation_id: text,
          kind: { type: 'string', enum: ['operator_attestation'] },
          provider_verified: { type: 'boolean', const: false },
          attested_at: { type: 'string' },
          evidence_sha256: { type: 'string', minLength: 64, maxLength: 64 },
        },
      },
    },
  },
} as const
