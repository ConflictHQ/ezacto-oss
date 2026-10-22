import { EstimateContentError, type EstimateTemplate, type UserProfile } from '@ezacto/core'
import type { Hono } from 'hono'
import { requireApiScope } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError } from './errors.js'
import { assertFields, readObjectBody, unknownFieldErrors } from './resources/support.js'
export interface EstimateTemplateRepository {
  list(): Promise<EstimateTemplate[]>
  get(id: string): Promise<EstimateTemplate>
  save(
    actor: { userId: number; profile: UserProfile },
    input: {
      id?: string
      expected_version?: number
      name: unknown
      content: unknown
      archived?: boolean
    },
    now: string,
  ): Promise<EstimateTemplate>
  createDraft(
    actor: { userId: number; profile: UserProfile },
    input: {
      client_id: number
      number: string
      issue_date: string
      content: unknown
      template_id: string | null
      template_version: number | null
    },
    key: string,
    now: string,
  ): Promise<{ id: number }>
}
const handle = async <T>(action: () => Promise<T>): Promise<T> => {
  try {
    return await action()
  } catch (error) {
    if (error instanceof EstimateContentError) {
      const status =
        error.code === 'invalid_estimate_content'
          ? 422
          : error.code === 'estimate_template_not_found'
            ? 404
            : 409
      throw new ApiError({
        status,
        code: error.code,
        message: error.message,
        ...(status === 422
          ? { fields: [{ field: 'content', code: error.code, message: error.message }] }
          : {}),
      })
    }
    throw error
  }
}
export const installEstimateTemplateRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  repository: EstimateTemplateRepository,
  clock: () => string,
): void => {
  // Template content is money. The same ceiling applies to listing and writing.
  api.get('/estimate-templates', async (context) => {
    requireApiScope(context, 'invoices:write')
    const rows = await repository.list()
    return context.json({ data: rows.slice(0, 1000), truncated: rows.length > 1000 })
  })
  api.post('/estimate-templates', async (context) => {
    requireApiScope(context, 'invoices:write')
    const actor = context.get('principal'),
      body = await readObjectBody(context)
    assertFields(unknownFieldErrors(body, new Set(['name', 'content'])))
    const data = await handle(() =>
      repository.save(actor, { name: body.name, content: body.content }, clock()),
    )
    return context.json({ data }, 201)
  })
  api.patch('/estimate-templates/:id', async (context) => {
    requireApiScope(context, 'invoices:write')
    const actor = context.get('principal'),
      body = await readObjectBody(context)
    const errors = unknownFieldErrors(
      body,
      new Set(['name', 'content', 'expected_version', 'archived']),
    )
    if (!Number.isSafeInteger(body.expected_version) || (body.expected_version as number) < 0)
      errors.push({
        field: 'expected_version',
        code: 'invalid',
        message: 'Reload the current template version.',
      })
    if (body.archived !== undefined && typeof body.archived !== 'boolean')
      errors.push({ field: 'archived', code: 'invalid', message: 'archived must be a boolean.' })
    assertFields(errors)
    const data = await handle(() =>
      repository.save(
        actor,
        {
          id: context.req.param('id'),
          name: body.name,
          content: body.content,
          expected_version: body.expected_version as number,
          ...(body.archived === undefined ? {} : { archived: body.archived as boolean }),
        },
        clock(),
      ),
    )
    return context.json({ data })
  })
  api.post('/estimates', async (context) => {
    requireApiScope(context, 'invoices:write')
    const actor = context.get('principal'),
      body = await readObjectBody(context)
    assertFields(
      unknownFieldErrors(
        body,
        new Set([
          'client_id',
          'number',
          'issue_date',
          'content',
          'template_id',
          'template_version',
        ]),
      ),
    )
    const data = await handle(() =>
      repository.createDraft(
        actor,
        {
          client_id: body.client_id as number,
          number: body.number as string,
          issue_date: body.issue_date as string,
          content: body.content,
          template_id: (body.template_id ?? null) as string | null,
          template_version: (body.template_version ?? null) as number | null,
        },
        context.req.header('Idempotency-Key') ?? '',
        clock(),
      ),
    )
    return context.json({ data }, 201)
  })
}
