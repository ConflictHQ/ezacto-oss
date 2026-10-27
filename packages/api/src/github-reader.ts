import { installGithubPublicationRoutes } from './github-publication.js'
import type { GithubPublicationPort } from '@ezacto/integrations'
import type { Context, Hono } from 'hono'
import type { ApiContext } from './context.js'
import { GithubReaderCommandError } from '@ezacto/integrations'
import { requireApiScope, requireSessionPrincipal } from './auth.js'
import { ApiError } from './errors.js'
import {
  assertFields,
  readObjectBody,
  unknownFieldErrors,
  resourceId,
} from './resources/support.js'

export interface GithubReaderAdminAuthority {
  userId: number
  sessionId: number
}
export interface GithubReaderConnectionStatus {
  id: string
  generation: number
  installation_id: string
  state: 'active' | 'disconnecting' | 'disconnected' | 'revoked'
  resources: readonly {
    repository_id: string
    full_name: string | null
    project_id: number | null
    task_id: number | null
    state: 'active' | 'renamed' | 'transferred' | 'deleted' | 'access_lost'
    checkpoint_status: 'idle' | 'running' | 'complete'
    attempts: number
    next_retry_at: number
    failure_code: string | null
    items_visible: number
    items_unavailable: number
  }[]
  deferred_until: number | null
  failure_codes: readonly string[]
}
export interface GithubReaderStatus {
  publication_enabled?: boolean
  configured: boolean
  setup_supported: boolean
  available: boolean
  app: { id: string; slug: string; installation_url: string } | null
  owned_acceptance_required: true
  connections: readonly GithubReaderConnectionStatus[]
}
export interface GithubReaderMapCommand {
  command_id: string
  expected_generation: number
  installation_id: string
  repository_id: string
  project_id: number
  task_id: number
}
export interface GithubReaderDisconnectCommand {
  command_id: string
  expected_generation: number
  connection_id: string
}
/** Native runtime surface. App private key, webhook secret and short-lived token
 * are never members of this API port or any serialized result. */
export interface GithubReaderApiPort {
  publication?: GithubPublicationPort
  installations(
    authority: GithubReaderAdminAuthority,
    page: number,
  ): Promise<{
    items: { id: string; account: string; repository_selection: 'all' | 'selected' }[]
    next_page: number | null
  }>
  repositories(
    authority: GithubReaderAdminAuthority,
    installationId: string,
    page: number,
  ): Promise<{ items: { id: string; full_name: string }[]; next_page: number | null }>

  beginSetup(
    authority: GithubReaderAdminAuthority,
    organization?: string,
  ): Promise<{ registration_url: string; manifest: string }>
  completeSetup(authority: GithubReaderAdminAuthority, state: string, code: string): Promise<void>
  status(authority: GithubReaderAdminAuthority): Promise<GithubReaderStatus>
  map(
    authority: GithubReaderAdminAuthority,
    command: GithubReaderMapCommand,
  ): Promise<{ connection_id: string; generation: number }>
  disconnect(
    authority: GithubReaderAdminAuthority,
    command: GithubReaderDisconnectCommand,
  ): Promise<{ generation: number }>
  reconcile(authority: GithubReaderAdminAuthority): Promise<void>
  linkedItem(
    actor: { userId: number; profile: string },
    linkId: number,
  ): Promise<{
    status: 'unverified' | 'verified' | 'unavailable'
    item: {
      id: string
      url: string
      title: string
      state: 'open' | 'closed'
      updated_at: string
    } | null
  } | null>
}
export class GithubReaderApiError extends GithubReaderCommandError {
  constructor(kind: 'forbidden' | 'conflict' | 'command_reused' | 'unavailable' | 'invalid') {
    super(kind)
    this.name = 'GithubReaderApiError'
  }
}
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const providerId = (value: unknown): value is string =>
  typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value))
