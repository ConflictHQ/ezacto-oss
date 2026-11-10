import { createHash } from 'node:crypto'
import { readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const hash = value => createHash('sha256').update(value).digest('hex')

/** Apply only the reviewed upstream handoff fix to the exact locked bundles.
 * All candidates are validated before any file is changed. Omitting development
 * dependencies leaves nothing to patch; unknown installed bytes fail closed.
 */
export const applyMiniflareSyncGeneration = async (projectRoot = root) => {
  projectRoot = await realpath(projectRoot)
  const manifest = JSON.parse(await readFile(resolve(root, 'patches/miniflare-sync-generation.json'), 'utf8'))
  const lock = JSON.parse(await readFile(resolve(projectRoot, 'package-lock.json'), 'utf8'))
  const plans = [], result = { applied: 0, already: 0, absent: 0 }
  for (const [path, locked] of Object.entries(lock.packages)) {
    if (!path.endsWith('/miniflare')) continue
    if (!path.startsWith('node_modules/') || path.split('/').includes('..')) throw new Error('Unsafe dependency patch path')
    let metadata
    try { metadata = JSON.parse(await readFile(resolve(projectRoot, path, 'package.json'), 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') { result.absent++; continue } throw error }
    const patch = manifest.packages.find(candidate => candidate.version === locked.version)
    if (!patch || metadata.version !== locked.version) throw new Error(`Unreviewed Miniflare version at ${path}; review or retire the upstream backport`)
    const target = await realpath(resolve(projectRoot, path, 'dist/src/index.js'))
    if (!target.startsWith(resolve(projectRoot, 'node_modules') + sep)) throw new Error('Dependency patch target escapes node_modules')
    const original = await readFile(target, 'utf8'), digest = hash(original)
    if (digest === patch.outputSha256) { result.already++; continue }
    if (digest !== patch.inputSha256) throw new Error(`Unexpected Miniflare bytes at ${path}; no patch was applied`)
    let changed = original
    for (const replacement of manifest.replacements) {
      if (changed.split(replacement.before).length !== 2) throw new Error('Miniflare patch seam differs from the reviewed upstream source')
      changed = changed.replace(replacement.before, replacement.after)
    }
    if (hash(changed) !== patch.outputSha256) throw new Error('Miniflare patch output differs from the reviewed digest')
    plans.push({ target, changed, mode: (await stat(target)).mode })
  }
  for (const plan of plans) {
    const temporary = `${plan.target}.generation-${process.pid}.tmp`
    await writeFile(temporary, plan.changed, { mode: plan.mode })
    await rename(temporary, plan.target)
    result.applied++
  }
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log('[miniflare] verified synchronous-generation backport', await applyMiniflareSyncGeneration()) }
  catch (error) { console.error('[miniflare] dependency backport refused:', error.message); process.exitCode = 1 }
}
