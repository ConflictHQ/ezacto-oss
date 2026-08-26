// raw/<resource>.jsonl — one Harvest object per line, verbatim (migration-spec
// §2.3). No field is added, removed, reordered or reinterpreted at extract time:
// a transform bug has to be fixable by re-running `load`, because extract is the
// expensive rate-limited step and the transform is free.

import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const rawPath = (dir: string, resource: string): string => join(dir, 'raw', `${resource}.jsonl`)

/**
 * Empties (and creates) a resource's file at the start of its step, so a re-run
 * replaces rows rather than appending a second copy of the account. Also what
 * guarantees a file exists for a resource that turns out to have no rows at all —
 * "zero rows" and "never swept" must not look the same on disk.
 */
export const startResource = async (dir: string, resource: string): Promise<void> => {
  await mkdir(join(dir, 'raw'), { recursive: true })
  const handle = await open(rawPath(dir, resource), 'w')
  await handle.close()
}

/**
 * Appends one page and fsyncs it (§2.4). The sync is per page, not per object:
 * a page is the unit a resumed run re-fetches, so it is the unit that has to be
 * on the platter before the manifest claims it.
 */
export const appendPage = async (
  dir: string,
  resource: string,
  objects: unknown[],
): Promise<void> => {
  await mkdir(join(dir, 'raw'), { recursive: true })
  const handle = await open(rawPath(dir, resource), 'a')
  try {
    if (objects.length > 0) {
      await handle.writeFile(objects.map((o) => `${JSON.stringify(o)}\n`).join(''), 'utf8')
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Streams the ids out of an already-extracted resource.
 *
 * Child steps fan out over this rather than over an array captured while the
 * parent was being swept: it bounds memory against an account with 50k invoices,
 * and it is the shape a resumed run needs, where the process that swept the
 * parents exited long ago and never held their ids at all.
 */
export async function* readIds(dir: string, resource: string): AsyncGenerator<number> {
  const path = rawPath(dir, resource)
  let handle
  try {
    handle = await open(path, 'r')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `${path} does not exist — a child step asked for ${resource} ids before ${resource} was ` +
          'extracted. That is an ordering bug in the resource registry, not a user error.',
      )
    }
    throw err
  }
  const lines = createInterface({ input: handle.createReadStream(), crlfDelay: Infinity })
  try {
    let lineNo = 0
    for await (const line of lines) {
      lineNo += 1
      if (line.trim() === '') continue
      const id = (JSON.parse(line) as { id?: unknown }).id
      if (typeof id !== 'number') {
        throw new Error(
          `${path} line ${lineNo} has no numeric "id" — cannot fan out over ${resource}`,
        )
      }
      yield id
    }
  } finally {
    lines.close()
    await handle.close()
  }
}
