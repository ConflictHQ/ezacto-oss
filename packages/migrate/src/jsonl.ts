// raw/<resource>.jsonl — one Harvest object per line, verbatim (migration-spec
// §2.3). No field is added, removed, reordered or reinterpreted at extract time:
// a transform bug has to be fixable by re-running `load`, because extract is the
// expensive rate-limited step and the transform is free.
//
// Nothing here reads a whole file into memory. raw/time_entries.jsonl for a
// multi-year agency account runs to hundreds of megabytes — past Node's maximum
// string length (536,870,888 chars) well before it is past the disk — and every
// function below is on the resume path, i.e. the path that only runs after a long
// extract has already been interrupted once.

import { mkdir, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const rawPath = (dir: string, resource: string): string => join(dir, 'raw', `${resource}.jsonl`)

/**
 * Where an `updated_since` pass parks its rows until it finishes: they are
 * *fresher copies* of rows raw/<resource>.jsonl already holds, so appending them
 * straight onto it would leave the snapshot with two of each (see mergeIncremental).
 */
const stagePath = (dir: string, resource: string): string => `${rawPath(dir, resource)}.incoming`

const pathFor = (dir: string, resource: string, staged: boolean): string =>
  staged ? stagePath(dir, resource) : rawPath(dir, resource)

/** 64 KiB: the read/write unit for the streaming passes below. */
const CHUNK = 1 << 16
const NEWLINE = 0x0a

/**
 * Empties (and creates) a resource's file at the start of its step, so a re-run
 * replaces rows rather than appending a second copy of the account. Also what
 * guarantees a file exists for a resource that turns out to have no rows at all —
 * "zero rows" and "never swept" must not look the same on disk.
 *
 * `staged` empties the incremental pass's staging file instead; starting the
 * resource itself also discards any staging file left behind by an incremental
 * pass that was abandoned rather than merged, whose rows a full sweep replaces.
 */
export const startResource = async (
  dir: string,
  resource: string,
  staged = false,
): Promise<void> => {
  await mkdir(join(dir, 'raw'), { recursive: true })
  const handle = await open(pathFor(dir, resource, staged), 'w')
  await handle.close()
  if (!staged) await rm(stagePath(dir, resource), { force: true })
}

/**
 * Appends one page and fsyncs it (§2.4). `lines` are the records' own wire bytes
 * (raw-slices.ts) — this writer never serialises, so nothing it touches can
 * change a number literal or an id. The sync is per page, not per object:
 * a page is the unit a resumed run re-fetches, so it is the unit that has to be
 * on the platter before the manifest claims it.
 */
export const appendPage = async (
  dir: string,
  resource: string,
  lines: string[],
  staged = false,
): Promise<void> => {
  await mkdir(join(dir, 'raw'), { recursive: true })
  const handle = await open(pathFor(dir, resource, staged), 'a')
  try {
    if (lines.length > 0) {
      await handle.writeFile(lines.map((l) => `${l}\n`).join(''), 'utf8')
    }
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/**
 * Reconciles raw/<resource>.jsonl with the manifest's own count after a crash.
 * `appendPage` fsyncs a page's bytes to disk *before* the manifest is rewritten
 * to claim it (§2.4) — the ordering that guarantees a crash never over-claims —
 * but it does leave one window where the file can be a page ahead of the
 * manifest: killed after the fsync, before the rename that commits manifest.json.
 * A resume that trusted the file's own length there, and asked `next_url` for
 * the page after the one already on disk, would silently duplicate it.
 *
 * So resume always calls this first: read what is actually on disk, and if it
 * holds more complete lines than the manifest counted, throw the extra away —
 * they get re-fetched from the still-valid cursor rather than trusted twice. A
 * line with no trailing `\n` is a write that was mid-flight when the crash hit;
 * it is never "complete" regardless of what `count` says.
 *
 * Counted by scanning for newline bytes and cut with a truncate, never by
 * reading the file in: the resource most likely to be interrupted is also the
 * one whose file is too big to be a JS string at all.
 */
export const reconcileToCount = async (
  dir: string,
  resource: string,
  count: number,
): Promise<void> => {
  const path = rawPath(dir, resource)
  const handle = await open(path, 'r+')
  try {
    const chunk = Buffer.allocUnsafe(CHUNK)
    let bytes = 0
    let lines = 0
    // Bytes up to and including the newline that ends the `count`-th line: the
    // length a file holding exactly what the manifest claims would have. Zero
    // when the manifest claims nothing, which truncates the file to empty.
    let keep = 0
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, CHUNK, bytes)
      if (bytesRead === 0) break
      for (let i = 0; i < bytesRead; i += 1) {
        if (chunk[i] !== NEWLINE) continue
        lines += 1
        if (lines === count) keep = bytes + i + 1
      }
      bytes += bytesRead
    }
    if (lines < count) {
      throw new Error(
        `${path} holds ${lines} committed line(s) but manifest.json claims ${count} — ` +
          'the file is missing rows fsync should have made durable. This snapshot cannot be ' +
          'resumed safely; re-run extract without --snapshot-dir pointed at it, or restore the ' +
          'file from backup before resuming.',
      )
    }
    // Anything past `keep` is either a page the manifest never claimed or a torn
    // trailing line — bytes fsync never promised were part of a whole row.
    if (bytes !== keep) {
      await handle.truncate(keep)
      await handle.sync()
    }
  } finally {
    await handle.close()
  }
}

/**
 * The same reconciliation the other way round, for the incremental path: returns
 * what raw/<resource>.jsonl actually holds so the manifest can be corrected to it.
 *
 * `mergeIncremental` commits the merged file with a rename below, and the record
 * only claims its length at the manifest write that follows — the same
 * one-manifest-write window `appendPage`/`reconcileToCount` close a level down.
 * A crash inside it leaves the file holding merged rows `count` does not claim,
 * and the pass that gets re-run cannot correct it whenever it stages nothing
 * (nothing to merge, so no merged length to report). Cutting the file back to
 * `count` would be wrong here: unlike a full sweep's unclaimed page, which has a
 * live cursor to re-fetch it from, these rows are merged, fsynced and gone from
 * upstream's changed set — the manifest is the side that is behind.
 *
 * Refuses, as reconcileToCount does, when the file holds *fewer* committed lines
 * than the manifest claims. No path here removes a row, so that is rows lost
 * after an fsync promised them, and adopting the smaller number would leave the
 * snapshot agreeing with itself about an account it no longer holds.
 *
 * Counted by scanning for newline bytes, never by reading the file in: same
 * reason as above — the resource most likely to be interrupted is also the one
 * whose file is too big to be a JS string.
 */
export const reconcileToFile = async (
  dir: string,
  resource: string,
  claimed: number,
): Promise<number> => {
  const path = rawPath(dir, resource)
  const handle = await open(path, 'r')
  try {
    const chunk = Buffer.allocUnsafe(CHUNK)
    let bytes = 0
    let lines = 0
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, CHUNK, bytes)
      if (bytesRead === 0) break
      for (let i = 0; i < bytesRead; i += 1) {
        if (chunk[i] === NEWLINE) lines += 1
      }
      bytes += bytesRead
    }
    if (lines < claimed) {
      throw new Error(
        `${path} holds ${lines} committed line(s) but manifest.json claims ${claimed} — ` +
          'the file is missing rows fsync should have made durable. This snapshot cannot be ' +
          'resumed safely; re-run extract without --snapshot-dir pointed at it, or restore the ' +
          'file from backup before resuming.',
      )
    }
    return lines
  } finally {
    await handle.close()
  }
}

