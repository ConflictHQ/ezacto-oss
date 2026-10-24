import { webhookEventTypes, webhookDeliveryStatuses, webhookDeliveryErrors } from '@ezacto/core'
import type { ApiContractOperation } from './contract.js'
const str = { type: 'string' },
  integer = { type: 'integer', minimum: 0 }
const instant = { type: 'string', format: 'date-time' }
const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] })
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
})
const envelope = (name: string) => object({ data: ref(name) })
const uuid = { type: 'string', format: 'uuid' }
const events = {
  type: 'array',
  items: { type: 'string', enum: webhookEventTypes },
  minItems: 1,
  maxItems: webhookEventTypes.length,
  uniqueItems: true,
}
const version = { type: 'integer', minimum: 1 }
const id = { name: 'id', location: 'path' as const, required: true, schema: str }
const key = {
  name: 'Idempotency-Key',
  location: 'header' as const,
  schema: { type: 'string', maxLength: 128 },
}
const base = {
  tag: 'outbound-webhooks',
  sessionOnly: true,
  description:
    'Administrator session only. Events contain identifiers, resource sequence and relative API links. Secret issuance is returned once and cannot be replayed from the idempotency cache. Public demo delivery is disabled.',
}
export const outboundWebhookOperations: ApiContractOperation[] = [
  {
    ...base,
    method: 'get',
    path: '/api/v1/webhook-subscriptions',
    operationId: 'listWebhookSubscriptions',
    summary: 'List subscriptions and webhook configuration',
    responseStatus: 200,
    responseSchema: 'WebhookSubscriptionsEnvelope',
  },
  {
    ...base,
    method: 'post',
    path: '/api/v1/webhook-subscriptions',
    operationId: 'createWebhookSubscription',
    summary: 'Create an endpoint and issue its signing secret once',
    responseStatus: 201,
    responseSchema: 'WebhookSecretEnvelope',
    requestSchema: 'WebhookCreateInput',
    requestRequired: true,
    parameters: [key],
  },
  {
    ...base,
    method: 'patch',
    path: '/api/v1/webhook-subscriptions/:id',
    operationId: 'setWebhookSubscriptionActive',
    summary: 'Pause or resume an endpoint at its current version',
    responseStatus: 200,
    responseSchema: 'WebhookSubscriptionEnvelope',
    requestSchema: 'WebhookActiveInput',
    requestRequired: true,
    parameters: [id, key],
  },
  {
    ...base,
    method: 'post',
    path: '/api/v1/webhook-subscriptions/:id/rotate-secret',
    operationId: 'rotateWebhookSecret',
    summary: 'Rotate a signing secret with a bounded overlap',
    responseStatus: 200,
    responseSchema: 'WebhookSecretEnvelope',
    requestSchema: 'WebhookRotateInput',
    requestRequired: true,
    parameters: [id, key],
  },
  {
    ...base,
    method: 'delete',
    path: '/api/v1/webhook-subscriptions/:id',
    operationId: 'deleteWebhookSubscription',
    summary: 'Delete an endpoint and erase its sealed signing secrets',
    responseStatus: 200,
    responseSchema: 'WebhookSubscriptionEnvelope',
    requestSchema: 'WebhookVersionInput',
    requestRequired: true,
    parameters: [id, key],
  },
  {
    ...base,
    method: 'get',
    path: '/api/v1/webhook-deliveries',
    operationId: 'listWebhookDeliveries',
    summary: 'Page through webhook delivery results',
    responseStatus: 200,
    responseSchema: 'WebhookDeliveryPage',
    parameters: [
      { name: 'subscription_id', location: 'query', schema: uuid },
      {
        name: 'status',
        location: 'query',
        schema: { type: 'string', enum: webhookDeliveryStatuses },
      },
      {
        name: 'per_page',
        location: 'query',
        schema: { type: 'integer', minimum: 1, maximum: 200 },
      },
      { name: 'cursor', location: 'query', schema: str },
    ],
  },
  {
    ...base,
    method: 'post',
    path: '/api/v1/webhook-deliveries/:id/replay',
    operationId: 'replayWebhookDelivery',
    summary: 'Replay a settled delivery from the last seven days',
    responseStatus: 202,
    responseSchema: 'WebhookDeliveryEnvelope',
    requestSchema: 'WebhookReplayInput',
    requestRequired: true,
    parameters: [id, key],
  },
]
export const outboundWebhookSchemas = {
  WebhookSubscription: object({
    id: uuid,
    url: { type: 'string', format: 'uri' },
    events,
    is_active: { type: 'boolean' },
    version: integer,
    generation: version,
    previous_valid_until: nullable(instant),
    created_at: instant,
    updated_at: instant,
    deleted_at: nullable(instant),
  }),
  WebhookSubscriptionsEnvelope: object({
    data: { type: 'array', items: ref('WebhookSubscription') },
    configuration: object({
      ready: { type: 'boolean' },
      event_types: events,
      max_subscriptions: integer,
      rotation_overlap_seconds: integer,
    }),
    links: object({ self: str }),
  }),
  WebhookSubscriptionEnvelope: envelope('WebhookSubscription'),
  WebhookSecretEnvelope: object({
    data: ref('WebhookSubscription'),
    signing_secret: {
      type: 'string',
      pattern: '^ezwh_[A-Za-z0-9_-]{43}$',
      description:
        'Copy once. Store securely at the receiver; never logged or returned by list endpoints.',
    },
  }),
  WebhookCreateInput: object({ url: { type: 'string', maxLength: 2048 }, events }),
  WebhookActiveInput: object({ version: integer, is_active: { type: 'boolean' } }),
  WebhookRotateInput: object(
    {
      version: integer,
      overlap_seconds: { type: 'integer', minimum: 0, maximum: 86400, default: 900 },
    },
    ['version'],
  ),
  WebhookVersionInput: object({ version: integer }),
  WebhookReplayInput: object({}),
  WebhookDelivery: object({
    id: str,
    subscription_id: uuid,
    event_id: str,
    event_type: { type: 'string', enum: webhookEventTypes },
    payload_json: str,
    status: { type: 'string', enum: webhookDeliveryStatuses },
    attempt_count: integer,
    cycle_attempts: integer,
    replay_count: integer,
    last_status: nullable(integer),
    last_error_code: nullable({ type: 'string', enum: webhookDeliveryErrors }),
    next_attempt_at: nullable(instant),
    last_attempt_at: nullable(instant),
    delivered_at: nullable(instant),
    failed_at: nullable(instant),
    created_at: instant,
    updated_at: instant,
  }),
  WebhookDeliveryEnvelope: envelope('WebhookDelivery'),
  WebhookDeliveryPage: object({
    data: { type: 'array', items: ref('WebhookDelivery') },
    links: object({ self: str, next: nullable(str) }),
    page: object({ per_page: integer, next_cursor: nullable(str) }),
  }),
}
