// The release contract for @conflict-hq/ezacto-migrate. The packed-install
// smoke test (scripts/test-package.mjs) proves it works on a clean machine; this
// is the part that runs in every test job and fails the moment the manifest or
// the release workflow drifts from how the CLI and client are published.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repo = (path: string): string =>
  fileURLToPath(new URL(`../../../${path}`, import.meta.url))
const manifest = (path: string): Record<string, unknown> & {
  version: string
  dependencies: Record<string, string>
} => JSON.parse(readFileSync(repo(path), 'utf8'))

describe('@conflict-hq/ezacto-migrate release manifest', () => {
  const migrate = manifest('packages/migrate/package.json')

  it('[unit] is a public scoped package that installs the ezacto-migrate bin', () => {
    expect(migrate['name']).toBe('@conflict-hq/ezacto-migrate')
    expect(migrate['bin']).toEqual({ 'ezacto-migrate': './dist/cli.js' })
    expect(migrate['publishConfig']).toEqual({ access: 'public' })
    expect(migrate['license']).toBe('AGPL-3.0-only')
    expect(migrate['repository']).toEqual({
      type: 'git',
      url: 'git+https://github.com/ConflictHQ/ezacto-oss.git',
      directory: 'packages/migrate',
    })
  })

  it('[unit] ships only the bundle and depends on nothing unpublished', () => {
    expect(migrate['files']).toEqual(['dist/cli.js'])
    // @ezacto/* are never published; they are bundled into dist/cli.js.
    const unpublished = Object.keys(migrate.dependencies).filter((name) =>
      name.startsWith('@ezacto/'),
    )
    expect(unpublished).toEqual([])
    expect(Object.keys(migrate.dependencies).sort()).toEqual([
      '@noble/hashes',
      'better-sqlite3',
      'drizzle-orm',
    ])
  })

  it('[unit] versions move in lockstep with the CLI and client the release tag covers', () => {
    expect(migrate.version).toBe(manifest('packages/cli/package.json').version)
    expect(migrate.version).toBe(manifest('packages/client/package.json').version)
  })

  it('[unit] the release workflow checks, tests, and publishes it with provenance', () => {
    const workflow = readFileSync(repo('.github/workflows/publish-npm.yml'), 'utf8')
    expect(workflow).toContain('packages/client packages/cli packages/migrate')
    expect(workflow).toContain('test:package -w @conflict-hq/ezacto-migrate')
    expect(workflow).toContain(
      'npm publish -w @conflict-hq/ezacto-migrate --access public --provenance',
    )
    const verify = readFileSync(repo('.github/workflows/verify.yml'), 'utf8')
    expect(verify).toContain('workspaces: -w @conflict-hq/ezacto-migrate')
    expect(verify).toContain('test:package -w @conflict-hq/ezacto-migrate')
  })
})
