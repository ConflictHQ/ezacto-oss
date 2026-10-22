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

// Portable source contract and R2 implementation: no local filesystem imports.

export interface SnapshotSource {
  /**
   * The lines of one resource's JSONL, starting at `byteOffset`.
   *
   * The offset is a byte position rather than a row count because that is what
   * the loader checkpoints, and re-counting rows to reach a resume point would
   * be O(n) on every restart of a 296,282-row load.
   */
  openRaw(resource: string, byteOffset: number): AsyncIterable<string>
  /**
   * The byte length of one resource's JSONL. The loader compares it with the
   * end of the last indexed row, so it must be the object's own size and not a
   * count of anything read.
   */
  size(resource: string): Promise<number>
  /**
   * A value that changes whenever the object's bytes are replaced or rewritten:
   * the entity tag for R2, size and modification time for a file. A load that
   * claims a lease records these and refuses a source that no longer matches,
   * so an upload landing mid-load cannot be read as if it were the snapshot.
   */
  fingerprint(resource: string): Promise<string>
  /** Named for error messages, so a failure says which snapshot it was reading. */
  describe(resource: string): string
}

/** The half of R2's API this needs, so a test can supply one without a bucket. */
export interface SnapshotBucket {
  get(
    key: string,
    options?: { range?: { offset: number } },
  ): Promise<{ body: ReadableStream<Uint8Array> } | null>
  head(key: string): Promise<{ size: number; etag: string } | null>
}

/**
 * Splits a byte stream into lines without buffering the whole object.
 *
 * A snapshot is hundreds of megabytes and a Worker has a memory ceiling, so the
 * one thing this must not do is read it all to call `.split('\n')`.
 *
 * Multi-byte characters are decoded with a streaming decoder rather than per
 * chunk: a chunk boundary can fall inside a UTF-8 sequence, and decoding each
 * chunk alone turns the name it split into a replacement character. The row
 * would still parse, which is what makes it worth being careful about — the
 * corruption would reach the database looking like data.
 */
export const linesFromStream = async function* (
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let carry = ''
  let completed = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        completed = true
        break
      }
      carry += decoder.decode(value, { stream: true })
      let newline = carry.indexOf('\n')
      while (newline !== -1) {
        yield carry.slice(0, newline)
        carry = carry.slice(newline + 1)
        newline = carry.indexOf('\n')
      }
    }
    carry += decoder.decode()
    // A final line with no trailing newline is still a row. Dropping it would
    // lose the last record of every snapshot whose writer omitted one.
    if (carry !== '') yield carry
  } finally {
    try {
      if (!completed) await reader.cancel()
    } finally {
      reader.releaseLock()
    }
  }
}

export const r2SnapshotSource = (bucket: SnapshotBucket, prefix: string): SnapshotSource => {
  const key = (resource: string): string => `${prefix.replace(/\/+$/u, '')}/raw/${resource}.jsonl`
  return {
    openRaw: async function* (resource, byteOffset) {
      const object = await bucket.get(
        key(resource),
        byteOffset === 0 ? undefined : { range: { offset: byteOffset } },
      )
      // Absent rather than empty. A load that treated a missing snapshot as
      // zero rows would report success having imported nothing.
      if (object === null) throw new Error(`${key(resource)} is not in the snapshot bucket`)
      yield* linesFromStream(object.body)
    },
    size: async (resource) => {
      const object = await bucket.head(key(resource))
      if (object === null) throw new Error(`${key(resource)} is not in the snapshot bucket`)
      return object.size
    },
    fingerprint: async (resource) => {
      const object = await bucket.head(key(resource))
      if (object === null) throw new Error(`${key(resource)} is not in the snapshot bucket`)
      return `${object.size}:${object.etag}`
    },
    describe: key,
  }
}
