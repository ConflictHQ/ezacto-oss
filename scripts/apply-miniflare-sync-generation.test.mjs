import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { applyMiniflareSyncGeneration } from './apply-miniflare-sync-generation.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(resolve(root, 'patches/miniflare-sync-generation.json'), 'utf8'))
const paths = ['node_modules/miniflare', 'node_modules/wrangler/node_modules/miniflare']
const hash = value => createHash('sha256').update(value).digest('hex')
const pristine = await Promise.all(paths.map(async (path, index) => {
  let source = await readFile(resolve(root, path, 'dist/src/index.js'), 'utf8')
  const patch = manifest.packages[index]
  if (hash(source) === patch.outputSha256) {
    for (const replacement of [...manifest.replacements].reverse()) source = source.replace(replacement.after, replacement.before)
  }
  assert.equal(hash(source), patch.inputSha256, 'fixture must use the published original bytes')
  return source
}))
const fixture = async (context, installed = true) => {
  const directory = await realpath(await mkdtemp(resolve(tmpdir(), 'miniflare-backport-')))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const packages = Object.fromEntries(paths.map((path, index) => [path, { version: manifest.packages[index].version }]))
  await writeFile(resolve(directory, 'package-lock.json'), JSON.stringify({ packages }))
  if (installed) for (const [index, path] of paths.entries()) {
    await mkdir(resolve(directory, path, 'dist/src'), { recursive: true })
    await writeFile(resolve(directory, path, 'package.json'), JSON.stringify(packages[path]))
    await writeFile(resolve(directory, path, 'dist/src/index.js'), pristine[index], { mode: 0o640 })
  }
  return directory
}

test('applies the reviewed bytes to both locked versions and is idempotent', async context => {
  const directory = await fixture(context)
  assert.deepEqual(await applyMiniflareSyncGeneration(directory), { applied: 2, already: 0, absent: 0 })
  assert.deepEqual(await applyMiniflareSyncGeneration(directory), { applied: 0, already: 2, absent: 0 })
  for (const [index, path] of paths.entries()) {
    const target = resolve(directory, path, 'dist/src/index.js')
    assert.equal(hash(await readFile(target)), manifest.packages[index].outputSha256)
    assert.equal((await stat(target)).mode & 0o777, 0o640)
  }
})
test('rejects unexpected bytes before changing any candidate', async context => {
  const directory = await fixture(context)
  await writeFile(resolve(directory, paths[1], 'dist/src/index.js'), pristine[1] + '\n')
  await assert.rejects(applyMiniflareSyncGeneration(directory), /Unexpected Miniflare bytes/)
  assert.equal(hash(await readFile(resolve(directory, paths[0], 'dist/src/index.js'))), manifest.packages[0].inputSha256)
})
test('does not require absent development dependencies in a production install', async context => {
  assert.deepEqual(await applyMiniflareSyncGeneration(await fixture(context, false)), { applied: 0, already: 0, absent: 2 })
})
test('refuses an unreviewed installed version without altering its source', async context => {
  const directory = await fixture(context)
  const packages = { [paths[0]]: { version: '99.0.0' } }
  await writeFile(resolve(directory, 'package-lock.json'), JSON.stringify({ packages }))
  await writeFile(resolve(directory, paths[0], 'package.json'), JSON.stringify(packages[paths[0]]))
  await assert.rejects(applyMiniflareSyncGeneration(directory), /Unreviewed Miniflare version/)
  assert.equal(hash(await readFile(resolve(directory, paths[0], 'dist/src/index.js'))), manifest.packages[0].inputSha256)
})
