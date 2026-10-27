import type { Context, Hono } from 'hono'
import {
  GithubReadError,
  GithubHttpError,
  CooldownError,
  GithubPublicationError,
  type GithubPublicationPort,
} from '@ezacto/integrations'
import type { ApiContext } from './context.js'
import { requireSessionPrincipal } from './auth.js'
import { ApiError } from './errors.js'
import {
  assertFields,
  readObjectBody,
  unknownFieldErrors,
  resourceId,
} from './resources/support.js'

const number = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const uuid = (value: unknown) =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const invalid = () =>
  new ApiError({
    status: 422,
    code: 'invalid_request',
    message: 'Review the publication selection.',
    fields: [
      { field: 'publication', code: 'invalid', message: 'Review the publication selection.' },
    ],
  })
const translate = (error: unknown): never => {
  if (
    error instanceof GithubReadError ||
    error instanceof GithubHttpError ||
    error instanceof CooldownError
  ) {
    const failure = new ApiError({
      status: 503,
      code: 'github_publication_unavailable',
      message: 'GitHub publication is unavailable.',
    })
    failure.cause = error
    throw failure
  }
  if (error instanceof GithubPublicationError) {
    if (error.code === 'invalid') throw invalid()
    throw new ApiError({
      status: error.code === 'forbidden' ? 403 : error.code === 'conflict' ? 409 : 503,
      code: `github_publication_${error.code}`,
      message:
        error.code === 'forbidden'
          ? 'A current native administrator session is required.'
          : error.code === 'unavailable'
            ? 'GitHub publication is unavailable.'
            : 'Publication changed. Refresh and review it again.',
    })
  }
  throw error
}
export function installGithubPublicationRoutes<B extends object>(
  api: Hono<ApiContext<B>>,
  port: GithubPublicationPort,
) {
  const authority = (context: Context<ApiContext<B>>) => {
    const p = requireSessionPrincipal(context)
    if (p.profile !== 'administrator' || !Number.isSafeInteger(Number(p.authentication.sessionId)))
      throw new ApiError({
        status: 403,
        code: 'profile_forbidden',
        message: 'A native administrator session is required.',
      })
    return { userId: p.userId, sessionId: Number(p.authentication.sessionId) }
  }
  api.get('/work-items/github/publication', async (c) => {
    try {
      return c.json({ data: await port.list(authority(c)) }, 200, { 'Cache-Control': 'no-store' })
    } catch (e) {
      return translate(e)
    }
  })
  api.get('/work-items/github/publication/preview/:id', async (c) => {
    try {
      return c.json(
        { data: await port.preview(authority(c), resourceId(c.req.param('id'), 'work item link')) },
        200,
        { 'Cache-Control': 'no-store' },
      )
    } catch (e) {
      return translate(e)
    }
  })
  api.post('/work-items/github/publication/policy', async (c) => {
    const auth = authority(c),
      body = await readObjectBody(c)
    assertFields(
      unknownFieldErrors(
        body,
        new Set([
          'connection_id',
          'expected_generation',
          'enabled',
          'confirm_permission',
          'command_id',
        ]),
      ),
    )
    if (
      typeof body.connection_id !== 'string' ||
      !/^\d+:\d+:\d+$/.test(body.connection_id) ||
      !number(body.expected_generation) ||
      typeof body.enabled !== 'boolean' ||
      typeof body.confirm_permission !== 'boolean' ||
      !uuid(body.command_id)
    )
      throw invalid()
    try {
      await port.policy(auth, body as unknown as Parameters<typeof port.policy>[1])
      return c.body(null, 204)
    } catch (e) {
      return translate(e)
    }
  })
  api.post('/work-items/github/publication/consent', async (c) => {
    const auth = authority(c),
      body = await readObjectBody(c)
    assertFields(unknownFieldErrors(body, new Set(['link_id', 'source_version', 'command_id'])))
    if (
      !number(body.link_id) ||
      Number(body.link_id) < 1 ||
      typeof body.source_version !== 'string' ||
      !/^[a-f0-9]{64}$/.test(body.source_version) ||
      !uuid(body.command_id)
    )
      throw invalid()
    try {
      await port.consent(auth, body as unknown as Parameters<typeof port.consent>[1])
      return c.body(null, 204)
    } catch (e) {
      return translate(e)
    }
  })
  api.post('/work-items/github/publication/:id/actions', async (c) => {
    const auth = authority(c),
      id = resourceId(c.req.param('id'), 'publication'),
      body = await readObjectBody(c)
    assertFields(
      unknownFieldErrors(body, new Set(['expected_version', 'action', 'confirm', 'command_id'])),
    )
    if (
      !number(body.expected_version) ||
      Number(body.expected_version) < 1 ||
      !['retry', 'adopt', 'restore', 'unlink'].includes(String(body.action)) ||
      body.confirm !== true ||
      !uuid(body.command_id)
    )
      throw invalid()
    try {
      await port.act(auth, { ...body, id } as unknown as Parameters<typeof port.act>[1])
      return c.body(null, 204)
    } catch (e) {
      return translate(e)
    }
  })
}
