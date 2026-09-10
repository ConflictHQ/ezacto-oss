import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../../', import.meta.url))

it('[security #469] keeps the advertised minimum and storage-regression runtime in CI', () => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { engines: { node: string } }
  expect(manifest.engines.node).toBe('>=22')
  expect(readFileSync(resolve(root, '.nvmrc'), 'utf8').trim()).toBe('22')
  for (const group of ['apps', 'entries', 'packages']) {
    for (const directory of readdirSync(resolve(root, group))) {
      const path = resolve(root, group, directory, 'package.json')
      if (!existsSync(path)) continue
      const workspace = JSON.parse(readFileSync(path, 'utf8')) as { engines: { node: string } }
      expect(workspace.engines.node, path).toBe(manifest.engines.node)
    }
  }
  const workflow = readFileSync(resolve(root, '.github/workflows/verify.yml'), 'utf8')
  const compatibility = workflow.slice(workflow.indexOf('  web-runtime-compatibility:'), workflow.indexOf('  typecheck:'))
  expect(compatibility).toContain('node: [22, 25]')
  expect(compatibility).toContain('node-version: ${{ matrix.node }}')
  expect(compatibility).toContain('test/dashboard-browser.test.ts')
  expect(compatibility).toContain('test/browser-storage.test.ts')
  expect(compatibility).toContain('test/node-runtime-contract.test.ts')
})
