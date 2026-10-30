import type { ApiContractOperation } from './contract.js'
const text = { type: 'string' } as const
const integer = { type: 'integer', minimum: 0 } as const
const bool = { type: 'boolean' } as const
const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] })
const array = (items: object) => ({ type: 'array', items })
const object = (properties: Record<string, unknown>, optional: readonly string[] = []) => ({
  type: 'object',
  properties,
  required: Object.keys(properties).filter((key) => !optional.includes(key)),
  additionalProperties: false,
})
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const command = {
  command_id: { type: 'string', format: 'uuid' },
  expected_generation: integer,
}
export const githubReaderSchemas = {
  GithubReaderInstallationsEnvelope: object({
    data: object({
      items: array(
        object({
          id: text,
          account: text,
          repository_selection: { type: 'string', enum: ['all', 'selected'] },
        }),
      ),
      next_page: nullable(integer),
    }),
  }),
  GithubReaderRepositoriesEnvelope: object({
    data: object({
      items: array(object({ id: text, full_name: text })),
      next_page: nullable(integer),
    }),
  }),
  GithubReaderSetupRequest: {
    type: 'object',
    properties: { organization: { type: 'string', minLength: 1, maxLength: 39 } },
    additionalProperties: false,
  },
  GithubReaderSetupEnvelope: object({ data: object({ registration_url: text, manifest: text }) }),
  GithubReaderResource: object({
    repository_id: text,
    full_name: nullable(text),
    project_id: nullable(integer),
    task_id: nullable(integer),
    state: {
      type: 'string',
      enum: ['active', 'renamed', 'transferred', 'deleted', 'access_lost'],
    },
    checkpoint_status: {
      type: 'string',
      enum: ['idle', 'running', 'complete'],
    },
    attempts: integer,
    next_retry_at: integer,
    failure_code: nullable(text),
    items_visible: integer,
    items_unavailable: integer,
  }),
  GithubReaderConnection: object({
    id: text,
    generation: integer,
    installation_id: text,
    state: {
      type: 'string',
      enum: ['active', 'disconnecting', 'disconnected', 'revoked'],
    },
    deferred_until: nullable(integer),
    failure_codes: array(text),
    resources: array(ref('GithubReaderResource')),
  }),
  GithubReaderStatusEnvelope: object({
    data: object(
      {
        app: nullable(object({ id: text, slug: text, installation_url: text })),
        configured: bool,
        publication_enabled: bool,
        setup_supported: bool,
        available: bool,
        owned_acceptance_required: bool,
        connections: array(ref('GithubReaderConnection')),
      },
      ['publication_enabled'],
    ),
  }),
  GithubReaderMapRequest: object({
    ...command,
    installation_id: text,
    repository_id: text,
    project_id: { type: 'integer', minimum: 1 },
    task_id: { type: 'integer', minimum: 1 },
  }),
  GithubReaderMapEnvelope: object({
    data: object({ connection_id: text, generation: integer }),
  }),
  GithubReaderDisconnectRequest: object({ ...command, connection_id: text }),
  GithubReaderDisconnectEnvelope: object({
    data: object({ generation: integer }),
  }),
  GithubReaderReconcileRequest: object({}),
  GithubReaderMetadataEnvelope: object({
    data: object({
      status: {
        type: 'string',
        enum: ['unverified', 'verified', 'unavailable'],
      },
      item: nullable(
        object({
          id: text,
          url: text,
          title: text,
          state: { type: 'string', enum: ['open', 'closed'] },
          updated_at: text,
        }),
      ),
    }),
  }),
} as const
export const githubReaderOperations: readonly ApiContractOperation[] = [
  {
    method: 'get',
    path: '/api/v1/work-items/github/setup/callback',
    operationId: 'completeGithubAppSetup',
    summary: 'Finish the private GitHub App registration',
    tag: 'work-items',
    sessionOnly: true,
    responseStatus: 303,
    generateClient: false,
    parameters: [
      { name: 'state', location: 'query', required: true, schema: text },
      { name: 'code', location: 'query', required: true, schema: text },
    ],
  },

  {
    method: 'get',
    path: '/api/v1/work-items/github/installations',
    operationId: 'listGithubReaderInstallations',
    summary: 'List read-enabled App installations',
    tag: 'work-items',
    sessionOnly: true,
    responseStatus: 200,
    responseSchema: 'GithubReaderInstallationsEnvelope',
    parameters: [
      { name: 'page', location: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
    ],
  },
  {
    method: 'get',
    path: '/api/v1/work-items/github/repositories',
    operationId: 'listGithubReaderRepositories',
    summary: 'List repository names available to the selected installation',
    tag: 'work-items',
    sessionOnly: true,
    responseStatus: 200,
    responseSchema: 'GithubReaderRepositoriesEnvelope',
    parameters: [
      { name: 'installation_id', location: 'query', required: true, schema: text },
      { name: 'page', location: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
    ],
  },

  {
    method: 'post',
    path: '/api/v1/work-items/github/setup',
    operationId: 'beginGithubAppSetup',
    summary: 'Prepare a private read-only GitHub App manifest',
    tag: 'work-items',
    sessionOnly: true,
    requestRequired: true,
    requestSchema: 'GithubReaderSetupRequest',
    responseStatus: 200,
    responseSchema: 'GithubReaderSetupEnvelope',
  },
  {
    method: 'get',
    path: '/api/v1/work-items/github/status',
    operationId: 'getGithubReaderStatus',
    summary: 'Inspect GitHub issue synchronization and deferred retries',
    tag: 'work-items',
    sessionOnly: true,
    responseStatus: 200,
    responseSchema: 'GithubReaderStatusEnvelope',
  },
  {
    method: 'post',
    path: '/api/v1/work-items/github/repositories',
    operationId: 'mapGithubRepository',
    summary: 'Verify an App installation repository and map it to a local task',
    tag: 'work-items',
    sessionOnly: true,
    requestRequired: true,
    requestSchema: 'GithubReaderMapRequest',
    responseStatus: 200,
    responseSchema: 'GithubReaderMapEnvelope',
  },
  {
    method: 'post',
    path: '/api/v1/work-items/github/disconnect',
    operationId: 'disconnectGithubReader',
    summary: 'Fence GitHub reads and deliveries while retaining local links',
    tag: 'work-items',
    sessionOnly: true,
    requestRequired: true,
    requestSchema: 'GithubReaderDisconnectRequest',
    responseStatus: 200,
    responseSchema: 'GithubReaderDisconnectEnvelope',
  },
  {
    method: 'post',
    path: '/api/v1/work-items/github/reconcile',
    operationId: 'reconcileGithubReader',
    summary: 'Schedule a bounded GitHub metadata reconciliation',
    tag: 'work-items',
    sessionOnly: true,
    requestRequired: true,
    requestSchema: 'GithubReaderReconcileRequest',
    responseStatus: 204,
  },
  {
    method: 'get',
    path: '/api/v1/work-item-links/:id/github',
    operationId: 'getGithubWorkItemMetadata',
    summary: 'Read verified issue metadata for an authorized local time link',
    tag: 'work-items',
    responseStatus: 200,
    responseSchema: 'GithubReaderMetadataEnvelope',
    parameters: [
      {
        name: 'id',
        location: 'path',
        required: true,
        schema: { type: 'integer', minimum: 1 },
      },
    ],
  },
]
