import { writeFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { collectControlStyles } from './control-style-audit.js'
import {
  COMPANY_SETTINGS_SECTIONS,
  USER_SETTINGS_SECTIONS,
} from '../src/settings-sections.js'
import { renderPortalInvoicePage } from '../src/portal-invoice/render.js'
import { quote } from './fixtures/portal-estimate.js'
import { defaultTheme, themeManifest } from '../src/theme.js'
import {
  renderAppleDisconnect,
  renderDocumentShell,
} from '../src/shell/render.js'

/** One authenticated browser per pairwise palette/width/navigation case, not a shell mount per assertion. */
import { controlAuditScreens } from './control-style-screens.js'

for (const scenario of [
  { width: 390, scheme: 'light', nav: 'sidebar' },
  { width: 390, scheme: 'dark', nav: 'topbar' },
  { width: 1280, scheme: 'light', nav: 'topbar' },
  { width: 1280, scheme: 'dark', nav: 'sidebar' },
] as const)
  test.describe(`control styles ${scenario.width} ${scenario.scheme} ${scenario.nav}`, () => {
    test.use({
      viewport: { width: scenario.width, height: 900 },
      colorScheme: scenario.scheme,
    })
    test('[#1260] every native shell screen and standalone controls use the existing theme', async ({
      page,
      context,
    }, info) => {
      test.setTimeout(180_000)
      const base = info.project.use.baseURL!
      await context.addCookies([
        { name: 'ezacto_scheme', value: scenario.scheme, url: base },
        { name: 'ezacto_nav', value: scenario.nav, url: base },
      ])
      await page.route('https://fonts.googleapis.com/**', (route) =>
        route.abort(),
      )
      const results: {
        screen: string
        inspected: number
        findings: ReturnType<typeof collectControlStyles>
        controls: ReturnType<typeof collectControlStyles>
        coverage: string
      }[] = []
      const inspect = async (
        screen: string,
        options: {
          linksOnly?: boolean
          standalone?: boolean
          coverage?: string
        } = {},
      ) => {
        await page.waitForLoadState('networkidle')
        const elements = await page.evaluate(collectControlStyles, {
          includeHidden: true,
          standalone: options.standalone ?? false,
        })
        const audited = options.linksOnly
          ? elements.filter((node) => ['a', 'button'].includes(node.tag))
          : elements
        const findings = audited.filter((node) => node.reasons.length)
        results.push({
          screen,
          inspected: audited.length,
          findings,
          controls: audited,
          coverage: options.coverage ?? 'rendered view',
        })
        if (!process.env.EZACTO_CONTROL_AUDIT_RECORD)
          expect.soft(findings, screen).toEqual([])
        if (
          await page
            .locator(
              'a[href]:visible,button:visible,input:not([type=hidden]):visible,select:visible,textarea:visible',
            )
            .count()
        ) {
          // Follow native keyboard focus, including modal focus traps and label focus-within rings.
          await page.keyboard.press('Tab')
          const visibleRing = await page.evaluate(() => {
            let node = document.activeElement
            if (!node || node === document.body) return false
            while (node && node !== document.body) {
              const style = getComputedStyle(node)
              if (
                (style.outlineStyle !== 'none' &&
                  parseFloat(style.outlineWidth) >= 1) ||
                (node === document.activeElement && style.boxShadow !== 'none')
              )
                return true
              node = node.parentElement
            }
            return false
          })
          if (!process.env.EZACTO_CONTROL_AUDIT_RECORD)
            expect.soft(visibleRing, screen + ' keyboard focus').toBe(true)
        }
        if (
          process.env.EZACTO_CONTROL_AUDIT_SCREENSHOTS ||
          findings.length ||
          screen === 'time' ||
          (scenario.width === 390 &&
            [
              'magic-link-confirmation',
              'portal-estimates-sign-in',
              'portal-estimates-confirm',
              'apple-disconnect',
            ].includes(screen))
        )
          await page.screenshot({
            path: info.outputPath(screen + '.png'),
            fullPage: true,
          })
      }
      const control = async (action: string) =>
        expect(
          (
            await page.request.post('/__ezacto_browser_fixture__/start-end', {
              headers: {
                'x-ezacto-browser-fixture-control': 'start-end-round-trip',
              },
              data: { action },
            })
          ).status(),
        ).toBe(204)
      await control('sign-in-rate-reset')
      await control('client-360-cleanup')
      await page.goto('/')
      await inspect('sign-in', { linksOnly: true })
      await page
        .locator('[data-sign-in-form]')
        .getByLabel('Email')
        .fill(process.env.EZACTO_BROWSER_FIXTURE_EMAIL!)
      await page
        .getByLabel('Password', { exact: true })
        .fill(process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!)
      await page.getByRole('button', { name: 'Sign in', exact: true }).click()
      await expect(
        page.locator('[data-authenticated-shell]:not([inert])'),
      ).toBeVisible()
      await control('client-360-seed')
      try {
        for (const [name, path] of controlAuditScreens) {
          const response = await page.goto(path)
          expect(
            name === 'not-found' ? [200, 404] : [200],
            name + ' HTTP',
          ).toContain(response?.status())
          await expect(page.locator('html')).toHaveAttribute(
            'data-app-view',
            name,
          )
          await expect(
            page.locator('[data-authenticated-shell]:not([inert])'),
          ).toBeVisible()
          await inspect(name)
        }
        for (const [scope, sections] of [
          ['company', COMPANY_SETTINGS_SECTIONS],
          ['user', USER_SETTINGS_SECTIONS],
        ] as const) {
          for (const section of sections) {
            // A same-document hash navigation has no HTTP response. Reload it
            // so every inspected section still proves its actual document is 200.
            const response =
              (await page.goto(`/settings/${scope}#${section.id}`)) ??
              (await page.reload())
            expect(response?.status()).toBe(200)
            await expect(page.locator('html')).toHaveAttribute(
              'data-app-view',
              `settings-${scope}`,
            )
            await page.waitForLoadState('networkidle')
            const pane = page.locator(
              scope === 'company'
                ? `[data-settings-section="${section.id}"]`
                : `[data-settings-user-pane="${section.id}"]`,
            )
            await expect(pane).toHaveCount(1)
            const unavailable =
              (await pane.getAttribute('data-settings-unavailable')) !== null
            if (unavailable) await expect(pane).toBeHidden()
            else await expect(pane).toBeVisible()
            await inspect(`settings-${scope}-${section.id}`, {
              coverage: unavailable
                ? 'unavailable section: hidden CSS inventory'
                : 'active settings section',
            })
          }
        }
        await page.goto('/invoices/by-id/9300')
        await page.emulateMedia({ media: 'print' })
        await inspect('invoice-print', { linksOnly: true })
        await page.emulateMedia({ media: 'screen' })
        // GET is scanner-safe and only validates format; this unissued synthetic token is never redeemed.
        const magicResponse = await page.goto(
          '/auth/magic-link/verify?token=' + 'A'.repeat(43),
        )
        expect(magicResponse?.status()).toBe(200)
        await expect(
          page.getByRole('heading', { name: 'Finish signing in', exact: true }),
        ).toBeVisible()
        await expect(page.locator('form')).toHaveAttribute('method', 'post')
        await expect(page.locator('form')).toHaveAttribute(
          'action',
          '/auth/magic-link/verify',
        )
        await expect(page.locator('input[name=token]')).toHaveValue(
          'A'.repeat(43),
        )
        await expect(
          page.getByRole('button', { name: 'Continue', exact: true }),
        ).toHaveCount(1)
        await expect(page.locator('html')).toHaveAttribute(
          'data-ez-theme',
          defaultTheme,
        )
        await expect(page.locator('html')).toHaveAttribute(
          'data-ez-scheme',
          scenario.scheme,
        )
        const theme = themeManifest[defaultTheme]
        const ink =
          scenario.scheme === 'dark' ? theme.darkColors!.ink : theme.colors.ink
        const rgb = `rgb(${[1, 3, 5].map((offset) => Number.parseInt(ink.slice(offset, offset + 2), 16)).join(', ')})`
        expect(
          await page
            .getByRole('heading', { name: 'Finish signing in', exact: true })
            .evaluate((node) => getComputedStyle(node).color),
        ).toBe(rgb)
        expect(
          await page
            .locator('html')
            .evaluate((node) =>
              getComputedStyle(node)
                .getPropertyValue('--ez-ink')
                .trim()
                .toLowerCase(),
            ),
        ).toBe(ink.toLowerCase())
        await inspect('magic-link-confirmation', { standalone: true })
        // Native portal HTML/controller with owned read-only responses: coherent sign-in, list, detail and confirmation states.
        let portalPosts = 0
        await page.route('**/portal/estimates/7/response', (route) => {
          portalPosts++
          return route.abort()
        })
        await page.route('**/portal/estimates', (route) =>
          route.fulfill({
            status: 401,
            json: {
              error: {
                code: 'unauthorized',
                message: 'Owned signed-out fixture',
              },
            },
          }),
        )
        expect((await page.goto('/portal/estimate-review'))?.status()).toBe(200)
        await expect(
          page.getByRole('heading', { name: 'Your estimates', exact: true }),
        ).toBeVisible()
        await expect(page.locator('[data-portal-sign-in]')).toBeVisible()
        await page.evaluate(
          (scheme) =>
            document.documentElement.setAttribute('data-ez-scheme', scheme),
          scenario.scheme,
        )
        await inspect('portal-estimates-sign-in', { standalone: true })
        await page.unroute('**/portal/estimates')
        await page.route('**/portal/estimates', (route) =>
          route.fulfill({ json: { data: { estimates: [quote] } } }),
        )
        await page.goto('/portal/estimate-review')
        await expect(
          page.getByRole('link', { name: 'EST-7', exact: true }),
        ).toBeVisible()
        await page.evaluate(
          (scheme) =>
            document.documentElement.setAttribute('data-ez-scheme', scheme),
          scenario.scheme,
        )
        await inspect('portal-estimates-list', { standalone: true })
        await page.route('**/portal/estimates/7', (route) =>
          route.fulfill({ json: { data: quote } }),
        )
        await page.goto('/portal/estimate-review?estimate=7')
        await expect(
          page.getByRole('heading', { name: 'Estimate EST-7', exact: true }),
        ).toBeVisible()
        await expect(
          page.getByRole('table', { name: 'Lines on estimate EST-7' }),
        ).toBeVisible()
        await page.evaluate(
          (scheme) =>
            document.documentElement.setAttribute('data-ez-scheme', scheme),
          scenario.scheme,
        )
        await inspect('portal-estimates-detail', { standalone: true })
        await page
          .getByRole('button', { name: 'Accept this estimate', exact: true })
          .click()
        await expect(page.locator('[data-portal-confirm]')).toBeVisible()
        await expect(page.locator('[data-portal-confirm-text]')).toContainText(
          'Accept estimate EST-7 for $1,080.00?',
        )
        await expect(page.locator('[data-portal-confirm-text]')).toContainText(
          'Nothing is charged and no invoice is raised.',
        )
        await expect(page.locator('[data-portal-confirm-text]')).toBeFocused()
        await expect(page.locator('[data-portal-confirm-yes]')).toHaveText(
          'Confirm: accept this estimate',
        )
        expect(portalPosts).toBe(0)
        await inspect('portal-estimates-confirm', { standalone: true })
        await page.getByRole('button', { name: 'Cancel', exact: true }).click()
        await expect(page.locator('[data-portal-confirm]')).toBeHidden()
        expect(portalPosts).toBe(0)
        // Actual standalone renderers, with owned data and the shipped stylesheet.
        // No portal credentials are minted or saved in screenshots/reports.
        const invoice = renderPortalInvoicePage(
          {
            companyName: 'Owned style fixture',
            clientName: 'Owned client',
            number: 'STYLE-1',
            subject: null,
            currency: 'USD',
            issueDate: '2026-10-01',
            dueDate: '2026-11-01',
            amountCents: 100,
            dueAmountCents: 100,
            state: 'open',
            paymentUrl: 'https://example.test/pay',
            hasDocument: true,
          },
          'owned-audit-token',
        )
        const apple = renderAppleDisconnect({
          connected: true,
          unavailable: false,
        })
        for (const [name, html] of [
          ['portal-invoice', invoice],
          [
            'document',
            `<!doctype html><html data-ez-theme="${defaultTheme}"><head><link rel="stylesheet" href="/assets/ezacto.css"></head><body>` +
              renderDocumentShell('Owned document', 'Owned document content') +
              '</body></html>',
          ],
          ['apple-disconnect', apple],
          [
            'apple-recovery',
            renderAppleDisconnect({ connected: false, unavailable: false }),
          ],
          [
            'apple-success',
            renderAppleDisconnect({
              connected: false,
              unavailable: false,
              disconnected: true,
            }),
          ],
        ] as const) {
          await page.setContent(
            html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''),
          )
          await page.evaluate(
            (scheme) =>
              document.documentElement.setAttribute('data-ez-scheme', scheme),
            scenario.scheme,
          )
          await expect(page.locator('html')).toHaveAttribute(
            'data-ez-theme',
            defaultTheme,
          )
          const heading =
            name === 'portal-invoice'
              ? 'Invoice STYLE-1'
              : name === 'document'
                ? 'Owned document'
                : 'Disconnect Apple'
          await expect(
            page.getByRole('heading', { name: heading, exact: true }),
          ).toBeVisible()
          if (name === 'portal-invoice') {
            await expect(
              page.getByRole('link', { name: 'Download PDF', exact: true }),
            ).toBeVisible()
            await expect(
              page.getByRole('link', { name: 'Pay online', exact: true }),
            ).toBeVisible()
          }
          if (name === 'apple-success') {
            await expect(page.getByRole('status')).toHaveText(
              'Your Apple authorization has been disconnected. Your workspace records have not been deleted.',
            )
            await expect(page.locator('form')).toHaveCount(0)
          }
          if (name === 'apple-disconnect') {
            const checkbox = page.locator('input[type=checkbox]')
            const glyph = await checkbox.boundingBox()
            const label = await page
              .locator('.apple-disconnect-confirm')
              .boundingBox()
            expect(glyph?.height).toBeLessThanOrEqual(20)
            expect(glyph?.width).toBeLessThanOrEqual(20)
            expect(label?.height).toBeGreaterThanOrEqual(44)
          }
          if (name === 'apple-disconnect')
            await expect(
              page.getByRole('button', {
                name: 'Disconnect Apple',
                exact: true,
              }),
            ).toBeVisible()
          if (name === 'apple-recovery')
            await expect(
              page.getByRole('button', {
                name: 'Recover this deletion request with Apple',
                exact: true,
              }),
            ).toBeVisible()
          await inspect(name, { standalone: true })
        }
      } finally {
        await control('client-360-cleanup')
        await writeFile(
          info.outputPath('control-style-observations.json'),
          JSON.stringify({ scenario, results }, null, 2),
        )
      }
    })
  })
