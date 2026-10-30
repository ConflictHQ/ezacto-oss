import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import {
  installModuleGate,
  moduleAvailability,
  moduleForPath,
  OPERATOR_MODULE_FLAGS,
  OPERATOR_MODULES,
} from '../src/index.js'
import { errorResponse } from '../src/errors.js'

describe('moduleAvailability', () => {
  it('is on for every module by default, so an install that sets nothing is unchanged', () => {
    expect(moduleAvailability({})).toEqual({ sso: true, backups: true, invoices: true, accounting: true })
    for (const name of Object.values(OPERATOR_MODULE_FLAGS)) {
      expect(Object.values(moduleAvailability({ [name]: 'true' })).every(Boolean)).toBe(true)
    }
  })

  it('keeps the two older flag names', () => {
    expect(OPERATOR_MODULE_FLAGS.accounting).toBe('ACCOUNTING_ENABLED')
    expect(OPERATOR_MODULE_FLAGS.backups).toBe('BACKUPS_ENABLED')
  })

  it('turns off exactly the module whose flag is false', () => {
    for (const module of OPERATOR_MODULES) {
      const state = moduleAvailability({ [OPERATOR_MODULE_FLAGS[module]]: 'false' })
      expect(OPERATOR_MODULES.filter((other) => !state[other])).toEqual([module])
    }
  })

  it('refuses anything but true or false, blank and padded included, naming the flag', () => {
    for (const module of OPERATOR_MODULES) {
      const name = OPERATOR_MODULE_FLAGS[module]
      for (const bad of ['', ' ', ' true', 'false ', 'TRUE', 'False', '0', '1', 'no', 'off', 'disabled']) {
        expect(() => moduleAvailability({ [name]: bad })).toThrow(name)
      }
    }
  })
})

describe('moduleForPath', () => {
  it('assigns each module its own surface', () => {
    expect(moduleForPath('/auth/oidc/google')).toBe('sso')
    expect(moduleForPath('/auth/github/callback')).toBe('sso')
    expect(moduleForPath('/auth/apple')).toBe('sso')
    expect(moduleForPath('/api/v1/settings/sso-domains/3/verify')).toBe('sso')
    expect(moduleForPath('/api/v1/backup/status')).toBe('backups')
    expect(moduleForPath('/backup-download/abc')).toBe('backups')
    expect(moduleForPath('/api/v1/integrations/quickbooks/callback')).toBe('accounting')
    expect(moduleForPath('/api/v1/invoices/4/quickbooks/sync')).toBe('accounting')
    expect(moduleForPath('/webhooks/quickbooks')).toBe('accounting')
    expect(moduleForPath('/api/v1/invoices')).toBe('invoices')
    expect(moduleForPath('/harvest/v2/invoices')).toBe('invoices')
    expect(moduleForPath('/harvest/v2/invoices/1')).toBe('invoices')
    expect(moduleForPath('/api/v1/invoices/4/deliveries/preview/send')).toBe('invoices')
    expect(moduleForPath('/api/v1/recurring-invoices/2')).toBe('invoices')
    expect(moduleForPath('/api/v1/settings/invoice-defaults')).toBe('invoices')
    expect(moduleForPath('/portal/invoices/abc')).toBe('invoices')
  })

  it('leaves everything else, including magic-link app codes and password sign-in, alone', () => {
    for (const path of [
      '/auth/oidc/exchange',
      '/auth/sign-in',
      '/api/v1/clients',
      '/api/v1/invoices-archive',
      '/harvest/v2/invoices-archive',
      '/api/v1/estimates',
      '/api/v1/admin/sign-in-methods',
      '/api/v1/admin/modules/expenses',
      '/webhooks/stripe',
    ]) {
      expect(moduleForPath(path)).toBeUndefined()
    }
  })
})

describe('installModuleGate', () => {
  const build = (env: Parameters<typeof moduleAvailability>[0]) => {
    const app = new Hono<{ Variables: { requestId: string } }>()
    app.onError((error, context) => {
      context.set('requestId', 'test')
      return errorResponse(error, context as never)
    })
    installModuleGate(app as never, () => moduleAvailability(env))
    let reached = 0
    app.all('*', (context) => {
      reached += 1
      return context.json({ ok: true })
    })
    return { app, reached: () => reached }
  }

  it('answers 403 module_disabled and never reaches the route for a disabled module', async () => {
    const { app, reached } = build({ INVOICES_ENABLED: 'false' })
    const refused = await app.request('/api/v1/invoices/1')
    expect(refused.status).toBe(403)
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('module_disabled')
    expect(reached()).toBe(0)
    expect((await app.request('/api/v1/clients')).status).toBe(200)
    expect(reached()).toBe(1)
  })

  it('lets everything through while the module is on', async () => {
    const { app, reached } = build({})
    expect((await app.request('/api/v1/invoices/1')).status).toBe(200)
    expect(reached()).toBe(1)
  })
})
