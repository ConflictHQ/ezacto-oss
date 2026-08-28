import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('core package contents', () => {
  it('[unit] packs the resolver runtime and declarations', () => {
    const output = execFileSync(
      'npm',
      ['pack', '--dry-run', '--json', '--silent'],
      {
        cwd: new URL('..', import.meta.url),
        encoding: 'utf8',
      },
    )
    const packed = JSON.parse(output) as Array<{
      files: Array<{ path: string }>
    }>
    expect(packed[0]?.files.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        'dist/index.js',
        'dist/index.d.ts',
        'dist/rates.js',
        'dist/rates.d.ts',
      ]),
    )
  }, 20_000)
})
