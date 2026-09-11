import { defineConfig } from 'vitest/config'

/**
 * `maxWorkers` is set here because the flag CI passes cannot reach vitest.
 *
 * `verify.yml` runs `npm test $WORKSPACES -- --maxWorkers=2`. For every other
 * workspace that lands on a `test` script which *is* `vitest run`, so the flag
 * arrives. This one is a four-command chain, so npm appends the flag after
 * `npm run test:browser`, where it is taken for an npm config key and silently
 * dropped -- reaching neither vitest nor playwright.
 *
 * It matters for this workspace in particular: happy-dom retains roughly 25 MB
 * for every parse of the shell markup and frees it only when the Window is
 * dropped, which vitest does once per file. Files running in parallel each hold
 * their own Window, so the worker count is a direct multiplier on peak heap,
 * and a CI fork has far less of it than a developer machine.
 *
 * Bounded only under CI. Locally the default is faster and there is memory to
 * spare.
 */
export default defineConfig({
  test: {
    setupFiles: ['./test/setup-browser-storage.ts'],
    ...(process.env['CI'] === undefined ? {} : { maxWorkers: 2 }),
  },
})
