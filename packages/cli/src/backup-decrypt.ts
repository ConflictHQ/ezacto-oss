import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  backupKeyBytes,
  backupSha256,
  decryptBackupObject,
  workerBackupFiles,
  WORKER_BACKUP_FILE_MAX_BYTES,
} from '@ezacto/core'
/** Decrypts and verifies a downloaded Worker logical bundle into a new private directory. */
export const decryptBackupBundle = async (input: {
  inputDirectory: string
  outputDirectory: string
  encodedKey: string
}) => {
  const key = backupKeyBytes(input.encodedKey),
    source = resolve(input.inputDirectory),
    output = resolve(input.outputDirectory)
  const nesting = relative(source, output)
  if (
    nesting === '' ||
    (!isAbsolute(nesting) && nesting !== '..' && !nesting.startsWith('..' + sep))
  )
    throw new Error('The decrypted output must be outside the encrypted input directory.')
  await mkdir(output, { mode: 0o700 })
  const names = new Set<string>()
  try {
    const walk = async (directory: string, prefix = ''): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const relative = prefix + entry.name
        if (entry.isSymbolicLink())
          throw new Error('Encrypted backup input must not contain symbolic links.')
        if (entry.isDirectory()) {
          await walk(join(directory, entry.name), relative + '/')
          continue
        }
        if (!entry.isFile() || !relative.endsWith('.ezenc'))
          throw new Error('Download only one encrypted backup run into the input directory.')
        if ((await stat(join(directory, entry.name))).size > 16 * 1024 * 1024 + 8192)
          throw new Error('The encrypted object exceeds the scheduled backup format limit.')
        const plain = await decryptBackupObject(
          new Uint8Array(await readFile(join(directory, entry.name))),
          key,
        )
        if (plain.bytes.length > WORKER_BACKUP_FILE_MAX_BYTES)
          throw new Error('The decrypted object exceeds the backup format limit.')
        if (relative !== plain.name + '.ezenc' || names.has(plain.name))
          throw new Error('The encrypted object path differs from its authenticated name.')
        names.add(plain.name)
        const target = join(output, plain.name)
        await mkdir(join(target, '..'), { recursive: true, mode: 0o700 })
        await writeFile(target, plain.bytes, { flag: 'wx', mode: 0o600 })
      }
    }
    await walk(source)
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8')) as {
      schema_version: number
      table_count: number
      total_rows: number
      tables: Record<string, { sha256: string }>
      files?: unknown
    }
    if (
      manifest.schema_version !== 1 ||
      Object.keys(manifest.tables).length !== manifest.table_count ||
      !names.has('RESTORE.md')
    )
      throw new Error('The decrypted logical-backup manifest is incomplete or unsupported.')
    const expected = new Set(['manifest.json', 'RESTORE.md'])
    for (const [table, receipt] of Object.entries(manifest.tables)) {
      if (!/^[A-Za-z0-9_]+$/u.test(table) || !/^[0-9a-f]{64}$/u.test(receipt.sha256))
        throw new Error('The decrypted manifest names an invalid table or checksum.')
      const name = `tables/${table}.csv`
      expected.add(name)
      if (
        !names.has(name) ||
        (await backupSha256(new Uint8Array(await readFile(join(output, name))))) !== receipt.sha256
      )
        throw new Error(`The decrypted table ${table} does not match its manifest checksum.`)
    }
    for (const file of workerBackupFiles(manifest.files)) {
      expected.add(file.name)
      if (!names.has(file.name)) throw new Error('The decrypted backup is missing a declared file.')
      const bytes = new Uint8Array(await readFile(join(output, file.name)))
      if (bytes.length !== file.byte_size || (await backupSha256(bytes)) !== file.sha256)
        throw new Error('A decrypted backup file does not match its manifest receipt.')
    }
    if (expected.size > 65535) throw new Error('The decrypted backup contains too many files.')
    if (names.size !== expected.size || [...names].some((name) => !expected.has(name)))
      throw new Error('The downloaded run contains objects outside its logical manifest.')
    return {
      outputDirectory: output,
      objects: names.size,
      tableCount: manifest.table_count,
      totalRows: manifest.total_rows,
    }
  } catch (error) {
    await rm(output, { recursive: true, force: true })
    throw error
  }
}
