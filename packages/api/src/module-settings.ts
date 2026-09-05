import type { Context, Hono } from 'hono'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError } from './errors.js'
import { assertFields, readObjectBody, unknownFieldErrors } from './resources/support.js'

export type ModuleName = 'approval' | 'expenses'

export interface ModuleState {
  module: ModuleName
  enabled: boolean
}

export interface ModuleSettingsService {
  list(): Promise<readonly ModuleState[]>
  setEnabled(
    module: ModuleName,
    enabled: boolean,
    updatedAt: string,
  ): Promise<readonly ModuleState[]>
}

export interface ModuleSettingsRouteOptions {
  service: ModuleSettingsService
  clock(): string
}

const knownModules = new Set<string>(['approval', 'expenses'])

const assertAdministrator = <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
): void => {
  const principal = requireSessionPrincipal(context)
  if (principal.profile !== 'administrator') {
    throw new ApiError({
      status: 403,
      code: 'profile_forbidden',
      message: 'Only administrators can manage module settings.',
    })
  }
}

const patchKeys = new Set(['enabled'])

const listEnvelope = (modules: readonly ModuleState[]) => ({
  data: modules.map((m) => ({ module: m.module, enabled: m.enabled })),
  links: { self: '/api/v1/admin/modules' },
})

export const installModuleSettingsRoutes = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: ModuleSettingsRouteOptions,
): void => {
  api.get('/admin/modules', async (context) => {
    assertAdministrator(context)
    return context.json(listEnvelope(await options.service.list()), 200, {
      'cache-control': 'no-store',
    })
  })

  api.patch('/admin/modules/:module', async (context) => {
    assertAdministrator(context)
    const moduleName = context.req.param('module')
    if (!knownModules.has(moduleName)) {
      throw new ApiError({
        status: 404,
        code: 'not_found',
        message: 'The requested module does not exist.',
      })
    }
    const body = await readObjectBody(context)
    const errors = unknownFieldErrors(body, patchKeys)
    if (typeof body.enabled !== 'boolean') {
      errors.push({
        field: 'enabled',
        code: body.enabled === undefined ? 'required' : 'invalid_boolean',
        message: 'enabled must be a boolean',
      })
    }
    assertFields(errors)
    const modules = await options.service.setEnabled(
      moduleName as ModuleName,
      body.enabled as boolean,
      options.clock(),
    )
    return context.json(listEnvelope(modules), 200, {
      'cache-control': 'no-store',
    })
  })
}
