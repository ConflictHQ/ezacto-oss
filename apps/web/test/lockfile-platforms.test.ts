import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('[regression #470] locks every optional Rolldown platform binding for portable clean installs', () => {
  const lock = JSON.parse(readFileSync(new URL('../../../package-lock.json', import.meta.url), 'utf8')) as {
    packages: Record<string, { version: string; optional?: boolean; optionalDependencies?: Record<string, string> }>
  }
  const rolldown = lock.packages['node_modules/rolldown']!
  expect(rolldown.optionalDependencies).toBeDefined()
  for (const [name, version] of Object.entries(rolldown.optionalDependencies!)) {
    const binding = lock.packages[`node_modules/${name}`]
    expect(binding, `${name} is required for a supported platform`).toBeDefined()
    expect(binding?.version).toBe(version)
    expect(binding?.optional).toBe(true)
  }
})
