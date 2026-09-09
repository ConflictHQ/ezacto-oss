import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../../..', import.meta.url))

const workspaceManifests = (): { name: string; test: string }[] => {
  const manifests: { name: string; test: string }[] = []
  for (const group of ['packages', 'apps', 'entries']) {
    for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const path = join(root, group, entry.name, 'package.json')
      let raw: string
      try {
        raw = readFileSync(path, 'utf8')
      } catch {
        continue
      }
      const manifest = JSON.parse(raw) as { scripts?: Record<string, string> }
      const test = manifest.scripts?.test
      if (test !== undefined && test.includes('vitest')) {
        manifests.push({ name: `${group}/${entry.name}`, test })
      }
    }
  }
  return manifests
}

describe('workspace test timeouts', () => {
  it('[unit] gives a setup hook the same budget as the test it sets up', () => {
    // Vitest keeps `hookTimeout` separate from `testTimeout`, and only the
    // second is what `--testTimeout` sets. Every workspace here raised the test
    // timeout because booting Miniflare or a database is slow, and every one of
    // them left the hook that does the booting on the 10s default -- so a loaded
    // CI shard fails in `beforeAll` with "Hook timed out in 10000ms", and then
    // `afterAll` throws over the top of it because the harness is undefined.
    //
    // That is not hypothetical: it turned main's deploy red at 05:12 on
    // 2026-09-09 in packages/db/test/identity.test.ts, on a shard that had
    // passed on the pull request minutes earlier.
    const wrong: string[] = []
    for (const { name, test } of workspaceManifests()) {
      const testTimeout = /--testTimeout=(\d+)/u.exec(test)
      if (testTimeout === null) continue
      const raised = Number(testTimeout[1])
      // At or below the hook default there is nothing to raise.
      if (raised <= 10_000) continue
      const hookTimeout = /--hookTimeout=(\d+)/u.exec(test)
      if (hookTimeout === null || Number(hookTimeout[1]) < raised) {
        wrong.push(`${name}: --testTimeout=${raised} with ${hookTimeout?.[0] ?? 'no --hookTimeout'}`)
      }
    }
    expect(wrong).toEqual([])
  })
})
