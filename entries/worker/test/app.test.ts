import { describe, expect, it } from 'vitest'
import { moduleAvailability } from '@ezacto/api'
import { invoiceNumberIsAddressable, paletteDestinations } from '@ezacto/web'
import { providerCredentials } from '../src/runtime.js'
import {
  createApp,
  type AppEnv,
  type Env,
  type Health,
  type WorkerEnv,
} from '../src/app.js'

const env: Env = { ENVIRONMENT: 'test', RELEASE: 'abc1234def5678' }

const app = createApp()

describe('worker entry', () => {
  it('[#1167] bootstraps attachment availability from the runtime before session restoration', async () => {
    const withoutStorage = await (await app.request('/projects/1', {}, env)).text()
    expect(withoutStorage).toContain('data-attachments-unavailable')
    const withStorage = await (await app.request('/projects/1', {}, { ...env, ATTACHMENTS: {} })).text()
    expect(withStorage).not.toContain('data-attachments-unavailable')
  })

  it('[#1217] bootstraps accounting availability from the runtime before session restoration', async () => {
    const keys = { QUICKBOOKS_CLIENT_ID: 'id', QUICKBOOKS_CLIENT_SECRET: 'secret' }
    const html = async (extra: Partial<WorkerEnv>) =>
      (await (await app.request('/invoices', {}, { ...env, ...extra })).text())
    expect(await html({})).toContain('data-accounting-unavailable')
    expect(await html(keys)).not.toContain('data-accounting-unavailable')
    expect(await html({ ...keys, ACCOUNTING_ENABLED: 'false' })).toContain('data-accounting-unavailable')
    expect(await html({ ...keys, ACCOUNTING_ENABLED: 'true' })).not.toContain('data-accounting-unavailable')
    // An invalid flag refuses the page rather than reading as on or off.
    expect((await app.request('/invoices', {}, { ...env, ...keys, ACCOUNTING_ENABLED: 'nope' })).status).toBe(500)
  })

  it('[#1217] renders each native provider independently without provider requests', async () => {
    const configured = { BILL_DEV_KEY: 'dev', BILL_COMPANY_ID: 'company', BILL_USERNAME: 'user', BILL_PASSWORD: 'pass', WISE_TOKEN: 'wise', DEEL_TOKEN: 'deel', DEEL_SYNC_START_DATE: '2026-01-01' }
    const page = await (await app.request('/settings/company', {}, { ...env, ...configured })).text()
    expect(page).not.toContain('data-accounting-unavailable')
    expect(page).toContain('data-quickbooks-unavailable')
    for (const id of ['bill', 'wise', 'deel']) expect(page).toContain(`data-accounting-provider="${id}" data-provider-available="true"`)
    expect(page).toContain('data-accounting-provider="quickbooks" data-provider-available="false"')
    expect(page).toContain('data-accounting-quickbooks hidden')
    const off = await (await app.request('/settings/company', {}, { ...env, ...configured, ACCOUNTING_ENABLED: 'false' })).text()
    expect(off).toContain('data-accounting-unavailable')
    for (const id of ['quickbooks', 'bill', 'wise', 'deel']) expect(off).toContain(`data-accounting-provider="${id}" data-provider-available="false"`)
    const incomplete = await (await app.request('/settings/company', {}, { ...env, BILL_DEV_KEY: 'dev', DEEL_TOKEN: 'deel', DEEL_SYNC_START_DATE: 'not-a-date' })).text()
    expect(incomplete).toContain('data-accounting-unavailable')
  })

  it('[#1217] accepts only true or false for ACCOUNTING_ENABLED', () => {
    expect(moduleAvailability({}).accounting).toBe(true)
    expect(moduleAvailability({ ACCOUNTING_ENABLED: 'true' }).accounting).toBe(true)
    expect(moduleAvailability({ ACCOUNTING_ENABLED: 'false' }).accounting).toBe(false)
    for (const bad of ['', 'FALSE', '0', 'no']) {
      expect(() => moduleAvailability({ ACCOUNTING_ENABLED: bad })).toThrow(/ACCOUNTING_ENABLED/)
    }
  })

  it('[#1217] withholds the QuickBooks keys from the runtime when accounting is off', () => {
    const keys = {
      QUICKBOOKS_CLIENT_ID: 'id',
      QUICKBOOKS_CLIENT_SECRET: 'secret',
      QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN: 'token',
    }
    expect(providerCredentials({ ...env, ...keys } as WorkerEnv)).toMatchObject(keys)
    const off = providerCredentials({ ...env, ...keys, ACCOUNTING_ENABLED: 'false' } as WorkerEnv)
    expect(off.QUICKBOOKS_CLIENT_ID).toBeUndefined()
    expect(off.QUICKBOOKS_CLIENT_SECRET).toBeUndefined()
    expect(off.QUICKBOOKS_WEBHOOK_VERIFIER_TOKEN).toBeUndefined()
    expect(() => providerCredentials({ ...env, ...keys, ACCOUNTING_ENABLED: 'maybe' } as WorkerEnv)).toThrow(
      /ACCOUNTING_ENABLED/,
    )
  })

  it('[#1216] marks backups unavailable only when BACKUPS_ENABLED is explicitly false', async () => {
    const fetchPage = async (extra: Partial<AppEnv>) => (await app.request('/settings/company', {}, { ...env, ...extra })).text()
    expect(await fetchPage({})).not.toContain('data-backups-unavailable')
    expect(await fetchPage({ BACKUPS_ENABLED: 'true' })).not.toContain('data-backups-unavailable')
    expect(await fetchPage({ BACKUPS_ENABLED: 'false' })).toContain('data-backups-unavailable')
  })

  it('reports health with the environment and release it was deployed with', async () => {
    const res = await app.request('/healthz', {}, env)

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')

    const body = (await res.json()) as Health
    expect(body).toEqual({
      status: 'ok',
      service: 'ezacto',
      environment: 'test',
      release: 'abc1234def5678',
    })
  })

  it('[unit] serves the Saved tab of Reports as the Reports page with its own tab current (#933)', async () => {
    const saved = await (await app.request('/reports/saved', {}, env)).text()
    expect(saved).toContain('data-saved-screen')
    expect(saved).toMatch(/<a href="\/reports\/saved"[^>]*aria-current="page"[^>]*>Saved<\/a>/u)
    const time = await (await app.request('/reports?report=time', {}, env)).text()
    expect(time).toMatch(/<a href="\/reports\/saved"(?![^>]*aria-current)[^>]*>Saved<\/a>/u)
  })

  it('[unit] brands every HTML route from the deployment, with no route left behind', async () => {
    // Three routes — /team, /team/:id and /settings/modules — shipped without
    // brandFromEnv, so a branded deployment served them as "ezacto". The
    // renderer was always tested; the routes were not, which is how they
    // drifted. Walk them all instead of naming the ones that were wrong.
    const branded: AppEnv = { ...env, BRAND_NAME: 'CONFLICT' }
    const paths = [
      '/',
      '/dashboard',
      '/approvals',
      '/expenses',
      '/expense-categories',
      '/team',
      '/team/1',
      '/projects',
      '/tasks',
      '/clients',
      '/clients/1',
      '/invoices',
      '/invoices/1',
      '/invoices/1/edit',
      '/invoices/by-id/1',
      '/invoices/by-id/1/edit',
      '/invoices/new',
      '/invoices/recurring',
      '/invoices/recurring/new',
      '/invoices/recurring/1/edit',
      '/invoices/retainers',
      '/reports',
      '/reports/saved',
      '/settings/user',
      '/settings/company',
      '/settings/templates',
      '/settings/deliveries',
    ]
    for (const path of paths) {
      const res = await app.request(path, {}, branded)
      expect(res.status, path).toBe(200)
      expect(await res.text(), path).toContain('data-brand="CONFLICT"')
    }
  })

  it('[acceptance] serves the home screen above the timesheet rather than instead of it', async () => {
    // Signing in still lands on the timesheet; /dashboard is the screen that
    // answers where things stand, and Time keeps '/'.
    const home = await (await app.request('/dashboard', {}, env)).text()
    expect(home).toContain('data-app-view="dashboard"')
    expect(home).toContain('data-dashboard-page')
    // Home lives in the Menu, as a card: its mark, its title (the name) and a
    // hint that describes it.
    expect(home).toMatch(
      /<a class="menu-card" aria-describedby="menu-hint-home" href="\/dashboard" aria-current="page"><svg[^>]*>(?:(?!<\/a>)[^])*<span class="menu-card-title">Home<\/span>(?:(?!<\/a>)[^])*<\/a>/u,
    )

    const time = await (await app.request('/', {}, env)).text()
    expect(time).toContain('data-app-view="time"')
    expect(time).toMatch(
      /<a href="\/" aria-current="page"><svg[^>]*>(?:(?!<\/a>)[^])*<span class="nav-label">Time<\/span><\/a>/u,
    )
  })

  it('[unit] keeps the URL settings shipped under', async () => {
    // Someone has /settings/modules bookmarked. Redirect rather than delete: a
    // 404 to tidy a route table is a poor trade.
    const moved = await app.request('/settings/modules', {}, env)
    expect(moved.status).toBe(301)
    expect(moved.headers.get('location')).toBe('/settings/company')
    // Where Intuit's consent screen sends an operator back to (issue 800). It
    // was a 404 for as long as the QuickBooks runtime has named it.
    const integrations = await app.request('/settings/integrations', {}, env)
    expect(integrations.status).toBe(301)
    expect(integrations.headers.get('location')).toBe('/settings/company#integrations')
  })

  it('[browser] serves Settings › Deliveries, the page its tab and the palette link to', async () => {
    // The page shipped with issue 485 and both links pointed here, but no
    // route served it, so the tab answered "That page does not exist".
    const page = await app.request('/settings/deliveries', {}, env)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('data-app-view="settings-deliveries"')
    // The deliveries screen is the one showing, and the strip marks its tab.
    expect(html).toContain('data-deliveries-page>')
    expect(html).not.toContain('data-deliveries-page hidden')
    expect(html).toContain('data-not-found-page hidden')
    expect(html).toContain(
      '<a href="/settings/deliveries" data-settings-deliveries-tab hidden aria-current="page">Deliveries</a>',
    )
  })

  it('[unit] serves every page the shell links to, so no link lands on Not found', async () => {
    // Deliveries was a link and a page with no route between them. Walk what
    // the shell actually links to -- the nav, the Settings strip, the palette --
    // rather than a list somebody has to remember to extend.
    const html = await (await app.request('/', {}, env)).text()
    const linked = [...html.matchAll(/href="(\/[^"#?]*)/gu)].map((match) => match[1]!)
    const paths = [
      ...new Set([...linked, ...paletteDestinations.map((destination) => destination.href)]),
    ]
    expect(paths).toContain('/settings/deliveries')
    for (const path of paths) {
      expect((await app.request(path, {}, env)).status, path).toBe(200)
    }
  })

  it('[unit] renders the scheme from the cookie on every shell route, before any script runs', async () => {
    // A scheme a script applies arrives after the first paint, and a dark page
    // flashes white on every load. So the page is rendered in it. Every route
    // goes through one place for this, and the walk is what proves no route was
    // left out of that place.
    const root = (html: string): string => /<html[^>]*>/u.exec(html)?.[0] ?? ''
    const paths = [
      '/',
      '/dashboard',
      '/approvals',
      '/invoices',
      '/invoices/1',
      '/invoices/new',
      '/reports',
      '/settings/user',
      '/settings/company',
      '/team/1',
      '/no-such-page',
    ]
    for (const path of paths) {
      const response = await app.request(
        path,
        { headers: { cookie: 'unrelated=1; ezacto_scheme=dark' } },
        env,
      )
      const html = await response.text()
      expect(root(html), path).toContain(' data-ez-scheme="dark"')
      expect(html, path).toContain('<meta name="color-scheme" content="dark">')
      // It varies by cookie, so it must never be a page anyone else is served.
      expect(response.headers.get('cache-control'), path).toBe('no-store')
    }
    const unset = await (await app.request('/', {}, env)).text()
    expect(root(unset)).toContain(' data-ez-scheme="system"')
    // Dim is on the list too, and a dark scheme to the browser's controls.
    const dim = await (
      await app.request('/', { headers: { cookie: 'ezacto_scheme=dim' } }, env)
    ).text()
    expect(root(dim)).toContain(' data-ez-scheme="dim"')
    expect(dim).toContain('<meta name="color-scheme" content="dark">')
    // A value off the list is a preference nobody can have; it never reaches
    // the markup as itself.
    const hostile = await (
      await app.request('/', { headers: { cookie: 'ezacto_scheme="><script>x</script>' } }, env)
    ).text()
    expect(root(hostile)).toContain(' data-ez-scheme="system"')
    expect(hostile).not.toContain('<script>x</script>')
  })

  it('[unit] lays the header out in the layout the cookies chose, on every shell route', async () => {
    // The same header is a sidebar or a top bar by an attribute on the root,
    // rendered from the person's cookies so the page never jumps from one to
    // the other after it paints.
    const root = (html: string): string => /<html[^>]*>/u.exec(html)?.[0] ?? ''
    for (const path of ['/', '/invoices', '/settings/user', '/no-such-page']) {
      const chosen = await (
        await app.request(
          path,
          { headers: { cookie: 'ezacto_nav=topbar; ezacto_sidebar=collapsed' } },
          env,
        )
      ).text()
      expect(root(chosen), path).toContain(' data-ez-nav="topbar" data-ez-sidebar="collapsed"')
      const unset = await (await app.request(path, {}, env)).text()
      expect(root(unset), path).toContain(' data-ez-nav="sidebar" data-ez-sidebar="expanded"')
    }
  })

  it('[unit] marks no primary section on a page outside the primary nav', async () => {
    // activeSection defaults to Time, so settings marked Time as the page you
    // were on.
    const html = await (await app.request('/settings/company', {}, env)).text()
    expect(html).toContain('data-app-view="settings-company"')
    // The Week/Day strip marks itself; what must not be marked is a primary
    // section, and Time is the one the default would have claimed.
    expect(html).not.toMatch(/<a href="\/" aria-current="page"><svg/u)
    const nav = /<nav class="primary-nav"[^>]*>(.*?)<\/nav>/su.exec(html)?.[1] ?? ''
    expect(nav).not.toContain('aria-current')
  })

  it('serves the responsive application shell with the deployment stamp', async () => {
    const res = await app.request('/', {}, env)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')

    const html = await res.text()
    expect(html).toContain('<title>eZacto — Sign in</title>')
    expect(html).toContain('abc1234')
    expect(html).toContain('data-auth-gateway data-state="checking"')
    expect(html).toContain('data-authenticated-shell hidden inert')
    expect(html).toContain('data-timer-chip')
    expect(html).toContain('data-command-dialog')
    expect(html).toContain('data-sign-in-form')
    expect(html).not.toContain('data-oidc-provider')
    expect(html).not.toContain('data-oidc-entry')
    expect(html).toContain('data-current-identity')
    expect(html).toContain('data-logout')
    expect(html).toContain('/assets/ezacto.css')
    expect(html).toContain('/assets/ezacto.js')
    expect(html).toContain('name="robots" content="noindex"')
    expect(res.headers.get('content-security-policy')).toContain(
      "script-src 'self'",
    )
    expect(res.headers.get('content-security-policy')).toContain(
      "form-action 'self'",
    )
  })

  it('[acceptance] serves invoice browse and numeric detail shells without redirects', async () => {
    const list = await app.request('/invoices', {}, env)
    const detail = await app.request('/invoices/42', {}, env)

    expect(list.status).toBe(200)
    expect(list.headers.get('location')).toBeNull()
    const listHtml = await list.text()
    expect(listHtml).toContain('data-app-view="invoice-list"')
    expect(listHtml).toContain('data-invoice-list-page')
    expect(listHtml).toContain('href="/invoices" aria-current="page"')

    expect(detail.status).toBe(200)
    const detailHtml = await detail.text()
    expect(detailHtml).toContain('data-app-view="invoice-detail"')
    expect(detailHtml).toContain('data-invoice-detail-page')
    expect(detailHtml).toContain('data-invoice-document data-document-shell')
    expect(detailHtml).toContain('data-ez-theme="precision"')
  })

  it.each([
    // An id is a positive safe integer, written plainly.
    '/invoices/by-id/0',
    '/invoices/by-id/042',
    '/invoices/by-id/nope',
    '/invoices/by-id/9007199254740992',
    '/invoices/by-id',
    '/invoices/by-id/42/more',
    // A number is a path segment no browser rewrites, of at most 64 characters.
    '/invoices/-1',
    '/invoices/.hidden',
    '/invoices/INV%207',
    '/invoices/INV%2F7',
    '/invoices/%C3%847',
    `/invoices/${'9'.repeat(65)}`,
  ])('[security] rejects invalid invoice detail path %s', async (path) => {
    expect((await app.request(path, {}, env)).status).toBe(404)
  })

  it.each([
    ['/invoices/4021', 'invoice-detail'],
    ['/invoices/089', 'invoice-detail'],
    ['/invoices/0', 'invoice-detail'],
    ['/invoices/INV-2026.07_b', 'invoice-detail'],
    [`/invoices/${'9'.repeat(64)}`, 'invoice-detail'],
    ['/invoices/4021/edit', 'invoice-edit'],
    ['/invoices/089/edit', 'invoice-edit'],
    ['/invoices/by-id/42', 'invoice-detail'],
    ['/invoices/by-id/9007199254740991', 'invoice-detail'],
    ['/invoices/by-id/42/edit', 'invoice-edit'],
  ])('[acceptance] serves %s as the %s page', async (path, view) => {
    // Addressed by the invoice number, as text -- "089" is its own address --
    // or by the record id under by-id for a number that cannot be a path.
    const res = await app.request(path, {}, env)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain(`data-app-view="${view}"`)
  })

  it('[acceptance] keeps every page beside the invoices its own, never an invoice number', async () => {
    // Registered ahead of /invoices/:invoiceNumber, and refused by it besides:
    // a tab, the New invoice dialog and the old settings path stay what they
    // are whatever an invoice happens to be numbered.
    for (const [path, view] of [
      ['/invoices/new', 'invoice-generation'],
      ['/invoices/recurring', 'invoice-recurring'],
      ['/invoices/retainers', 'invoice-retainers'],
      ['/invoices/estimates', 'invoice-estimates'],
    ] as const) {
      const res = await app.request(path, {}, env)
      expect(res.status, path).toBe(200)
      expect(await res.text(), path).toContain(`data-app-view="${view}"`)
    }
    const configure = await app.request('/invoices/configure', {}, env)
    expect(configure.status).toBe(301)
    expect(configure.headers.get('location')).toBe('/settings/templates')
    for (const path of [
      '/invoices/new/edit',
      '/invoices/recurring/edit',
      '/invoices/retainers/edit',
      '/invoices/estimates/edit',
      '/invoices/configure/edit',
      '/invoices/by-id/edit',
    ]) {
      expect((await app.request(path, {}, env)).status, path).toBe(404)
    }
  })

  it('[security] reserves every static page under /invoices/ from the invoice numbers', () => {
    // The route table is the authority on what else lives under /invoices/;
    // the web app's rule is what decides which numbers are addresses. A
    // static page added there without being reserved here would be shadowed
    // for the links and read as an invoice by the page.
    const statics = new Set(
      app.routes
        .filter((route) => route.method === 'GET')
        .map((route) => /^\/invoices\/([^/:]+)(?:\/|$)/u.exec(route.path)?.[1])
        .filter((segment): segment is string => segment !== undefined),
    )
    expect([...statics].sort()).toEqual([
      'by-id',
      'configure',
      'estimates',
      'new',
      'recurring',
      'retainers',
    ])
    for (const segment of statics) {
      expect(invoiceNumberIsAddressable(segment), segment).toBe(false)
    }
  })

  it('[acceptance] serves the invoice editor as a page of its own', async () => {
    // The edit dialog was cramped; the editor is a full page now, beside the
    // detail page it returns to and addressed the same way.
    const res = await app.request('/invoices/42/edit', {}, env)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('data-app-view="invoice-edit"')
    expect(html).toMatch(/<main[^>]+data-invoice-edit-page>/u)
    expect(html).toContain('href="/invoices" data-money-nav hidden aria-current="page"')
  })

  it.each([
    '/invoices/by-id/0/edit',
    '/invoices/by-id/nope/edit',
    '/invoices/by-id/9007199254740992/edit',
    '/invoices/-1/edit',
    '/invoices/INV%207/edit',
    '/invoices/recurring/0/edit',
    '/invoices/recurring/nope/edit',
    '/invoices/recurring/9007199254740992/edit',
  ])('[security] rejects invalid editor path %s', async (path) => {
    expect((await app.request(path, {}, env)).status).toBe(404)
  })

  it.each(['/invoices/recurring/new', '/invoices/recurring/7/edit'])(
    '[acceptance] serves the recurring editor at %s under the Recurring tab',
    async (path) => {
      // Ahead of /invoices/:invoiceNumber and its own editor in the table, and a
      // step inside the Recurring tab rather than a destination of its own.
      const res = await app.request(path, {}, env)
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain('data-app-view="invoice-recurring-editor"')
      expect(html).toMatch(/<main[^>]+data-recurring-editor-page>/u)
      expect(html).toContain('<a href="/invoices/recurring" aria-current="page">Recurring</a>')
    },
  )

  it.each([
    ['/invoices/recurring', 'invoice-recurring'],
    ['/invoices/retainers', 'invoice-retainers'],
  ])(
    '[acceptance] serves %s under the Invoices strip',
    async (path, view) => {
      // These three sit ahead of /invoices/:invoiceNumber in the route table.
      // If that order ever slips they stop being tabs and fall to the number
      // route, which refuses a reserved segment with a 404.
      const res = await app.request(path, {}, env)
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain(`data-app-view="${view}"`)
      expect(html).toContain(`<a href="${path}" aria-current="page">`)
      expect(html).toContain('<a href="/invoices">Overview</a>')
    },
  )

  it('[acceptance] keeps /invoices/configure ahead of the invoice-number route', async () => {
    // It redirects to Settings now (issue 546), but the ordering concern it was
    // written for is unchanged: this path has to be matched before
    // /invoices/:invoiceNumber, which refuses "configure" as a reserved
    // segment, or the redirect becomes a 404.
    const res = await app.request('/invoices/configure', {}, env)
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/settings/templates')
  })

  it('[acceptance] serves the Clients V1 list and numeric detail shells', async () => {
    const list = await app.request('/clients', {}, env)
    const detail = await app.request('/clients/42', {}, env)

    expect(list.status).toBe(200)
    expect(list.headers.get('location')).toBeNull()
    const listHtml = await list.text()
    expect(listHtml).toContain('data-app-view="client-list"')
    expect(listHtml).toContain('data-client-list-page')
    expect(listHtml).toContain('href="/clients" data-directory-nav hidden aria-current="page"')

    expect(detail.status).toBe(200)
    const detailHtml = await detail.text()
    expect(detailHtml).toContain('data-app-view="client-detail"')
    expect(detailHtml).toContain('data-client-detail-page')
    expect(detailHtml).toContain('<dt>Worked-for parent</dt>')
    expect(detailHtml).toContain('<dt>Bill-to client</dt>')
  })

  it.each(['/clients/0', '/clients/nope', '/clients/9007199254740992'])(
    '[security] rejects invalid client detail path %s',
    async (path) => {
      expect((await app.request(path, {}, env)).status).toBe(404)
    },
  )

  it('[acceptance] serves the Projects V1 list and numeric detail shells', async () => {
    const list = await app.request('/projects', {}, env)
    const detail = await app.request('/projects/42', {}, env)

    expect(list.status).toBe(200)
    expect(list.headers.get('location')).toBeNull()
    const listHtml = await list.text()
    expect(listHtml).toContain('data-app-view="project-list"')
    expect(listHtml).toContain('data-project-list-page')
    expect(listHtml).toContain('href="/projects" data-directory-nav hidden aria-current="page"')

    expect(detail.status).toBe(200)
    const detailHtml = await detail.text()
    expect(detailHtml).toContain('data-app-view="project-detail"')
    expect(detailHtml).toContain('data-project-detail-page')
    expect(detailHtml).toContain('data-project-task-assignments')
    expect(detailHtml).toContain('<div class="project-form-body" data-project-form-body></div>')
    expect(detailHtml).not.toContain('name="hourly_rate_cents"')
    expect(detailHtml).not.toContain('name="cost_budget_cents"')
  })

  it('[acceptance] serves the Tasks administration shell without a redirect', async () => {
    const response = await app.request('/tasks', {}, env)

    expect(response.status).toBe(200)
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('cache-control')).toBe('no-store')
    const html = await response.text()
    expect(html).toContain('data-app-view="task-list"')
    expect(html).toContain('data-task-admin-page')
    expect(html).toContain('data-task-form-dialog')
    expect(html).toContain('data-task-archive-dialog')
    expect(html).toContain('href="/tasks" data-directory-nav hidden aria-current="page"')
  })

  it('[acceptance] serves the operational Reports shell without a redirect', async () => {
    const response = await app.request(
      '/reports?report=project-budget&from=2026-08-01&to=2026-08-31&project_id=42',
      {},
      env,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('cache-control')).toBe('no-store')
    const html = await response.text()
    expect(html).toContain('data-app-view="reports"')
    expect(html).toContain('data-reports-page')
    expect(html).toContain('href="/reports" aria-current="page"')
    // The kinds are the section's own level-2 strip, not a dropdown, and the
    // requested one is marked before a single byte of script has run.
    expect(html).toContain('<a href="/reports?report=uninvoiced">Uninvoiced work</a>')
    expect(html).toContain(
      '<a href="/reports?report=project-budget" aria-current="page">Project budget</a>',
    )
    expect(html).not.toContain('data-time-views')
    expect(html).toContain('Each currency remains separate.')
    // Scoped to the reports section: the shell serves every page's markup in
    // one document, and the invoice page's "Export hours" is not a report.
    const reportsStart = html.indexOf('data-reports-page')
    expect(html.slice(reportsStart, html.indexOf('</main>', reportsStart))).not.toContain('Export')
    // The strip carries a Profitability tab now, so the bare word appears as a
    // navigation label -- the same way Contractor cost has always appeared to
    // every profile, with the browser dropping the unreadable kinds once whoami
    // answers. What must still be absent is profit CONTENT: this route serves
    // the section skeleton and no report's figures.
    expect(html).toContain('<a href="/reports?report=profitability">Profitability</a>')
    expect(html).not.toContain('report-profit-summary')
    expect(html).not.toContain('report-profit-figure')
  })

  it.each(['/projects/0', '/projects/nope', '/projects/9007199254740992'])(
    '[security] rejects invalid project detail path %s',
    async (path) => {
      expect((await app.request(path, {}, env)).status).toBe(404)
    },
  )

  it('[acceptance] serves the Expenses V1 list and numeric detail shells', async () => {
    const list = await app.request('/expenses', {}, env)
    const detail = await app.request('/expenses/42', {}, env)

    expect(list.status).toBe(200)
    expect(list.headers.get('location')).toBeNull()
    const listHtml = await list.text()
    expect(listHtml).toContain('data-app-view="expense-list"')
    expect(listHtml).toContain('data-expense-list-page')
    expect(listHtml).toContain('data-expense-create-form')
    expect(listHtml).toContain('href="/expenses" data-expenses-nav aria-current="page"')
    expect(listHtml).toContain('href="/expense-categories">Manage categories</a>')

    expect(detail.status).toBe(200)
    const detailHtml = await detail.text()
    expect(detailHtml).toContain('data-app-view="expense-detail"')
    expect(detailHtml).toContain('data-expense-detail-page')
    expect(detailHtml).toContain('data-expense-edit-form')
    expect(detailHtml).toContain('data-expense-attachment-form')
  })

  it('[acceptance] serves the Expense Categories administration shell', async () => {
    const response = await app.request('/expense-categories?status=all', {}, env)

    expect(response.status).toBe(200)
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('cache-control')).toBe('no-store')
    const html = await response.text()
    expect(html).toContain('data-app-view="expense-categories"')
    expect(html).toContain('data-expense-categories-page')
    expect(html).toContain('data-expense-category-create-form')
    expect(html).toContain('data-expense-category-list')
    expect(html).toContain('href="/expenses" data-expenses-nav aria-current="page"')
    expect(html).toContain('Existing expenses keep their category')
  })

  it.each(['/expenses/0', '/expenses/nope', '/expenses/9007199254740992'])(
    '[security] rejects invalid expense detail path %s',
    async (path) => {
      expect((await app.request(path, {}, env)).status).toBe(404)
    },
  )

  it.each(['/', '/dashboard', '/clients', '/clients/42', '/projects', '/projects/42', '/tasks', '/expenses', '/expenses/42', '/expense-categories', '/invoices', '/invoices/42', '/invoices/42/edit', '/invoices/new', '/invoices/recurring/new', '/invoices/recurring/42/edit', '/approvals', '/reports', '/reports/saved'])(
    '[security] renders %s as an inert shell under an overlay when a session cookie is present',
    async (path) => {
      const res = await app.request(
        path,
        { headers: { cookie: '__Host-ezacto_session=opaque-session-token' } },
        env,
      )

      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toMatch(/data-auth-gateway[^>]+ hidden>/u)
      expect(html).toContain(
        'data-session-check-overlay role="status" aria-live="polite" aria-atomic="true">',
      )
      expect(html).toContain('data-authenticated-shell inert aria-busy="true"')
      expect(html).toContain('data-auth-action disabled')
      expect(html).not.toContain('opaque-session-token')
    },
  )

  it.each([
    'unrelated=value',
    '__Host-ezacto_session=',
    '__Host-ezacto_sessionish=opaque-session-token',
  ])('[security] does not resume the shell for non-session cookie %s', async (cookie) => {
    const res = await app.request('/', { headers: { cookie } }, env)
    const html = await res.text()

    expect(res.status).toBe(200)
    expect(html).toContain('data-authenticated-shell hidden inert aria-busy="true"')
    expect(html).toContain(
      'data-session-check-overlay role="status" aria-live="polite" aria-atomic="true" hidden>',
    )
    expect(html).not.toMatch(/data-auth-gateway[^>]+ hidden>/u)
  })

  it('serves deterministic shell assets with explicit content types', async () => {
    const [style, script] = await Promise.all([
      app.request('/assets/ezacto.css', {}, env),
      app.request('/assets/ezacto.js', {}, env),
    ])

    expect(style.status).toBe(200)
    expect(style.headers.get('content-type')).toBe('text/css; charset=utf-8')
    expect(await style.text()).toContain('@media (max-width: 720px)')
    expect(script.status).toBe(200)
    expect(script.headers.get('content-type')).toBe(
      'text/javascript; charset=utf-8',
    )
    const javascript = await script.text()
    expect(javascript.length).toBeGreaterThan(1_000)
    expect(javascript).toContain('/auth/sign-in')
    expect(javascript).toContain('/api/v1/sessions')
  })

  it('[security] advertises a configured Google flow without exposing its runtime secrets', async () => {
    const configured = {
      ...env,
      ENVIRONMENT: 'dev',
      DB: {} as D1Database,
      API_CURSOR_SIGNING_KEY: 'unused',
      OIDC_GOOGLE_CLIENT_ID: 'private-google-client-id',
      OIDC_GOOGLE_CLIENT_SECRET: 'private-google-client-secret',
    } satisfies WorkerEnv
    const res = await app.request('/', {}, configured)
    const html = await res.text()

    expect(res.status).toBe(200)
    expect(html).toContain('data-oidc-provider="google"')
    expect(html).toContain('href="/auth/oidc/google"')
    expect(html).not.toContain(configured.OIDC_GOOGLE_CLIENT_ID)
    expect(html).not.toContain(configured.OIDC_GOOGLE_CLIENT_SECRET)
    expect(html).not.toContain('accounts.google.com')
  })

  it.each([
    {
      name: 'missing credentials',
      values: {},
    },
    {
      name: 'partial credentials',
      values: {
        APP_BASE_URL: 'https://local-tunnel.example',
        OIDC_GOOGLE_CLIENT_ID: 'private-google-client-id',
      },
    },
    {
      name: 'oversized client id',
      values: {
        ENVIRONMENT: 'dev',
        OIDC_GOOGLE_CLIENT_ID: 'x'.repeat(513),
        OIDC_GOOGLE_CLIENT_SECRET: 'private-google-client-secret',
      },
    },
    {
      name: 'oversized client secret',
      values: {
        ENVIRONMENT: 'prod',
        OIDC_GOOGLE_CLIENT_ID: 'private-google-client-id',
        OIDC_GOOGLE_CLIENT_SECRET: 'x'.repeat(4_097),
      },
    },
    {
      name: 'non-HTTPS origin',
      values: {
        APP_BASE_URL: 'http://localhost:8787',
        OIDC_GOOGLE_CLIENT_ID: 'private-google-client-id',
        OIDC_GOOGLE_CLIENT_SECRET: 'private-google-client-secret',
      },
    },
    {
      name: 'non-origin HTTPS URL',
      values: {
        APP_BASE_URL: 'https://local-tunnel.example/path',
        OIDC_GOOGLE_CLIENT_ID: 'private-google-client-id',
        OIDC_GOOGLE_CLIENT_SECRET: 'private-google-client-secret',
      },
    },
    {
      name: 'non-HTTPS scheme',
      values: {
        APP_BASE_URL: 'javascript:alert(1)',
        OIDC_GOOGLE_CLIENT_ID: 'private-google-client-id',
        OIDC_GOOGLE_CLIENT_SECRET: 'private-google-client-secret',
      },
    },
  ])('[security] does not advertise Google for $name', async ({ values }) => {
    const res = await app.request(
      '/',
      {},
      {
        ...env,
        DB: {} as D1Database,
        API_CURSOR_SIGNING_KEY: 'unused',
        ...values,
      },
    )
    const html = await res.text()

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(html).not.toContain('data-oidc-provider')
    expect(html).not.toContain('data-oidc-entry')
    expect(html).not.toContain('Single sign-on is not available')
    expect(html).toContain('method="post" action="/auth/sign-in"')
  })

  it('[security] does not leak provider availability across sequential Worker requests', async () => {
    const configured = {
      ...env,
      ENVIRONMENT: 'dev',
      DB: {} as D1Database,
      API_CURSOR_SIGNING_KEY: 'unused',
      OIDC_GOOGLE_CLIENT_ID: 'private-google-client-id',
      OIDC_GOOGLE_CLIENT_SECRET: 'private-google-client-secret',
    } satisfies WorkerEnv
    const environments: WorkerEnv[] = [
      configured,
      { ...configured, OIDC_GOOGLE_CLIENT_SECRET: undefined },
      { ...configured, OIDC_GOOGLE_CLIENT_ID: 'x'.repeat(513) },
      configured,
    ]

    for (const [index, requestEnv] of environments.entries()) {
      const res = await app.request('/', {}, requestEnv)
      const html = await res.text()
      const shouldAdvertise = index === 0 || index === environments.length - 1

      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(html.includes('data-oidc-provider="google"')).toBe(shouldAdvertise)
      expect(html.includes('data-oidc-entry')).toBe(shouldAdvertise)
      expect(html).not.toContain('Single sign-on is not available')
    }
  })

  it('publishes the versioned OpenAPI contract without database bindings', async () => {
    const res = await app.request('/openapi/v1.json', {}, env)

    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=300')
    const document = (await res.json()) as {
      openapi: string
      info: { version: string }
      paths: Record<string, unknown>
    }
    expect(document.openapi).toBe('3.1.0')
    expect(document.info.version).toBe('1.0.0')
    expect(document.paths).toHaveProperty('/api/v1/time-entries')
    expect(document.paths).toHaveProperty('/api/v1/projects')
  })

  it('fails the shared API closed until this deployment configures an auth store', async () => {
    const res = await app.request('/api/v1', {}, env)

    expect(res.status).toBe(401)
    expect(res.headers.get('x-request-id')).toBeTruthy()
    expect(res.headers.get('www-authenticate')).toBe('Bearer realm="ezacto"')
    expect(await res.json()).toEqual({
      error: {
        code: 'authentication_required',
        message: 'A valid API token or user session is required.',
        fields: [],
      },
      request_id: res.headers.get('x-request-id'),
    })
  })

  it('escapes binding values rather than interpolating them into the page raw', async () => {
    const res = await app.request(
      '/',
      {},
      { ENVIRONMENT: '<script>x</script>', RELEASE: 'deadbeef' },
    )

    const html = await res.text()
    expect(html).not.toContain('<script>x</script>')
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;')
  })

  it('404s an unknown path instead of falling through to the page', async () => {
    const res = await app.request('/nope', {}, env)
    expect(res.status).toBe(404)
  })

  it('[browser #557] serves an unrouted page path as HTML, and the API as JSON', async () => {
    // A stale bookmark used to drop the reader onto the API's error object
    // filling the viewport with no way back.
    const page = await app.request('/time?view=day', {}, env)
    expect(page.status).toBe(404)
    expect(page.headers.get('content-type')).toContain('text/html')
    const html = await page.text()
    expect(html).toContain('data-not-found-page')
    expect(html).toContain('That page does not exist')
    // The way out is the point: a 404 with no navigation is the same dead end.
    expect(html).toContain('href="/"')
    expect(html).not.toContain('"code":"not_found"')

    // The API surface is untouched and still answers in JSON. Unauthenticated
    // it never reaches the not-found handler at all -- authentication runs
    // first and refuses -- which is the point worth pinning: the page branch
    // above must not have moved the API onto the HTML path.
    const api = await app.request('/api/v1/nonexistent-xyz', {}, env)
    expect(api.status).toBe(401)
    expect(api.headers.get('content-type')).toContain('application/json')
    expect(await api.text()).not.toContain('data-not-found-page')
  })

  it('[acceptance #546] serves templates from Settings and keeps the old invoice URL working', async () => {
    const page = await app.request('/settings/templates', {}, env)
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('data-app-view="settings-templates"')
    // The screen itself, not a placeholder: the same pane, now under Settings.
    expect(html).toContain('data-invoice-configure-page')
    expect(html).toContain('Email templates')
    // Reached from the Settings strip, behind the same gate as Company.
    expect(html).toContain('data-settings-templates-tab')

    // Every link and bookmark that shipped still resolves.
    const moved = await app.request('/invoices/configure', {}, env)
    expect(moved.status).toBe(301)
    expect(moved.headers.get('location')).toBe('/settings/templates')

    // And Invoices no longer offers it, so there is one place to look.
    const invoices = await app.request('/invoices', {}, env)
    expect(await invoices.text()).not.toContain('/invoices/configure')
  })
})
