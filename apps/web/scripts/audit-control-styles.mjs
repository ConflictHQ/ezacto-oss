import { URL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

// The native harness owns its ephemeral SQLite fixture; no remote URL is accepted.
const record = process.argv.includes('--record')
const baseline = process.argv.includes('--baseline')
const screenshots = process.argv.includes('--screenshots')
const index = process.argv.indexOf('--output')
if (
  index >= 0 &&
  (!process.argv[index + 1] || process.argv[index + 1].startsWith('--'))
)
  throw new Error('--output requires a local directory')
const output = resolve(
  index < 0 ? '../../.tmp/control-style-audit' : process.argv[index + 1],
)
await mkdir(output, { recursive: true })
const run = spawnSync(
  'npm',
  [
    'exec',
    '--',
    'playwright',
    'test',
    '--config',
    'playwright.config.ts',
    'control-style-guard.browser.ts',
    '--output',
    output,
    ...(baseline ? ['--grep', '390 light sidebar'] : []),
  ],
  {
    cwd: new URL('..', import.meta.url),
    stdio: 'inherit',
    env: {
      ...process.env,
      ...(record ? { EZACTO_CONTROL_AUDIT_RECORD: '1' } : {}),
      ...(screenshots ? { EZACTO_CONTROL_AUDIT_SCREENSHOTS: '1' } : {}),
    },
  },
)
const reports = []
for (const directory of await readdir(output, { withFileTypes: true })) {
  if (!directory.isDirectory()) continue
  try {
    reports.push(
      JSON.parse(
        await readFile(
          resolve(output, directory.name, 'control-style-observations.json'),
          'utf8',
        ),
      ),
    )
  } catch {
    /* Failed startup produces no audit and retains Playwright's failure status. */
  }
}
await writeFile(
  resolve(output, 'audit.json'),
  JSON.stringify({ reports }, null, 2) + '\n',
)
if (reports.length !== (baseline ? 1 : 4)) process.exitCode = run.status || 1
else process.exitCode = run.status ?? 1