/**
 * Streams one jsonl file as {line, id} pairs, skipping blank lines. `whyId` says
 * what the id was needed for, so a row without one names the caller it broke.
 */
async function* jsonlRows(path: string, whyId = ''): AsyncGenerator<{ line: string; id: number }> {
  const handle = await open(path, 'r')
  const lines = createInterface({ input: handle.createReadStream(), crlfDelay: Infinity })
  try {
    let lineNo = 0
    for await (const line of lines) {
      lineNo += 1
      if (line.trim() === '') continue
      const id = (JSON.parse(line) as { id?: unknown }).id
      if (typeof id !== 'number') {
        throw new Error(`${path} line ${lineNo} has no numeric "id"${whyId}`)
      }
      yield { line, id }
    }
  } finally {
    lines.close()
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
  try {
    for await (const { id } of jsonlRows(path, ` — cannot fan out over ${resource}`)) yield id
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `${path} does not exist — a child step asked for ${resource} ids before ${resource} was ` +
          'extracted. That is an ordering bug in the resource registry, not a user error.',
      )
    }
    throw err
  }
}

/**
 * Folds a finished `updated_since` pass's staged rows into raw/<resource>.jsonl,
 * replacing the copy of each row it superseded. Returns the merged file's line
 * count, or null when the pass staged nothing and the file is untouched.
 *
 * An incremental pass re-fetches rows the snapshot already holds — that is what
 * `updated_since` returns. Appending them leaves two lines per changed row: a
 * `count` that overstates the account, a duplicate id for any child step that
 * fans out over this resource (a second request per changed parent and a second
 * copy of its children), and a snapshot that disagrees with the database `load`
 * upserts it into by harvest_id, leaving `verify` (§6) a delta nothing explains.
 *
 * Each row keeps its position: a changed row is replaced where it already sat,
 * and only rows this account did not have before are appended. Order is part of
 * what a resumed child fan-out reads back — it skips forward through
 * raw/<parent>.jsonl to the parent it stopped inside — so a merge that moved
 * changed parents to the end would make the fan-out skip past every parent that
 * had moved behind it.
 *
 * Streamed, and committed by an fsync+rename that leaves the file either wholly
 * merged or wholly untouched. Memory holds the pass's own rows and nothing else:
 * the set of rows changed since the watermark, which this run just fetched over
 * the network a page at a time. The staging file survives a crash mid-merge, so
 * re-running the pass and merging again lands on the same file.
 */
export const mergeIncremental = async (dir: string, resource: string): Promise<number | null> => {
  const main = rawPath(dir, resource)
  const stage = stagePath(dir, resource)

  // Insertion-ordered, and drained as the rows are placed: what is left at the
  // end is the rows this account did not have before, in the order they arrived.
  const fresher = new Map<number, string>()
  try {
    for await (const { line, id } of jsonlRows(stage, ` — cannot merge the ${resource} pass`)) {
      fresher.set(id, line)
    }
  } catch (err) {
    // No staging file at all: an incremental pass that never wrote a page.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  if (fresher.size === 0) {
    await rm(stage, { force: true })
    return null
  }

  const merged = `${main}.merged`
  const handle = await open(merged, 'w')
  let kept = 0
  try {
    let pending = ''
    const write = async (line: string, force = false): Promise<void> => {
      pending += line
      if (pending.length === 0 || (!force && pending.length < CHUNK)) return
      await handle.writeFile(pending, 'utf8')
      pending = ''
    }
    for await (const { line, id } of jsonlRows(main, ` — cannot merge the ${resource} pass`)) {
      const replacement = fresher.get(id)
      if (replacement !== undefined) fresher.delete(id)
      await write(`${replacement ?? line}\n`)
      kept += 1
    }
    for (const line of fresher.values()) {
      await write(`${line}\n`)
      kept += 1
    }
    await write('', true)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(merged, main)
  await rm(stage, { force: true })
  return kept
}
