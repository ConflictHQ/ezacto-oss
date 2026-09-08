import {
  EzactoApiError,
  type EzactoClient,
  type GeneralResource,
  type GeneralResourcePage,
} from '@ezacto/client'
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod/v4'

export const DEFAULT_REPORT_FROM = '0100-01-01'
export const DEFAULT_REPORT_TO = '9999-12-31'
export const MAX_RESOURCE_LOOKUP_PAGES = 50
export const MAX_RESOURCE_LOOKUP_RECORDS = 10_000

export type EzactoReadClient = Pick<
  EzactoClient,
  | 'listTimeEntries'
  | 'listProjects'
  | 'listClients'
  | 'getUninvoicedReport'
  | 'getClientRollupReport'
  | 'getProjectBudgetReport'
  | 'listProjectBudgetSummaries'
>

class SafeToolError extends Error {}

const readonlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const

const positiveInteger = z.number().int().positive().safe()
const cursor = z.string().min(1).max(4096)
const pageSize = z.number().int().min(1).max(200)
const selector = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe('An exact name, code, or positive numeric ID.')

const canonicalDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`)
    return (
      Number.isFinite(parsed.valueOf()) &&
      parsed.toISOString().slice(0, 10) === value &&
      value >= DEFAULT_REPORT_FROM &&
      value <= DEFAULT_REPORT_TO
    )
  }, 'must be a real canonical YYYY-MM-DD date')

const reportRange = {
  from: canonicalDate
    .optional()
    .describe('First spent date, inclusive. Omit both date fields for all dates.'),
  to: canonicalDate
    .optional()
    .describe('Last spent date, inclusive. Omit both date fields for all dates.'),
}

const validateRange = (
  value: { from?: string | undefined; to?: string | undefined },
  context: z.RefinementCtx,
): void => {
  if (value.from !== undefined && value.to !== undefined && value.from > value.to) {
    context.addIssue({
      code: 'custom',
      path: ['to'],
      message: 'to must be on or after from',
    })
  }
}

const listTimeEntriesInput = z
  .object({
    cursor: cursor.optional(),
    per_page: pageSize.optional(),
    user_id: positiveInteger.optional(),
    client_id: positiveInteger.optional(),
    project_id: positiveInteger.optional(),
    task_id: positiveInteger.optional(),
    spent_date: canonicalDate.optional(),
    from: canonicalDate.optional(),
    to: canonicalDate.optional(),
    approval_status: z.enum(['unsubmitted', 'submitted', 'approved']).optional(),
    invoice_id: positiveInteger.optional(),
    is_billed: z.boolean().optional(),
    is_running: z.boolean().optional(),
    billable: z.boolean().optional(),
    budgeted: z.boolean().optional(),
    external_reference_id: z.string().min(1).max(10_000).optional(),
    updated_since: z.string().min(1).max(100).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.from !== undefined && value.to !== undefined && value.from > value.to) {
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: 'to must be on or after from',
      })
    }
  })

const listProjectsInput = z
  .object({
    cursor: cursor.optional(),
    per_page: pageSize.optional(),
    client_id: positiveInteger.optional(),
    is_active: z.boolean().optional(),
    updated_since: z.string().min(1).max(100).optional(),
  })
  .strict()

const uninvoicedInput = z
  .object({
    ...reportRange,
    client: selector.optional().describe('Exact client name or positive numeric ID.'),
    project: selector
      .optional()
      .describe('Exact project name, code, or positive numeric ID.'),
  })
  .strict()
  .superRefine(validateRange)

const clientRollupInput = z
  .object({
    ...reportRange,
    client: selector.describe('Exact client name or positive numeric ID.'),
  })
  .strict()
  .superRefine(validateRange)

const projectBudgetInput = z
  .object({
    ...reportRange,
    project: selector.describe('Exact project name, code, or positive numeric ID.'),
  })
  .strict()
  .superRefine(validateRange)

const projectBudgetListInput = z
  .object(reportRange)
  .strict()
  .superRefine(validateRange)

const jsonObject = (value: unknown): Record<string, unknown> => {
  const canonical = JSON.parse(JSON.stringify(value)) as unknown
  if (typeof canonical !== 'object' || canonical === null || Array.isArray(canonical)) {
    throw new Error('tool result must be a JSON object')
  }
  return canonical as Record<string, unknown>
}

const success = (value: unknown): CallToolResult => {
  const output = jsonObject(value)
  return {
    content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
    structuredContent: output,
  }
}

const apiFailure = (error: EzactoApiError): CallToolResult =>
  success({
    error: {
      kind: 'ezacto_api_error',
      status: error.status,
      body: error.body,
      request_id: error.requestId,
    },
  })

const failure = (error: unknown): CallToolResult => {
  const result =
    error instanceof EzactoApiError
      ? apiFailure(error)
      : success({
          error: {
            kind: error instanceof SafeToolError ? 'invalid_selection' : 'request_failed',
            message:
              error instanceof SafeToolError
                ? error.message
                : 'The ezacto request could not be completed.',
          },
        })
  return { ...result, isError: true }
}

const run = async (operation: () => Promise<unknown>): Promise<CallToolResult> => {
  try {
    return success(await operation())
  } catch (error) {
    return failure(error)
  }
}

type WithoutUndefined<T extends object> = {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>
} & {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K]
}

const withoutUndefined = <T extends object>(value: T): WithoutUndefined<T> =>
  Object.fromEntries(
    Object.entries(value).filter((entry) => entry[1] !== undefined),
  ) as WithoutUndefined<T>

const normalizedLabel = (value: string): string =>
  value
    .normalize('NFKD')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '')

const textField = (resource: GeneralResource, field: string): string | null => {
  const value = resource[field]
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

const resourceLabel = (resource: GeneralResource): string =>
  textField(resource, 'name') ?? textField(resource, 'code') ?? `#${resource.id}`

