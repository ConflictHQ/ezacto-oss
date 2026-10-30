import type { ApiContractOperation } from './contract.js'
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const envelope = (name: string) => ({
  type: 'object',
  required: ['data'],
  properties: { data: ref(name) },
  additionalProperties: false,
})
const key = {
  name: 'Idempotency-Key',
  location: 'header' as const,
  required: true,
  schema: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9._:-]+$' },
}
export const invoiceElevationOperations: ApiContractOperation[] = [
  {
    method: 'post',
    path: '/api/v1/invoice-elevations/email-code',
    operationId: 'sendInvoiceElevationEmailCode',
    summary: 'Send a second-factor code and rotate its bound elevation challenge',
    description:
      'Requires the original administrator API token and pending challenge. The replacement remains bound to its original password verification, base token and invoice. Use the returned challenge token; the earlier one is no longer valid.',
    tokenOnly: true,
    tag: 'invoice-elevations',
    responseStatus: 200,
    responseSchema: 'InvoiceElevationChallengeEnvelope',
    requestSchema: 'InvoiceElevationEmailInput',
    requestRequired: true,
  },

  {
    method: 'post',
    path: '/api/v1/invoice-elevations',
    operationId: 'createInvoiceElevation',
    summary: 'Reauthenticate an administrator for temporary draft invoice edits',
    description:
      'Requires an administrator API token with invoices:write, live password authentication, and the same verified user credentials. Confirmed authenticator or email MFA requires a bound second step. The returned capability belongs to this base token and invoice, lasts at most 15 minutes, and is returned once. Credential responses cannot be replayed from the HTTP cache.',
    tokenOnly: true,
    tag: 'invoice-elevations',
    responseStatus: 201,
    additionalResponseStatuses: [202],
    responseSchema: 'InvoiceElevationStartEnvelope',
    requestSchema: 'InvoiceElevationInput',
    requestRequired: true,
  },
  {
    method: 'post',
    path: '/api/v1/invoice-elevations/verify',
    operationId: 'verifyInvoiceElevation',
    summary: 'Complete the bound second factor for a draft invoice elevation',
    description:
      'A valid MFA challenge can only be completed by its original administrator and base API token. The verified capability never creates a browser session.',
    tokenOnly: true,
    tag: 'invoice-elevations',
    responseStatus: 201,
    responseSchema: 'InvoiceElevationIssuedEnvelope',
    requestSchema: 'InvoiceElevationVerifyInput',
    requestRequired: true,
  },
  {
    method: 'delete',
    path: '/api/v1/invoice-elevations/:id',
    operationId: 'revokeInvoiceElevation',
    summary: 'Revoke this administrator token’s temporary invoice capability',
    tokenOnly: true,
    tag: 'invoice-elevations',
    responseStatus: 204,
    parameters: [{ name: 'id', location: 'path', required: true, schema: { type: 'string' } }],
  },
  {
    method: 'post',
    path: '/api/v1/invoices/:id/unlink-time',
    operationId: 'unlinkElevatedInvoiceTime',
    summary: 'Atomically unlink selected time from one draft invoice',
    description:
      'Administrator API token only; requires invoices:write, time_entries:write and X-Ezacto-Invoice-Elevation bound to this invoice. All selected stopped entries must still belong to the same current draft. The whole command and its before/after audit commit together. Invoice line amounts remain unchanged.',
    tokenOnly: true,
    tag: 'invoice-elevations',
    responseStatus: 200,
    responseSchema: 'ElevatedInvoiceTimeUnlinkEnvelope',
    requestSchema: 'ElevatedInvoiceTimeUnlinkInput',
    requestRequired: true,
    parameters: [
      { name: 'id', location: 'path', required: true, schema: { type: 'integer', minimum: 1 } },
      key,
      {
        name: 'X-Ezacto-Invoice-Elevation',
        location: 'header',
        required: true,
        schema: { type: 'string', pattern: '^ezi_[0-9a-f]{64}$' },
      },
    ],
  },
]
export const invoiceElevationSchemas = {
  InvoiceElevationChallengeEnvelope: envelope('InvoiceElevationChallenge'),
  InvoiceElevationEmailInput: {
    type: 'object',
    required: ['challenge_token'],
    properties: {
      challenge_token: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$', writeOnly: true },
    },
    additionalProperties: false,
  },
  InvoiceElevationInput: {
    type: 'object',
    required: ['invoice_id', 'email', 'password'],
    properties: {
      invoice_id: { type: 'integer', minimum: 1 },
      email: { type: 'string', format: 'email', maxLength: 320 },
      password: {
        type: 'string',
        minLength: 1,
        maxLength: 1024,
        writeOnly: true,
        description: 'At most 4096 UTF-8 bytes; never an argv argument or a stored CLI setting.',
      },
    },
    additionalProperties: false,
  },
  InvoiceElevationVerifyInput: {
    type: 'object',
    required: ['challenge_token', 'code'],
    properties: {
      challenge_token: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$', writeOnly: true },
      code: { type: 'string', minLength: 1, maxLength: 64, writeOnly: true },
    },
    additionalProperties: false,
  },
  InvoiceElevationIssued: {
    type: 'object',
    required: ['status', 'credential', 'id', 'invoice_id', 'expires_at', 'scope'],
    properties: {
      status: { type: 'string', const: 'elevated' },
      credential: {
        type: 'string',
        pattern: '^ezi_[0-9a-f]{64}$',
        description:
          'Returned once; keep only in process memory and send as X-Ezacto-Invoice-Elevation with the original API token.',
      },
      id: { type: 'string' },
      invoice_id: { type: 'integer', minimum: 1 },
      expires_at: { type: 'string', format: 'date-time' },
      scope: { type: 'string', const: 'invoice_drafts:write' },
    },
    additionalProperties: false,
  },
  InvoiceElevationChallenge: {
    type: 'object',
    required: ['status', 'challenge_token', 'expires_at', 'methods'],
    properties: {
      status: { type: 'string', const: 'challenge_required' },
      challenge_token: { type: 'string' },
      expires_at: { type: 'string', format: 'date-time' },
      methods: {
        type: 'array',
        items: { type: 'string', enum: ['totp', 'email'] },
        minItems: 1,
        maxItems: 2,
      },
    },
    additionalProperties: false,
  },
  InvoiceElevationStartEnvelope: {
    type: 'object',
    required: ['data'],
    properties: {
      data: { anyOf: [ref('InvoiceElevationIssued'), ref('InvoiceElevationChallenge')] },
    },
    additionalProperties: false,
  },
  InvoiceElevationIssuedEnvelope: envelope('InvoiceElevationIssued'),
  ElevatedInvoiceTimeUnlinkInput: {
    type: 'object',
    required: ['expected_version', 'entry_ids', 'confirmed'],
    properties: {
      expected_version: { type: 'integer', minimum: 0 },
      entry_ids: {
        type: 'array',
        items: { type: 'integer', minimum: 1 },
        minItems: 1,
        maxItems: 1000,
        uniqueItems: true,
      },
      confirmed: { type: 'boolean', const: true },
    },
    additionalProperties: false,
  },
  ElevatedInvoiceTimeUnlink: {
    type: 'object',
    required: [
      'invoice_id',
      'command_id',
      'elevation_id',
      'released_entry_ids',
      'recorded_at',
      'replayed',
    ],
    properties: {
      invoice_id: { type: 'integer', minimum: 1 },
      command_id: { type: 'string' },
      elevation_id: { type: 'string' },
      released_entry_ids: { type: 'array', items: { type: 'integer', minimum: 1 } },
      recorded_at: { type: 'string', format: 'date-time' },
      replayed: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  ElevatedInvoiceTimeUnlinkEnvelope: envelope('ElevatedInvoiceTimeUnlink'),
} as const

const tokenEditIds = new Set([
  'updateInvoice',
  'createInvoiceLine',
  'updateInvoiceLine',
  'deleteInvoiceLine',
])
export const documentInvoiceTokenElevation = (
  operation: ApiContractOperation,
): ApiContractOperation =>
  tokenEditIds.has(operation.operationId)
    ? {
        ...operation,
        description:
          (operation.description ?? '') +
          ' API-token edits require an administrator and X-Ezacto-Invoice-Elevation bound to this base token and draft invoice. Browser sessions retain their existing policy.',
        parameters: [
          ...(operation.parameters ?? []),
          {
            name: 'X-Ezacto-Invoice-Elevation',
            location: 'header',
            required: false,
            schema: { type: 'string', pattern: '^ezi_[0-9a-f]{64}$' },
          },
        ],
      }
    : operation
