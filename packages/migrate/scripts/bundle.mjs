import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

// @ezacto/core and @ezacto/db are workspace packages that are never published,
// so the released CLI carries them inside dist/cli.js. Every other bare import
// stays external and must be a declared runtime dependency; the build fails
// rather than ship a package that cannot start on a clean machine.
const external = {
  name: 'external-third-party',
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith('@ezacto/')) return undefined
      return { path: args.path, external: true }
    })
  },
}

const result = await build({
  entryPoints: [resolve(root, 'src/cli.ts')],
  outfile: resolve(root, 'dist/cli.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Resolve the workspace packages from source, so the bundle never depends on
  // whatever dist an earlier build left behind.
  conditions: ['development'],
  plugins: [external],
  metafile: true,
  logLevel: 'warning',
})

const declared = new Set(Object.keys(manifest.dependencies ?? {}))
const undeclared = new Set()
for (const output of Object.values(result.metafile.outputs)) {
  for (const imported of output.imports) {
    if (!imported.external || imported.path.startsWith('node:')) continue
    const parts = imported.path.split('/')
    const name = imported.path.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
    if (!declared.has(name)) undeclared.add(name)
  }
}
if (undeclared.size > 0) {
  throw new Error(`dist/cli.js imports undeclared runtime dependencies: ${[...undeclared].join(', ')}`)
}

// The Worker entry contains the portable loader and its workspace dependencies,
// while the standalone CLI retains its existing Node dependency contract.
await build({
  entryPoints: [resolve(root, 'src/queued-loader.ts')],
  outfile: resolve(root, 'dist/queued-loader.js'),
  bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
  conditions: ['development'], external: ['node:async_hooks'], logLevel: 'warning',
})
