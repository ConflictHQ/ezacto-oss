import { fileURLToPath, URL } from 'node:url'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('..', import.meta.url))

// The report inventory is shared domain code, but @ezacto/core is not an npm
// package. Include this small, dependency-free module in the published CLI.
await build({
  entryPoints: [resolve(root, 'src/money.ts')],
  outfile: resolve(root, 'dist/money.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  alias: {
    '@ezacto/core': resolve(root, '../core/src/report-capabilities.ts'),
  },
})

// Offline decryption and Worker restore share unpublished, dependency-free
// format code. Include it in both public entry modules.
for (const entry of ['backup-decrypt', 'worker-backup']) {
  await build({
    entryPoints: [resolve(root, `src/${entry}.ts`)],
    outfile: resolve(root, `dist/${entry}.js`),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    alias: {
      '@ezacto/core': resolve(root, 'scripts/backup-core.ts'),
    },
  })
}
