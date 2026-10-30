import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { backupBase64, backupSha256, encryptBackupObject } from '@ezacto/core'
import { decryptBackupBundle } from '../src/backup-decrypt.js'
import { runCli } from '../src/cli.js'
let root: string | undefined
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
})
const setup = async (modern = false, wrongSize = false) => {
  root = await mkdtemp(join(tmpdir(), 'ezacto-encrypted-backup-'))
  const input = join(root, 'encrypted'),
    output = join(root, 'plain'),
    key = crypto.getRandomValues(new Uint8Array(32))
  await mkdir(join(input, 'tables'), { recursive: true })
  const table = new TextEncoder().encode('id,notes\n1,private payroll\n')
  const schema = new TextEncoder().encode('{"tables":[]}')
  const rows = new TextEncoder().encode('[[1,null,"", "こんにちは"]]')
  const attachment = new Uint8Array([0,1,2,255])
  const attachmentHash = await backupSha256(attachment)
  const extraFiles = modern ? [
    ['schema.json',schema], ['rows/users/000001.json',rows], [`attachments/sha256/${attachmentHash.slice(0,2)}/${attachmentHash}`,attachment]
  ] as const : []
  const files = Object.fromEntries(await Promise.all(extraFiles.map(async ([name, bytes]) => [name,{sha256:await backupSha256(bytes),byte_size:bytes.length+(wrongSize && name==='schema.json'?1:0)}])))
  const manifest = {
    schema_version: 1,
    ...(modern ? {bundle_version:'0038',files} : {}),
    table_count: 1,
    total_rows: 1,
    tables: { users: { sha256: await backupSha256(table) } },
  }
  for (const [name, bytes] of [
    ['tables/users.csv', table],
    ['RESTORE.md', new TextEncoder().encode('Logical export recovery instructions')],
    ['manifest.json', new TextEncoder().encode(JSON.stringify(manifest))],
    ...extraFiles,
  ] as const) {
    const cipher = await encryptBackupObject(
      {
        name,
        bytes,
        sha256: await backupSha256(bytes),
        nonce: crypto.getRandomValues(new Uint8Array(12)),
      },
      key,
    )
    await mkdir(dirname(join(input,name+'.ezenc')), {recursive:true})
    await writeFile(join(input, name + '.ezenc'), cipher)
  }
  return { input, output, key, extraFiles, encodedKey: backupBase64(key) }
}
it('the offline CLI decrypts and verifies a downloaded logical bundle without account credentials', async () => {
  const f = await setup(),
    lines: string[] = []
  expect(
    await runCli(['backup-decrypt', f.input, '--output', f.output, '--json'], {
      environment: { EZACTO_BACKUP_ENCRYPTION_KEY: f.encodedKey },
      stdout: (line) => lines.push(line),
      stderr: () => {},
      readStdin: async () => '',
    }),
  ).toBe(0)
  expect(JSON.parse(lines[0]!)).toMatchObject({ tableCount: 1, totalRows: 1, objects: 3 })
  expect(await readFile(join(f.output, 'tables/users.csv'), 'utf8')).toContain('private payroll')
  expect((await stat(f.output)).mode & 0o777).toBe(0o700)
  await expect(
    decryptBackupBundle({
      inputDirectory: f.input,
      outputDirectory: f.output,
      encodedKey: f.encodedKey,
    }),
  ).rejects.toThrow()
  expect(await readFile(join(f.output, 'tables/users.csv'), 'utf8')).toContain('private payroll')
})
it('wrong keys and damaged files leave no partial plaintext output', async () => {
  const f = await setup()
  await expect(
    decryptBackupBundle({
      inputDirectory: f.input,
      outputDirectory: f.output,
      encodedKey: backupBase64(crypto.getRandomValues(new Uint8Array(32))),
    }),
  ).rejects.toThrow()
  await expect(stat(f.output)).rejects.toThrow()
  await writeFile(join(f.input, 'tables/users.csv.ezenc'), new Uint8Array([1, 2, 3]))
  await expect(
    decryptBackupBundle({
      inputDirectory: f.input,
      outputDirectory: f.output,
      encodedKey: f.encodedKey,
    }),
  ).rejects.toThrow()
  await expect(stat(f.output)).rejects.toThrow()
})

it('decrypts every declared restorable file with exact bytes and private modes', async () => {
  const f = await setup(true)
  const result = await decryptBackupBundle({inputDirectory:f.input,outputDirectory:f.output,encodedKey:f.encodedKey})
  expect(result.objects).toBe(6)
  for (const [name,bytes] of f.extraFiles) {
    expect(new Uint8Array(await readFile(join(f.output,name)))).toEqual(bytes)
    expect((await stat(join(f.output,name))).mode & 0o777).toBe(0o600)
  }
})
it('rejects a declared size mismatch and removes all partial plaintext', async () => {
  const f = await setup(true,true)
  await expect(decryptBackupBundle({inputDirectory:f.input,outputDirectory:f.output,encodedKey:f.encodedKey})).rejects.toThrow('manifest receipt')
  await expect(stat(f.output)).rejects.toThrow()
})
