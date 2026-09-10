import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  type DeploymentBrand,
  brandFromEnv,
  brandFromSources,
  brandFromStoredAssets,
  defaultBrand,
  defaultReportBrand,
  resolveDeploymentBrand,
  resolveReportBrand,
} from '../src/brand.js'
import { renderAppShell, renderDocumentShell } from '../src/shell/render.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('F12/DV-23 deployment brand seam', () => {
  it('[unit] no inline wordmark — shell source has zero hardcoded "ezacto" in user-visible text', async () => {
    const shellSource = await readFile(
      resolve(root, 'src', 'shell', 'render.ts'),
      'utf8',
    )
    const userVisibleHardcoded = shellSource
      .split('\n')
      .filter(
        (line) =>
          line.includes("'ezacto'") ||
          (line.includes('"ezacto"') && !line.includes('meta name=')),
      )
      .filter(
        (line) =>
          !line.includes('import ') &&
          !line.includes('from ') &&
          !line.includes('// ') &&
          !line.includes('.css') &&
          !line.includes('.js'),
      )
    expect(
      userVisibleHardcoded,
      'found hardcoded ezacto in user-facing shell render source',
    ).toEqual([])
  })

  it('[unit] brand slots filled from config and values escaped', () => {
    const custom: Partial<DeploymentBrand> = {
      name: 'Acme<Corp',
      tagline: 'Track & bill',
      description: 'Enterprise "time" system',
    }
    const html = renderAppShell({
      environment: 'test',
      release: 'abc1234',
      brand: custom,
    })
    expect(html).toContain('Acme&lt;Corp')
    expect(html).toContain('Track &amp; bill')
    expect(html).toContain('Enterprise &quot;time&quot; system')
    expect(html).toContain('data-brand="Acme&lt;Corp"')
    expect(html).not.toContain('<Corp')
    expect(html).toContain('Sign in to Acme&lt;Corp')
  })

  it('[unit] default brand emits ezacto when no override is given', () => {
    const html = renderAppShell({
      environment: 'test',
      release: 'abc1234',
    })
    expect(html).toContain('data-brand="ezacto"')
    expect(html).toContain('Sign in to ezacto')
    expect(html).toContain('Time, exactly.')
  })

  it('[manual] config-only rebrand leaves zero ezacto strings user-visible', () => {
    const custom: Partial<DeploymentBrand> = {
      name: 'Acme Time',
      tagline: 'Track every minute.',
      description: 'Your company time tracker.',
      favicon: '/custom-favicon.ico',
    }
    const html = renderAppShell({
      environment: 'test',
      release: 'abc1234',
      brand: custom,
    })
    const visibleText = html
      .replace(/<[^>]+>/gu, ' ')
      .replace(/\s+/gu, ' ')
    const ezactoOccurrences = visibleText
      .split(/\b/u)
      .filter((word) => word.toLowerCase() === 'ezacto')
    expect(ezactoOccurrences).toEqual([])
    expect(html).toContain('Acme Time')
    expect(html).toContain('custom-favicon.ico')
  })

  it('[unit] document shell uses brand name from config', () => {
    const html = renderDocumentShell('Test Doc', 'Some content', {
      name: 'Acme',
    })
    expect(html).toContain('>Acme</span>')
    expect(html).not.toContain('>ezacto</span>')
  })

  it('[unit] report_brand and deployment_brand resolve without collision in one render', () => {
    const deploy = resolveDeploymentBrand({ name: 'Acme Time' })
    const report = resolveReportBrand({ name: 'Acme Reports', header: 'Acme Corp' })
    expect(deploy.name).toBe('Acme Time')
    expect(report.name).toBe('Acme Reports')
    expect(deploy.name).not.toBe(report.name)
    const shellHtml = renderAppShell({
      environment: 'test',
      release: 'abc1234',
      brand: { name: deploy.name },
    })
    expect(shellHtml).toContain('Acme Time')
    expect(shellHtml).not.toContain('Acme Reports')
  })

  it('[unit] resolveDeploymentBrand uses defaults for missing fields', () => {
    const brand = resolveDeploymentBrand({ name: 'Custom' })
    expect(brand.name).toBe('Custom')
    expect(brand.tagline).toBe(defaultBrand.tagline)
    expect(brand.description).toBe(defaultBrand.description)
  })

  it('[unit] resolveDeploymentBrand ignores empty strings', () => {
    const brand = resolveDeploymentBrand({ name: '', tagline: '' })
    expect(brand.name).toBe(defaultBrand.name)
    expect(brand.tagline).toBe(defaultBrand.tagline)
  })

  it('[unit] resolveReportBrand uses defaults for missing fields', () => {
    const report = resolveReportBrand({ header: 'Custom Header' })
    expect(report.name).toBe(defaultReportBrand.name)
    expect(report.header).toBe('Custom Header')
  })

  it('[unit] brandFromEnv returns undefined when no brand vars are set', () => {
    expect(brandFromEnv({})).toBeUndefined()
    expect(brandFromEnv({ ENVIRONMENT: 'prod', RELEASE: 'abc' })).toBeUndefined()
  })

  it('[unit] brandFromEnv extracts all brand env vars', () => {
    const env = {
      BRAND_NAME: 'Acme',
      BRAND_TAGLINE: 'Track it.',
      BRAND_DESCRIPTION: 'Acme time tracker.',
      BRAND_FAVICON: '/acme.ico',
      BRAND_WORDMARK_LIGHT: '/acme-light.svg',
      BRAND_WORDMARK_DARK: '/acme-dark.svg',
      BRAND_EMAIL_SENDER_NAME: 'Acme Time',
    }
    const brand = brandFromEnv(env)
    expect(brand).toEqual({
      name: 'Acme',
      tagline: 'Track it.',
      description: 'Acme time tracker.',
      favicon: '/acme.ico',
      wordmarkLight: '/acme-light.svg',
      wordmarkDark: '/acme-dark.svg',
      emailSenderName: 'Acme Time',
    })
  })

  it('[unit] brandFromEnv partial override fills only provided slots', () => {
    const brand = brandFromEnv({ BRAND_NAME: 'Custom' })
    expect(brand).toEqual({ name: 'Custom' })
    const resolved = resolveDeploymentBrand(brand)
    expect(resolved.name).toBe('Custom')
    expect(resolved.tagline).toBe(defaultBrand.tagline)
  })

  it('[unit] brandFromEnv ignores empty-string env vars', () => {
    expect(brandFromEnv({ BRAND_NAME: '' })).toBeUndefined()
  })
})

