import type { ApiContractOperation } from './contract.js'

const string = { type: 'string' } as const
const integer = { type: 'integer' } as const
const bool = { type: 'boolean' } as const
const provider = { type: 'string', enum: ['wise', 'deel'] }
const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] })
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  required: Object.keys(properties),
  additionalProperties: false,
  properties,
})
const command = {
  id: string,
  user_id: { ...integer, minimum: 1 },
  month: string,
  expected_version: { ...integer, minimum: 0 },
  kind: { type: 'string', enum: ['amount', 'payment', 'void', 'opening', 'reopen', 'note'] },
  amount_cents: nullable(integer),
  currency: nullable(string),
  paid_on: nullable(string),
  due_on: nullable(string),
  reference: string,
  note: string,
  payment_id: nullable(string),
  source: { type: 'string', enum: ['wise', 'deel', 'historical'] },
}
const providerCommand = {
  id: string,
  user_id: nullable({ ...integer, minimum: 1 }),
  expected_version: { ...integer, minimum: 0 },
  provider: nullable(provider),
  note: string,
}
export const staffPaymentSchemas = {
  StaffPaymentProviderCommand: object(providerCommand),
  StaffPaymentProviderEvent: object({
    ...providerCommand,
    version: integer,
    actor_id: integer,
    actor_name: string,
    recorded_at: string,
    request_id: string,
  }),
  StaffPaymentProviderSettings: object({
    default_provider: provider,
    version: integer,
    events: { type: 'array', items: ref('StaffPaymentProviderEvent') },
  }),
  StaffPaymentCommand: object(command),
  StaffPaymentEvent: object({
    ...command,
    version: integer,
    actor_id: integer,
    actor_name: string,
    recorded_at: string,
    request_id: string,
  }),
  StaffPaymentRow: object({
    user_id: integer,
    name: string,
    active: bool,
    wise_ready: bool,
    deel_ready: bool,
    payout_provider: provider,
    provider_override: nullable(provider),
    provider_version: integer,
    month: string,
    version: integer,
    amount_cents: nullable(integer),
    currency: nullable(string),
    paid_cents: integer,
    balance_cents: nullable(integer),
    due_on: nullable(string),
    settled_through: nullable(string),
    status: { type: 'string', enum: ['in_progress', 'pending', 'partial', 'paid', 'settled'] },
    overdue: bool,
    events: { type: 'array', items: ref('StaffPaymentEvent') },
  }),
  StaffPaymentReport: object({
    month: string,
    as_of: string,
    rows: { type: 'array', items: ref('StaffPaymentRow') },
    provider_settings: ref('StaffPaymentProviderSettings'),
  }),
  StaffPaymentReportEnvelope: object({ data: ref('StaffPaymentReport') }),
}
export const staffPaymentOperations: readonly ApiContractOperation[] = [
  {
    method: 'post',
    path: '/api/v1/staff-payments/provider-settings',
    operationId: 'configureStaffPaymentProvider',
    summary: 'Set the organization payout provider or a person override',
    tag: 'staff-payments',
    responseStatus: 204,
    requestSchema: 'StaffPaymentProviderCommand',
    requestRequired: true,
    sessionOnly: true,
  },
  {
    method: 'get',
    path: '/api/v1/staff-payments',
    operationId: 'getStaffPaymentReport',
    summary: 'Monthly staff payment register and audit history',
    tag: 'staff-payments',
    responseStatus: 200,
    responseSchema: 'StaffPaymentReportEnvelope',
    sessionOnly: true,
    parameters: [{ name: 'month', location: 'query', schema: string }],
  },
  {
    method: 'post',
    path: '/api/v1/staff-payments/events',
    operationId: 'recordStaffPaymentEvent',
    summary: 'Record a staff payment, obligation, correction, or historical settlement',
    tag: 'staff-payments',
    responseStatus: 204,
    requestSchema: 'StaffPaymentCommand',
    requestRequired: true,
    sessionOnly: true,
  },
]
