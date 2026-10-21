import ts from 'typescript'
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
  const file = ts.createSourceFile('api.ts', source, ts.ScriptTarget.Latest, true)
  const declaration = file.statements.find(
    (statement): statement is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(statement) && statement.name.text === name,
  )
  if (!declaration) throw new Error(`${name} is not declared`)
  return declaration.members.flatMap((member) =>
    ts.isMethodSignature(member) && ts.isIdentifier(member.name) ? [member.name.text] : [],
  )
}

describe('every screen method the real client should supply', () => {
  it('[security] is bound in createShellApi, or the control silently does nothing', async () => {
    const shell = await readFile(resolve(root, 'src', 'shell', 'model.ts'), 'utf8')
    const settings = await readFile(resolve(root, 'src', 'module-settings', 'model.ts'), 'utf8')
    const clients = await readFile(resolve(root, 'src', 'clients', 'model.ts'), 'utf8')
    const rateCards = await readFile(resolve(root, 'src', 'clients', 'rate-card-model.ts'), 'utf8')
    // The invoice pages: an unbound lookup there is a page addressed by its
    // number that says it is unavailable in this build.
    const invoices = await readFile(resolve(root, 'src', 'invoices', 'model.ts'), 'utf8')
    // Recurring: a definition's standing files are optional methods, and an
    // unbound one is an Attachments section that never appears.
    const recurring = await readFile(resolve(root, 'src', 'recurring', 'model.ts'), 'utf8')

    const declared = [
      ...interfaceMethods(settings, 'CompanySettingsApi'),
      ...interfaceMethods(clients, 'ClientDirectoryApi'),
      ...interfaceMethods(rateCards, 'ClientRateCardApi'),
      ...interfaceMethods(invoices, 'InvoicePaymentApi'),
      ...interfaceMethods(recurring, 'RecurringWorkspaceApi'),
    ]
    expect(declared.length).toBeGreaterThan(10)

    const factory = shell.slice(shell.indexOf('export const createShellApi'))
    const unbound = declared.filter((method) => !new RegExp(`\\n  ${method}:`, 'u').test(factory))

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

  it('[unit] extracts inherited interface declarations without treating nested methods as screen bindings', () => {
    expect(
      interfaceMethods(
        'export interface Child extends Parent { load?(): Promise<void>; nested: { hidden(): void } }',
        'Child',
      ),
    ).toEqual(['load'])
  })

  it('[unit] the extraction finds real methods, so an empty list cannot pass vacuously', async () => {
    // Without this the guard above would pass on a parser that returned nothing
    // -- which is how a source-scanning test quietly stops testing.
    const settings = await readFile(resolve(root, 'src', 'module-settings', 'model.ts'), 'utf8')
    const methods = interfaceMethods(settings, 'CompanySettingsApi')
    expect(methods).toContain('getTimeEntrySettings')
    expect(methods).toContain('getQuickBooksConnection')
    expect(methods).toContain('listSsoDomains')
    const invoices = await readFile(resolve(root, 'src', 'invoices', 'model.ts'), 'utf8')
    expect(interfaceMethods(invoices, 'InvoicePaymentApi')).toContain('findInvoiceByNumber')
  })
})