describe('#489 uploaded brand marks', () => {
  const stored = [
    { slot: 'wordmark_light', url: '/brand/wordmark-light/aaaa' },
    { slot: 'wordmark_dark', url: '/brand/wordmark-dark/bbbb' },
    { slot: 'favicon', url: '/brand/favicon/cccc' },
  ] as const

  it('[unit] a stored mark fills the slot its slot names', () => {
    expect(brandFromStoredAssets(stored)).toEqual({
      wordmarkLight: '/brand/wordmark-light/aaaa',
      wordmarkDark: '/brand/wordmark-dark/bbbb',
      favicon: '/brand/favicon/cccc',
    })
  })

  it('[unit] no stored marks resolves to nothing rather than empty slots', () => {
    expect(brandFromStoredAssets([])).toBeUndefined()
  })

  it('[unit] an uploaded mark wins over the deploy-time URL for its slot', () => {
    const brand = brandFromSources(
      {
        BRAND_WORDMARK_LIGHT: 'https://cdn.example/light.png',
        BRAND_WORDMARK_DARK: 'https://cdn.example/dark.png',
      },
      [{ slot: 'wordmark_dark', url: '/brand/wordmark-dark/bbbb' }],
    )
    expect(brand?.wordmarkDark).toBe('/brand/wordmark-dark/bbbb')
    // Per slot, not per source: the light mark the deployment configured is
    // untouched by an upload into the dark slot.
    expect(brand?.wordmarkLight).toBe('https://cdn.example/light.png')
  })

  it('[unit] the env vars stay the fallback when nothing is uploaded', () => {
    expect(
      brandFromSources({
        BRAND_NAME: 'Acme',
        BRAND_WORDMARK_DARK: 'https://cdn.example/dark.png',
      }),
    ).toEqual({ name: 'Acme', wordmarkDark: 'https://cdn.example/dark.png' })
  })

  it('[unit] no configuration and no upload is still no brand override', () => {
    expect(brandFromSources({}, [])).toBeUndefined()
  })

  it('[unit] the shell draws the dark-ground mark where the ground is dark', () => {
    const html = renderAppShell({
      environment: 'test',
      release: 'abc1234',
      brand: {
        name: 'Acme',
        wordmarkDark: '/brand/wordmark-dark/bbbb',
        wordmarkLight: '/brand/wordmark-light/aaaa',
      },
    })
    // The topbar and the sign-in splash are both painted --ez-ink, so both take
    // the mark meant for a dark ground; the light-ground one belongs to the
    // document shell and must not appear here.
    expect(html).toContain('<img class="brand-mark" src="/brand/wordmark-dark/bbbb" alt="Acme">')
    expect(html).not.toContain('/brand/wordmark-light/aaaa')
    expect(
      html.match(/<img class="brand-mark" src="\/brand\/wordmark-dark\/bbbb"/gu),
    ).toHaveLength(2)
  })

  it('[unit] the document shell draws the light-ground mark', () => {
    const html = renderDocumentShell('Invoice', 'Body', {
      name: 'Acme',
      wordmarkLight: '/brand/wordmark-light/aaaa',
      wordmarkDark: '/brand/wordmark-dark/bbbb',
    })
    expect(html).toContain('<img class="brand-mark" src="/brand/wordmark-light/aaaa" alt="Acme">')
    expect(html).not.toContain('wordmark-dark')
  })

  it('[unit] the brand name is the alt text, so a mark that fails to load still says who this is', () => {
    const html = renderAppShell({
      environment: 'test',
      release: 'abc1234',
      brand: { name: 'Acme & Co', wordmarkDark: '/brand/wordmark-dark/b"b' },
    })
    expect(html).toContain('alt="Acme &amp; Co"')
    expect(html).toContain('src="/brand/wordmark-dark/b&quot;b"')
  })

  it('[unit] a mark hosted elsewhere keeps the text wordmark, because the CSP refuses it', () => {
    // BRAND_WORDMARK_* take URLs to files the operator hosts somewhere else, and
    // every shell response sets `img-src 'self' data:`. Emitting one as an <img>
    // anyway replaces a styled wordmark with a blocked image on the sign-in
    // splash -- the first thing anybody sees. Only an uploaded mark, served from
    // this origin at /brand/..., can be an image at all.
    for (const hosted of [
      'https://cdn.example/dark.png',
      'http://cdn.example/dark.png',
      '//cdn.example/dark.png',
    ]) {
      const html = renderAppShell({
        environment: 'test',
        release: 'abc1234',
        brand: { name: 'Acme', wordmarkDark: hosted },
      })
      expect(html).not.toContain('brand-mark')
      expect(html).not.toContain('cdn.example')
      expect(html).toContain('>Acme</a>')
    }

    // And the same-origin case still renders, so this narrows the image to what
    // the CSP allows rather than turning the feature off.
    const uploaded = renderAppShell({
      environment: 'test',
      release: 'abc1234',
      brand: { name: 'Acme', wordmarkDark: '/brand/wordmark-dark/bbbb' },
    })
    expect(uploaded).toContain('<img class="brand-mark" src="/brand/wordmark-dark/bbbb" alt="Acme">')
  })

  it('[unit] with no mark configured the wordmark is still the name', () => {
    const html = renderAppShell({
      environment: 'test',
      release: 'abc1234',
      brand: { name: 'Acme' },
    })
    expect(html).not.toContain('brand-mark')
    expect(html).toContain('>Acme</a>')
  })
})
