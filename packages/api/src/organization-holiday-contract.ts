import type { ApiContractOperation } from './contract.js'
const str = { type: 'string' },
  date = { type: 'string', format: 'date' },
  version = { type: 'integer', minimum: 0 },
  id = { type: 'integer', minimum: 1 }
const name = { type: 'string', minLength: 1, maxLength: 120 }
const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
})
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const path = { name: 'id', location: 'path' as const, required: true, schema: id }
const base = {
  tag: 'capacity',
  description:
    'Organization-wide local calendar dates. Reads require schedule:read. Only administrators with schedule:write may change dates. Each weekday removes one fifth of the person’s current weekly capacity; weekends remove none. Overlapping personal leave and holidays use the larger daily amount, never their sum. No tracked time or invoices are changed.',
}
export const organizationHolidayOperations: ApiContractOperation[] = [
  {
    ...base,
    method: 'get',
    path: '/api/v1/organization-holidays',
    operationId: 'listOrganizationHolidays',
    summary: 'List organization holidays',
    responseStatus: 200,
    responseSchema: 'OrganizationHolidayPage',
    parameters: [
      { name: 'from', location: 'query', schema: date },
      { name: 'to', location: 'query', schema: date },
      { name: 'cursor', location: 'query', schema: str },
      {
        name: 'per_page',
        location: 'query',
        schema: { type: 'integer', minimum: 1, maximum: 200 },
      },
    ],
  },
  {
    ...base,
    method: 'get',
    path: '/api/v1/organization-holidays/:id',
    operationId: 'getOrganizationHoliday',
    summary: 'Read an organization holiday',
    responseStatus: 200,
    responseSchema: 'OrganizationHolidayEnvelope',
    parameters: [path],
  },
  {
    ...base,
    method: 'post',
    path: '/api/v1/organization-holidays',
    operationId: 'createOrganizationHoliday',
    summary: 'Add an organization holiday',
    responseStatus: 201,
    responseSchema: 'OrganizationHolidayEnvelope',
    requestSchema: 'OrganizationHolidayInput',
    requestRequired: true,
  },
  {
    ...base,
    method: 'patch',
    path: '/api/v1/organization-holidays/:id',
    operationId: 'updateOrganizationHoliday',
    summary: 'Replace holiday fields at their current version',
    responseStatus: 200,
    responseSchema: 'OrganizationHolidayEnvelope',
    requestSchema: 'OrganizationHolidayUpdateInput',
    requestRequired: true,
    parameters: [path],
  },
  {
    ...base,
    method: 'delete',
    path: '/api/v1/organization-holidays/:id',
    operationId: 'deleteOrganizationHoliday',
    summary: 'Remove an organization holiday at its current version',
    responseStatus: 200,
    responseSchema: 'OrganizationHolidayEnvelope',
    requestSchema: 'OrganizationHolidayDeleteInput',
    requestRequired: true,
    parameters: [path],
  },
]
export const organizationHolidaySchemas = {
  OrganizationHoliday: object({
    id,
    date,
    name,
    version,
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: 'string', format: 'date-time' },
  }),
  OrganizationHolidayInput: object({ date, name }),
  OrganizationHolidayUpdateInput: object({ date, name, version }),
  OrganizationHolidayDeleteInput: object({ version }),
  OrganizationHolidayEnvelope: object({
    data: ref('OrganizationHoliday'),
    links: object({ self: str }),
  }),
  OrganizationHolidayPage: object({
    data: { type: 'array', items: ref('OrganizationHoliday') },
    links: object({ self: str, next: { anyOf: [str, { type: 'null' }] } }),
    page: object({ per_page: id, next_cursor: { anyOf: [str, { type: 'null' }] } }),
  }),
}
