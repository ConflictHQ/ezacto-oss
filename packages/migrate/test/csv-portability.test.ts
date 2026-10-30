import { expect, it } from 'vitest'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { parseCsv, sourceKeys } from '../src/csv-contract.js'
import { canonicalMapping, emptyMapping, parseMapping } from '../src/csv-mapping.js'

it('[#1180] bundles parser, mapping and source identity without Node builtins', async () => {
  const result = await build({
    stdin: {
      contents:
        "export * from './src/csv-contract.js'; export * from './src/csv-mapping.js'; export * from './src/csv-planner.js'; export * from './src/csv-dataset-contract.js'",
      resolveDir: process.cwd(),
    },
    bundle: true,
    platform: 'browser',
    format: 'esm',
    write: false,
    logLevel: 'silent',
    metafile: true,
  })
  expect(Object.keys(result.metafile!.inputs).some((path) => path.startsWith('node:'))).toBe(false)
})

it('[#1180] retains CLI byte hashes, canonical mapping and source identity', () => {
  const bytes = new TextEncoder().encode(
    'date,person_email,client,project,task,hours,notes\n2026-09-01,a@example.com,C,P,T,1,Unicode Ω\n',
  )
  const parsed = parseCsv(bytes)
  expect(parsed.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
  const row = parsed.rows[0]!
  const expectedKey =
    createHash('sha256')
      .update(
        JSON.stringify([
          row.date,
          row.personEmail,
          row.client,
          row.project,
          row.task,
          row.seconds,
          row.startedTime,
          row.endedTime,
          row.notes,
          row.billable,
        ]),
      )
      .digest('hex') + '#0'
  expect(sourceKeys(parsed.rows)).toEqual([expectedKey])
  const mapping = canonicalMapping(parseMapping(JSON.stringify(emptyMapping())))
  expect(mapping.sha256).toBe(createHash('sha256').update(mapping.json).digest('hex'))
})
