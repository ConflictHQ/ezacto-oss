import { writeFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'

// Current-app evidence only: the supplied dashboard/login/styles reference is unavailable.
for (const width of [390, 1280])
  for (const scheme of ['light', 'dark'] as const) {
    test.describe(`current layout ${width}px ${scheme}`, () => {
      test.use({
        viewport: { width, height: 900 },
        colorScheme: scheme,
        hasTouch: width === 390,
      })
      test('[audit #995] inspect native workflows, keyboard focus and contained width', async ({
        page,
        context,
      }, info) => {
        test.setTimeout(120_000)
        await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: scheme })
        await page.route('https://fonts.googleapis.com/**', (route) => route.abort())
        await context.addCookies([
          { name: 'ezacto_scheme', value: scheme, url: info.project.use.baseURL! },
        ])
        const errors: string[] = []
        page.on('pageerror', (error) => errors.push(error.name + ': ' + error.message))
        await page.goto('/')
        await expect(page.locator('[data-sign-in-form]')).toBeVisible()
        const observations: unknown[] = []
        const inspect = async (screen: string) => {
          await page.waitForLoadState('networkidle')
          const layout = await page.evaluate(() => {
            const root = document.documentElement
            const controls = [
              ...document.querySelectorAll<HTMLElement>('button,summary,input,select,textarea'),
            ]
              .filter(
                (element) =>
                  !element.closest('[hidden],[inert]') && element.getBoundingClientRect().width > 0,
              )
              .map((element) => {
                const target = element.matches('input[type="checkbox"],input[type="radio"]')
                  ? (element.closest('label') ?? element)
                  : element
                const rect = target.getBoundingClientRect(),
                  style = getComputedStyle(target)
                return {
                  tag: element.tagName,
                  label:
                    element.getAttribute('aria-label') ??
                    element.textContent?.trim().slice(0, 80) ??
                    '',
                  width: Math.round(rect.width),
                  height: Math.round(rect.height),
                  transition: style.transitionDuration,
                }
              })
            return {
              width: innerWidth,
              documentWidth: root.scrollWidth,
              controls,
              reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
              background: getComputedStyle(root).backgroundColor,
            }
          })
          observations.push({ screen, ...layout })
          expect
            .soft(layout.documentWidth, `${screen} document overflow`)
            .toBeLessThanOrEqual(layout.width)
          if (screen === 'login') {
            const forgot = layout.controls.find((control) => control.label === 'Forgot password?')
            expect.soft(forgot?.height, 'password recovery touch target').toBeGreaterThanOrEqual(44)
          }
          if (screen === 'week')
            for (const label of ['Previous period', 'Next period']) {
              const arrow = layout.controls.find((control) => control.label === label)
              expect.soft(arrow?.height, label + ' touch target').toBeGreaterThanOrEqual(44)
            }
          expect(layout.reducedMotion).toBe(true)
          await page.keyboard.press('Tab')
          const focused = await page.evaluate(() => {
            const node = document.activeElement as HTMLElement | null
            return {
              tag: node?.tagName,
              inert: !!node?.closest('[inert],[hidden]'),
              outline: node ? getComputedStyle(node).outlineStyle : '',
            }
          })
          observations.push({ screen, focus: focused })
          expect.soft(focused.tag, `${screen} keyboard focus`).not.toBe('BODY')
          expect.soft(focused.inert, `${screen} inert focus`).toBe(false)
          await page.screenshot({
            path: info.outputPath(`${screen}-${width}-${scheme}.png`),
            fullPage: true,
          })
        }
        await inspect('login')
        await page.request.post('/__ezacto_browser_fixture__/start-end', {
          data: { action: 'sign-in-rate-reset' },
          headers: { 'x-ezacto-browser-fixture-control': 'start-end-round-trip' },
        })
        await page
          .locator('[data-sign-in-form]')
          .getByLabel('Email')
          .fill(process.env.EZACTO_BROWSER_FIXTURE_EMAIL!)
        await page
          .getByLabel('Password', { exact: true })
          .fill(process.env.EZACTO_BROWSER_FIXTURE_PASSWORD!)
        await page.getByRole('button', { name: 'Sign in', exact: true }).click()
        await expect(page.locator('[data-authenticated-shell]:not([inert])')).toBeVisible()
        for (const [screen, path] of [
          ['week', '/'],
          ['dashboard', '/dashboard'],
          ['invoices', '/invoices'],
          ['expenses', '/expenses'],
          ['reports', '/reports'],
          ['approvals', '/approvals'],
        ] as const) {
          const response = await page.goto(path)
          expect(response?.status(), screen).toBe(200)
          await inspect(screen)
        }
        const artifact = info.outputPath('current-app-observations.json')
        await writeFile(artifact, JSON.stringify({ width, scheme, errors, observations }, null, 2))
        await info.attach('current-app-observations.json', {
          path: artifact,
          contentType: 'application/json',
        })
        expect(errors).toEqual([])
      })
    })
  }
