import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  type DeploymentBrand,
  type ReportBrand,
  brandFromEnv,
  defaultBrand,
  defaultReportBrand,
  resolveDeploymentBrand,
  resolveReportBrand,
} from '../src/brand.js'
import { renderAppShell, renderDocumentShell } from '../src/shell/render.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const filesUnder = async (directory: string): Promise<string[]> => {
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(directory, { withFileTypes: true })
  const paths = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name)
      return entry.isDirectory() ? filesUnder(path) : Promise.resolve([path])
    }),
  )
  return paths.flat()
}

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
