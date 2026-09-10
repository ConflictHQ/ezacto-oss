import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, realpath, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createCanonicalTemporaryDirectory,
  createPhysicalSnapshotMetadata,
  verifyPhysicalSnapshot,
} from '../../../scripts/container-physical-snapshot.mjs'

const helper = new URL(
  '../../../scripts/container-physical-snapshot.mjs',
  import.meta.url,
)

const roots: string[] = []

const fixture = async (): Promise<{
  root: string
  attachment: string
}> => {
  // realpath because macOS puts $TMPDIR under /var, itself a symlink to
  // /private/var. The code under test refuses a symlinked path on purpose, so
  // the fixture has to hand it a canonical one rather than the check be relaxed.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ezacto-physical-snapshot-')))
  roots.push(root)
  const database = new BetterSqlite3(join(root, 'db.sqlite'))
  database.exec(
    "CREATE TABLE fixture (value TEXT NOT NULL); INSERT INTO fixture VALUES ('kept')",
  )
  database.close()

  const bytes = Buffer.from('attachment survives physical restore')
  const hash = createHash('sha256').update(bytes).digest('hex')
  const directory = join(root, 'attachments', 'sha256', hash.slice(0, 2))
  await mkdir(directory, { recursive: true })
  const attachment = join(directory, hash)
  await writeFile(attachment, bytes)
  const metadata = await createPhysicalSnapshotMetadata(
    root,
    {
      container: 'ezacto',
      volume: 'ezacto-data',
      image: 'ezacto:test',
      image_id: `sha256:${'a'.repeat(64)}`,
    },
    '2026-09-01T00:00:00.000Z',
  )
  await writeFile(
    join(root, 'snapshot.json'),
    `${JSON.stringify(metadata, null, 2)}\n`,
  )
  return { root, attachment }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('container physical snapshot', () => {
  it('[regression #471] canonicalizes owned temp directories without accepting operator symlinks', async () => {
    const { root } = await fixture()
    const parent = await realpath(await mkdtemp(join(tmpdir(), 'ezacto-linked-temp-parent-')))
    roots.push(parent)
    const alias = join(parent, 'alias')
    await symlink(root, alias, 'dir')

    const temporary = await createCanonicalTemporaryDirectory('restore-', alias)
    expect(temporary).toBe(await realpath(temporary))
    expect(temporary.startsWith(`${root}/restore-`)).toBe(true)
    await expect(verifyPhysicalSnapshot(alias)).rejects.toThrow('must not be a symbolic link')
  })

  it('[unit] verifies the exact SQLite and content-addressed attachment inventory', async () => {
    const { root } = await fixture()

    await expect(verifyPhysicalSnapshot(root)).resolves.toMatchObject({
      schema_version: 1,
      kind: 'ezacto-container-physical-snapshot',
      files: [
        { path: expect.stringMatching(/^attachments\/sha256\//u) },
        { path: 'db.sqlite' },
      ],
    })

    const command = spawnSync(
      process.execPath,
      [helper.pathname, 'verify', '--bundle', root],
      { encoding: 'utf8' },
    )
    expect(command.status).toBe(0)
    expect(command.stdout).toContain(`physical snapshot verified: ${root}`)
    expect(command.stderr).toBe('')
  })

  it('[security] rejects changed content and symbolic links', async () => {
    const changed = await fixture()
    await writeFile(changed.attachment, 'changed')
    await expect(verifyPhysicalSnapshot(changed.root)).rejects.toThrow(
      'content does not match its key',
    )

    const linked = await fixture()
    await symlink(
      join(linked.root, 'db.sqlite'),
      join(linked.root, 'attachments', 'database-link'),
    )
    await expect(verifyPhysicalSnapshot(linked.root)).rejects.toThrow(
      'must not be a symbolic link',
    )
  })
})