const collectResources = async (
  load: (cursor?: string) => Promise<GeneralResourcePage>,
): Promise<GeneralResource[]> => {
  const records: GeneralResource[] = []
  const seen = new Set<string>()
  let pages = 0
  let next: string | undefined
  do {
    if (pages >= MAX_RESOURCE_LOOKUP_PAGES) {
      throw new Error('ezacto resource lookup exceeded the page limit')
    }
    const page = await load(next)
    pages += 1
    if (page.data.length > MAX_RESOURCE_LOOKUP_RECORDS - records.length) {
      throw new Error('ezacto resource lookup exceeded the record limit')
    }
    records.push(...page.data)
    const cursorValue = page.page.next_cursor ?? undefined
    if (cursorValue !== undefined && seen.has(cursorValue)) {
      throw new Error('ezacto returned a repeated pagination cursor')
    }
    if (cursorValue !== undefined) seen.add(cursorValue)
    next = cursorValue
  } while (next !== undefined)
  return records
}

const numericSelector = (value: string): number | null => {
  if (!/^[1-9][0-9]*$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

const resolveResource = async (
  kind: 'client' | 'project',
  raw: string,
  load: () => Promise<GeneralResource[]>,
): Promise<number> => {
  const numeric = numericSelector(raw)
  if (numeric !== null) return numeric
  const wanted = normalizedLabel(raw)
  const records = await load()
  const matches = records.filter((resource) => {
    const fields =
      kind === 'project'
        ? [textField(resource, 'name'), textField(resource, 'code')]
        : [textField(resource, 'name')]
    return fields.some((field) => field !== null && normalizedLabel(field) === wanted)
  })
  if (matches.length === 0) throw new SafeToolError(`${kind} not found: ${raw}`)
  if (matches.length > 1) {
    const candidates = matches
      .map((resource) => `${resourceLabel(resource)} (#${resource.id})`)
      .sort()
      .join(', ')
    throw new SafeToolError(`${kind} is ambiguous: ${raw} (${candidates})`)
  }
  return matches[0]!.id
}

const clientId = (client: EzactoReadClient, raw: string): Promise<number> =>
  resolveResource('client', raw, () =>
    collectResources((pageCursor) =>
      client.listClients({
        query: {
          per_page: 200,
          ...(pageCursor === undefined ? {} : { cursor: pageCursor }),
        },
      }),
    ),
  )

const projectId = (
  client: EzactoReadClient,
  raw: string,
  resolvedClientId?: number,
): Promise<number> =>
  resolveResource('project', raw, () =>
    collectResources((pageCursor) =>
      client.listProjects({
        query: {
          per_page: 200,
          ...(resolvedClientId === undefined ? {} : { client_id: resolvedClientId }),
          ...(pageCursor === undefined ? {} : { cursor: pageCursor }),
        },
      }),
    ),
  )

const range = (input: {
  from?: string | undefined
  to?: string | undefined
}) => ({
  from: input.from ?? DEFAULT_REPORT_FROM,
  to: input.to ?? DEFAULT_REPORT_TO,
})

export const installEzactoReadTools = (
  server: McpServer,
  client: EzactoReadClient,
): void => {
  server.registerTool(
    'list_time_entries',
    {
      title: 'List ezacto time entries',
      description:
        'List a bounded page of time entries visible to the token user. The ezacto API applies assignment access and redacts rates for the user profile.',
      inputSchema: listTimeEntriesInput,
      annotations: readonlyAnnotations,
    },
    (input) => run(() => client.listTimeEntries({ query: withoutUndefined(input) })),
  )

  server.registerTool(
    'list_projects',
    {
      title: 'List ezacto projects',
      description:
        'List a bounded page of projects visible to the token user. The ezacto API redacts project notes and money fields for the user profile.',
      inputSchema: listProjectsInput,
      annotations: readonlyAnnotations,
    },
    (input) => run(() => client.listProjects({ query: withoutUndefined(input) })),
  )

  server.registerTool(
    'get_uninvoiced',
    {
      title: 'Get ezacto uninvoiced totals',
      description:
        'Get uninvoiced time and expense totals, optionally for an exact client or project name/code/ID. An omitted date range means all dates. Name lookup requires the corresponding read scope.',
      inputSchema: uninvoicedInput,
      annotations: readonlyAnnotations,
    },
    (input) =>
      run(async () => {
        const resolvedClientId =
          input.client === undefined ? undefined : await clientId(client, input.client)
        const resolvedProjectId =
          input.project === undefined
            ? undefined
            : await projectId(client, input.project, resolvedClientId)
        return client.getUninvoicedReport({
          query: {
            ...range(input),
            ...(resolvedClientId === undefined ? {} : { client_id: resolvedClientId }),
            ...(resolvedProjectId === undefined ? {} : { project_id: resolvedProjectId }),
          },
        })
      }),
  )

  server.registerTool(
    'get_client_rollup',
    {
      title: 'Get an ezacto client rollup report',
      description:
        'Get direct and descendant client metrics for an exact client name or ID. An omitted date range means all dates; the API redacts money fields for the token user profile.',
      inputSchema: clientRollupInput,
      annotations: readonlyAnnotations,
    },
    (input) =>
      run(async () =>
        client.getClientRollupReport({
          clientId: await clientId(client, input.client),
          query: range(input),
        }),
      ),
  )

  server.registerTool(
    'list_project_budgets',
    {
      title: 'List ezacto project budget progress',
      description:
        'List budget progress for every project the token user can see, one row per project. An omitted date range means all dates. Use this to find projects near or over budget without naming one.',
      inputSchema: projectBudgetListInput,
      annotations: readonlyAnnotations,
    },
    // The API already bounds this list to visible projects and drops each money
    // field the token profile may not see, so the payload is returned untouched.
    // Reassembling portfolio money here from other reads would be a way to read
    // a cost the per-project report withholds.
    (input) =>
      run(() => client.listProjectBudgetSummaries({ query: range(input) })),
  )

  server.registerTool(
    'get_project_budget',
    {
      title: 'Get an ezacto project budget report',
      description:
        'Get time or money budget progress for an exact project name, code, or ID. An omitted date range means all dates; the API redacts money fields for the token user profile.',
      inputSchema: projectBudgetInput,
      annotations: readonlyAnnotations,
    },
    (input) =>
      run(async () =>
        client.getProjectBudgetReport({
          projectId: await projectId(client, input.project),
          query: range(input),
        }),
      ),
  )
}
