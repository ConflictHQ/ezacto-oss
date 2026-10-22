/**
 * Where a load reads its snapshot from (issue 409).
 *
 * `ez-migrate load` reads `<dir>/raw/<resource>.jsonl` off the operator's own
 * disk, which means a load lives and dies with the machine that started it. The
 * M5 shape wants it driven from the platform instead, consuming the snapshot
 * from R2 — so the first thing needed is for "where the rows come from" to stop
 * being a path.
 *
 * The port is deliberately narrow: lines of one resource, from a byte offset.
 * That is exactly what the loader's resumption already asks for, because
 * `_ezacto_load_progress` checkpoints a byte offset and a row index. Anything
 * wider would be inventing a shape for a consumer that does not exist yet.
 *
 * Every raw read the loader makes, rows and lineage alike, and the sizing and
 * fingerprinting of those files, goes through this port. A lineage file is the
 * resource named `<resource>.lineage`. The child index is no longer on local
 * disk by necessity: it is built through a `ChildIndexStore`, and ownership of
 * the target database is a lease row (`load-lease.ts`), not a file. What the
 * Node facade reads metadata from the snapshot directory. The portable engine
 * receives pinned metadata bytes and a binary-artifact port, so a queue consumer
 * can keep every input in R2.
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import type { SnapshotSource } from './r2-snapshot-source.js'
export * from './r2-snapshot-source.js'

export const fileSnapshotSource = (snapshotDir: string): SnapshotSource => ({
  openRaw: (resource, byteOffset) =>
    createInterface({
      input: createReadStream(
        join(snapshotDir, 'raw', `${resource}.jsonl`),
        byteOffset === 0 ? undefined : { start: byteOffset },
      ),
      crlfDelay: Infinity,
    }),
  size: async (resource) => (await stat(join(snapshotDir, 'raw', `${resource}.jsonl`))).size,
  fingerprint: async (resource) => {
    const found = await stat(join(snapshotDir, 'raw', `${resource}.jsonl`))
    return `${found.size}:${found.mtimeMs}`
  },
  describe: (resource) => join(snapshotDir, 'raw', `${resource}.jsonl`),
})
