import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

/**
 * The screens declare what they need as optional methods on an API interface;
 * `createShellApi` is the one place the real generated client is bound to them.
 * A method declared and never bound is a control that renders, does nothing,
 * and reports "not configured" for ever.
 *
 * That is not hypothetical. Issue 593 shipped an Accounting settings section
 * reading four QuickBooks methods that nothing supplied, so every deployment
 * said "This deployment is not configured for QuickBooks" and the connect
 * button never appeared. The suite stayed green because every screen test
 * injects its own API object -- which is exactly what makes this the one thing
 * a unit test cannot catch and a source guard can.
 */
const interfaceMethods = (source: string, name: string): string[] => {
  const start = source.indexOf(`export interface ${name} {`)
  if (start === -1) throw new Error(`${name} is not declared`)
  let depth = 0
  let index = source.indexOf('{', start)
  const open = index
  do {
    if (source[index] === '{') depth += 1
    if (source[index] === '}') depth -= 1
    index += 1
  } while (depth > 0 && index < source.length)
  const body = source.slice(open + 1, index - 1)
  // Members at the top level of the interface only: a method named inside a
  // nested object type is part of that type, not of this one.
  const methods = new Set<string>()
  let nesting = 0
  for (const line of body.split('\n')) {
    const text = line.trim()
    if (nesting === 0) {
      const match = /^([A-Za-z][A-Za-z0-9]*)\??\s*\(/u.exec(text)
      if (match !== null) methods.add(match[1]!)
    }
    nesting += (line.match(/\{/gu) ?? []).length - (line.match(/\}/gu) ?? []).length
  }
  return [...methods]
}

describe('every screen method the real client should supply', () => {
  it('[security] is bound in createShellApi, or the control silently does nothing', async () => {
    const shell = await readFile(resolve(root, 'src', 'shell', 'model.ts'), 'utf8')
    const settings = await readFile(
      resolve(root, 'src', 'module-settings', 'model.ts'),
      'utf8',
    )
    const clients = await readFile(resolve(root, 'src', 'clients', 'model.ts'), 'utf8')

    const declared = [
      ...interfaceMethods(settings, 'CompanySettingsApi'),
      ...interfaceMethods(clients, 'ClientDirectoryApi'),
    ]
    expect(declared.length).toBeGreaterThan(10)

    const factory = shell.slice(shell.indexOf('export const createShellApi'))
    const unbound = declared.filter(
      (method) => !new RegExp(`\\n  ${method}:`, 'u').test(factory),
    )

    /**
     * Methods a screen declares that the shell deliberately does not bind.
     *
     * A ratchet, like the theme token list: this may shrink, and a NEW name
     * appearing here fails the build rather than being waved through. Anything
     * listed needs a reason, because the default reading of an unbound method
     * is a bug.
     */
    const deliberatelyUnbound: string[] = []
    expect(unbound).toEqual(deliberatelyUnbound)
  })

  it('[unit] the extraction finds real methods, so an empty list cannot pass vacuously', async () => {
    // Without this the guard above would pass on a parser that returned nothing
    // -- which is how a source-scanning test quietly stops testing.
    const settings = await readFile(
      resolve(root, 'src', 'module-settings', 'model.ts'),
      'utf8',
    )
    const methods = interfaceMethods(settings, 'CompanySettingsApi')
    expect(methods).toContain('getTimeEntrySettings')
    expect(methods).toContain('getQuickBooksConnection')
    expect(methods).toContain('listSsoDomains')
  })
})
