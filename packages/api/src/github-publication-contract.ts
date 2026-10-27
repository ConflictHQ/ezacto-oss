import type { ApiContractOperation } from './contract.js'
const text = { type: 'string' } as const,
  integer = { type: 'integer', minimum: 0 } as const,
  bool = { type: 'boolean' } as const
const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
})
const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] })
const array = (items: object) => ({ type: 'array', items, maxItems: 100 })
const command_id = { type: 'string', format: 'uuid' }
export const githubPublicationSchemas = {
  GithubPublicationsEnvelope: object({
    data: object({
      policies: array(object({ connection_id: text, enabled: bool, generation: integer })),
      publications: array(
        object({
          id: integer,
          connection_id: text,
          entry_id: integer,
          destination: text,
          spent_date: nullable(text),
          seconds: nullable(integer),
          status: text,
          source_version: integer,
          version: integer,
          remote_id: nullable(text),
          failure_code: nullable(text),
          next_retry_at: nullable(integer),
        }),
      ),
      candidates: array(object({ link_id: integer, entry_id: integer })),
    }),
  }),
  GithubPublicationPreviewEnvelope: object({
    data: object({
      link_id: integer,
      connection_id: text,
      destination: text,
      spent_date: text,
      seconds: integer,
      source_version: text,
      policy_enabled: bool,
    }),
  }),
  GithubPublicationPolicyRequest: object({
    connection_id: text,
    expected_generation: integer,
    enabled: bool,
    confirm_permission: bool,
    command_id,
  }),
  GithubPublicationConsentRequest: object({ link_id: integer, source_version: text, command_id }),
  GithubPublicationActionRequest: object({
    expected_version: integer,
    action: { type: 'string', enum: ['retry', 'adopt', 'restore', 'unlink'] },
    confirm: bool,
    command_id,
  }),
}
const root = '/api/v1/work-items/github/publication'
export const githubPublicationOperations: readonly ApiContractOperation[] = [
  {
    method: 'get',
    path: root,
    operationId: 'getGithubPublications',
    summary: 'Inspect opted-in GitHub time publication',
    tag: 'work-items',
    sessionOnly: true,
    responseStatus: 200,
    responseSchema: 'GithubPublicationsEnvelope',
  },
  {
    method: 'get',
    path: root + '/preview/:id',
    operationId: 'previewGithubPublication',
    summary: 'Preview date and duration before publication consent',
    tag: 'work-items',
    sessionOnly: true,
    responseStatus: 200,
    responseSchema: 'GithubPublicationPreviewEnvelope',
    parameters: [{ name: 'id', location: 'path', required: true, schema: integer }],
  },
  {
    method: 'post',
    path: root + '/policy',
    operationId: 'setGithubPublicationPolicy',
    summary: 'Explicitly enable or disable verified Issues-write publication',
    tag: 'work-items',
    sessionOnly: true,
    responseStatus: 204,
    requestRequired: true,
    requestSchema: 'GithubPublicationPolicyRequest',
  },
  {
    method: 'post',
    path: root + '/consent',
    operationId: 'consentGithubPublication',
    summary: 'Opt one reviewed time link into publication',
    tag: 'work-items',
    sessionOnly: true,
    responseStatus: 204,
    requestRequired: true,
    requestSchema: 'GithubPublicationConsentRequest',
  },
  {
    method: 'post',
    path: root + '/:id/actions',
    operationId: 'actGithubPublication',
    summary: 'Resolve a publication conflict or retry decision',
    tag: 'work-items',
    sessionOnly: true,
    responseStatus: 204,
    requestRequired: true,
    requestSchema: 'GithubPublicationActionRequest',
    parameters: [{ name: 'id', location: 'path', required: true, schema: integer }],
  },
]
