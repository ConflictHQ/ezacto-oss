import { defineConfig } from 'vitest/config'

/**
 * Keep a developer run from opening enough migrated D1 fixtures to exhaust
 * local resources. CI supplies its own two-worker limit on the command line,
 * so it must remain free to override this default without passing the same CLI
 * option twice (Vitest 4 rejects duplicate values).
 */
export default defineConfig({
  test: {
    ...(process.env['CI'] === undefined ? { maxWorkers: 8 } : {}),
  },
})