const number = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const translate = (error: unknown): never => {
  if (error instanceof GithubReaderCommandError)
    throw new ApiError({
      status:
        error.kind === 'forbidden'
          ? 403
          : error.kind === 'invalid'
            ? 422
            : error.kind === 'unavailable'
              ? 503
              : 409,
      ...(error.kind === 'invalid'
        ? {
            fields: [
              {
                field: 'command',
                code: 'invalid',
                message: 'Review the current GitHub reader configuration and retry.',
              },
            ],
          }
        : {}),
      code: `github_reader_${error.kind}`,
      message:
        error.kind === 'forbidden'
          ? 'A current native administrator session is required.'
          : error.kind === 'unavailable'
            ? 'GitHub read setup is unavailable.'
            : 'Review the current GitHub reader configuration and retry.',
    })
  throw error
}
export const installGithubReaderRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  port: GithubReaderApiPort,
): void => {
  if (port.publication) installGithubPublicationRoutes(api,port.publication)
  api.get('/work-item-links/:id/github', async (context) => {
    requireApiScope(context, 'time_entries:read')
    const result = await port.linkedItem(
      context.get('principal'),
      resourceId(context.req.param('id'), 'work item link'),
    )
    if (result === null)
      throw new ApiError({
        status: 404,
        code: 'not_found',
        message: 'Work item link not found.',
      })
    return context.json({ data: result }, 200, { 'cache-control': 'no-store' })
  })
  api.use('/work-items/github/*', async (context, next) => {
    const p = requireSessionPrincipal(context)
    if (
      p.profile !== 'administrator' ||
      !Number.isSafeInteger(Number(p.authentication.sessionId)) ||
      Number(p.authentication.sessionId) < 1
    )
      throw new ApiError({
        status: 403,
        code: 'profile_forbidden',
        message: 'A native administrator session is required.',
      })
    context.header('Cache-Control', 'no-store')
    await next()
  })
  const authority = (context: Context<ApiContext<Bindings>>): GithubReaderAdminAuthority => {
    const p = requireSessionPrincipal(context)
    return { userId: p.userId, sessionId: Number(p.authentication.sessionId) }
  }
  for (const resource of ['installations', 'repositories'] as const)
    api.get(`/work-items/github/${resource}`, async (context) => {
      const pageText = context.req.query('page') ?? '1',
        installationId = context.req.query('installation_id') ?? ''
      if (
        !/^[1-9]\d{0,2}$/.test(pageText) ||
        Number(pageText) > 100 ||
        (resource === 'repositories' && !providerId(installationId))
      )
        throw new ApiError({
          status: 422,
          code: 'invalid_request',
          message: 'Select an installation and valid page.',
          fields: [{ field: 'page', code: 'invalid', message: 'Select a valid page.' }],
        })
      try {
        return context.json({
          data:
            resource === 'installations'
              ? await port.installations(authority(context), Number(pageText))
              : await port.repositories(authority(context), installationId, Number(pageText)),
        })
      } catch (error) {
        return translate(error)
      }
    })
  api.post('/work-items/github/setup', async (context) => {
    const body = await readObjectBody(context)
    assertFields(unknownFieldErrors(body, new Set(['organization'])))
    if (
      body.organization !== undefined &&
      (typeof body.organization !== 'string' ||
        !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(body.organization))
    )
      throw new ApiError({
        status: 422,
        code: 'invalid_request',
        message: 'Use a GitHub organization name.',
        fields: [
          { field: 'organization', code: 'invalid', message: 'Use a GitHub organization name.' },
        ],
      })
    try {
      return context.json({
        data: await port.beginSetup(authority(context), body.organization as string | undefined),
      })
    } catch (error) {
      return translate(error)
    }
  })
  api.get('/work-items/github/setup/callback', async (context) => {
    try {
      await port.completeSetup(
        authority(context),
        context.req.query('state') ?? '',
        context.req.query('code') ?? '',
      )
      return context.redirect('/settings/company?github_setup=complete#work-items', 303)
    } catch (error) {
      if (error instanceof GithubReaderCommandError && error.kind !== 'forbidden')
        return context.redirect('/settings/company?github_setup=failed#work-items', 303)
      return translate(error)
    }
  })
  api.get('/work-items/github/status', async (context) => {
    try {
      return context.json({ data: await port.status(authority(context)) })
    } catch (error) {
      return translate(error)
    }
  })
  api.post('/work-items/github/repositories', async (context) => {
    const body = await readObjectBody(context)
    assertFields(
      unknownFieldErrors(
        body,
        new Set([
          'command_id',
          'expected_generation',
          'installation_id',
          'repository_id',
          'project_id',
          'task_id',
        ]),
      ),
    )
    if (
      !uuid(body.command_id) ||
      !number(body.expected_generation) ||
      !providerId(body.installation_id) ||
      !providerId(body.repository_id) ||
      !number(body.project_id) ||
      body.project_id < 1 ||
      !number(body.task_id) ||
      body.task_id < 1
    )
      throw new ApiError({
        status: 422,
        fields: [
          {
            field: 'command',
            code: 'invalid',
            message: 'Use a valid command and resource mapping.',
          },
        ],
        code: 'invalid_request',
        message:
          'A command UUID, current generation and GitHub installation/repository IDs are required.',
      })
    const command: GithubReaderMapCommand = {
      command_id: body.command_id,
      expected_generation: body.expected_generation,
      installation_id: body.installation_id,
      repository_id: body.repository_id,
      project_id: body.project_id,
      task_id: body.task_id,
    }
    try {
      return context.json({
        data: await port.map(authority(context), command),
      })
    } catch (error) {
      return translate(error)
    }
  })
  api.post('/work-items/github/disconnect', async (context) => {
    const body = await readObjectBody(context)
    assertFields(
      unknownFieldErrors(body, new Set(['command_id', 'expected_generation', 'connection_id'])),
    )
    if (
      !uuid(body.command_id) ||
      !number(body.expected_generation) ||
      typeof body.connection_id !== 'string' ||
      !/^\d+:\d+:\d+$/.test(body.connection_id) ||
      body.connection_id.length > 60
    )
      throw new ApiError({
        status: 422,
        fields: [
          {
            field: 'command',
            code: 'invalid',
            message: 'Use a valid command and resource mapping.',
          },
        ],
        code: 'invalid_request',
        message: 'A command UUID, current generation and connection ID are required.',
      })
    try {
      return context.json({
        data: await port.disconnect(authority(context), {
          command_id: body.command_id,
          expected_generation: body.expected_generation,
          connection_id: body.connection_id,
        }),
      })
    } catch (error) {
      return translate(error)
    }
  })
  api.post('/work-items/github/reconcile', async (context) => {
    const body = await readObjectBody(context)
    assertFields(unknownFieldErrors(body, new Set()))
    try {
      await port.reconcile(authority(context))
      return context.body(null, 204)
    } catch (error) {
      return translate(error)
    }
  })
}
export interface GithubReaderWebhookPort {
  receive(
    body: Uint8Array<ArrayBuffer>,
    headers: { signature: string | null; event: string; deliveryId: string },
  ): Promise<
    | 'invalid_signature'
    | 'body_too_large'
    | 'invalid_payload'
    | 'foreign_installation'
    | 'ignored'
    | 'applied'
    | 'duplicate'
  >
}
export const installGithubReaderWebhookRoute = <Bindings extends object>(
  app: Hono<ApiContext<Bindings>>,
  port: GithubReaderWebhookPort,
): void => {
  app.post('/webhooks/github-work-items', async (context) => {
    const stream = context.req.raw.body
    if (!stream) return context.json({ error: { code: 'invalid_payload' } }, 400)
    const reader = stream.getReader(),
      chunks: Uint8Array[] = []
    let size = 0
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 1_048_576) {
        await reader.cancel()
        return context.json({ error: { code: 'body_too_large' } }, 413)
      }
      chunks.push(chunk.value)
    }
    const body = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.length
    }
    const result = await port.receive(body, {
      signature: context.req.header('x-hub-signature-256') ?? null,
      event: context.req.header('x-github-event') ?? '',
      deliveryId: context.req.header('x-github-delivery') ?? '',
    })
    return context.json(
      { status: result },
      result === 'invalid_signature'
        ? 401
        : result === 'body_too_large'
          ? 413
          : result === 'invalid_payload'
            ? 400
            : 202,
    )
  })
}
