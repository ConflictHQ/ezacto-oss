// Provenance: ezacto-oss #489; the operator asked to upload a logo.
//
// Why a table at all. The three brand marks have always been deployment
// configuration -- BRAND_WORDMARK_LIGHT, BRAND_WORDMARK_DARK and BRAND_FAVICON,
// each a URL read at render time -- so putting a logo on the product meant
// hosting the file somewhere public, setting a repository variable and
// redeploying. A self-hosted instance may have nowhere to host it at all. The
// bytes go to the object store the attachments already use; this table is the
// metadata half of that same split, and it is what makes "is a mark stored?"
// answerable without listing a bucket on every page render.
//
// The slot is the primary key. There is exactly one current mark per slot and
// replacing one is an upsert, so no row can be ambiguous about which mark is
// live. The rejected alternative was an id column with a `current` flag, which
// buys a history nobody asked for and a second way to be wrong.
//
// `content_type` is a closed set of raster types on purpose, and SVG is not in
// it. These bytes are served to an anonymous browser from the instance's own
// origin -- the sign-in page carries the mark before anyone has a session --
// and an SVG is script-capable, so accepting one would turn a settings form
// into stored cross-site scripting against every session on the origin. The
// route sniffs the magic bytes and stores what it saw rather than what the
// upload claimed; this CHECK is the second line, so a row written by any other
// path still cannot name a script-capable type.
//
// `byte_size` is capped here as well as in the route for the same reason. A
// wordmark is a few tens of kilobytes; the cap is generous at half a megabyte
// and exists so that the object an anonymous request can pull is bounded by
// the schema and not only by the code path that happened to write it.

const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
  AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})
  AND CAST(substr(${column}, 12, 2) AS INTEGER) BETWEEN 0 AND 23
  AND CAST(substr(${column}, 15, 2) AS INTEGER) BETWEEN 0 AND 59
  AND CAST(substr(${column}, 18, 2) AS INTEGER) BETWEEN 0 AND 59
  AND (
    ${column} GLOB '????-??-??T??:??:??Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9]Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9]Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
  )`

/** Half a megabyte. Restated as a literal in the CHECK so the DDL reads whole. */
export const MAX_BRAND_ASSET_BYTES = 512 * 1024

export const brandAssetsMigration = [
  `CREATE TABLE brand_assets (
    slot TEXT PRIMARY KEY
      CHECK (slot IN ('wordmark_light', 'wordmark_dark', 'favicon')),
    content_hash TEXT NOT NULL
      CHECK (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*'),
    file_key TEXT NOT NULL CHECK (length(file_key) BETWEEN 1 AND 512),
    content_type TEXT NOT NULL
      CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
    byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 524288),
    uploaded_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (${canonicalTimestamp('created_at')}),
    CHECK (${canonicalTimestamp('updated_at')})
  ) STRICT`,
] as const
