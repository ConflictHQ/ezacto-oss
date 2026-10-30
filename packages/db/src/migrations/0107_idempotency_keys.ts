/**
 * Idempotency keys (issue 952): a retried write is answered from the record of
 * the first one instead of running twice.
 *
 * A row is claimed by the first write a keyed request commits, in that write's
 * own batch or transaction (`idempotency.ts`), and completed with the response
 * once the request has finished. Nothing in the row is readable without the
 * client's key:
 *
 * - `id` is a domain-separated hash of the key, stable across secret rotation;
 * - `secret_version` identifies the secret used to bind and seal the answer;
 *   rotation prevents replay, but cannot make a committed write run again;
 * - `fingerprint` is an HMAC of what the request was (method, target, content
 *   type and body), which is how a key reused for a different request is told
 *   apart from a retry;
 * - `sealed` is the response, AES-GCM sealed under a key derived from the
 *   client's key, with `nonce` beside it. Both are null while the row is only
 *   claimed, and stay null on a completed row whose response was not kept (too
 *   large, or a server error after the write landed): its replay says the work
 *   was done and the client reloads.
 *
 * `holder` is an HMAC of the credentials the first attempt carried (bearer
 * token, session cookies). A stored response is handed only to a retry that
 * carries the same ones: a key alone -- read from a log, or guessed where a
 * client chose a guessable one -- must not be enough to read what a write
 * answered, a minted API token above all. A retry under other credentials is
 * told the work was done, never handed the answer and never run again.
 *
 * `attempt` names the execution that claimed the key. Every later write of that
 * same execution finds its own row and adds nothing; a write from any other
 * execution collides with the primary key and its whole batch rolls back.
 *
 * Rows live 24 hours (`expires_at`); writes purge expired ones as they go.
 */
export const idempotencyKeysMigration = [
  `CREATE TABLE idempotency_keys (
    id TEXT PRIMARY KEY CHECK (length(id) = 64),
    fingerprint TEXT NOT NULL CHECK (length(fingerprint) = 64),
    secret_version TEXT NOT NULL CHECK (length(secret_version) = 64),
    holder TEXT NOT NULL CHECK (length(holder) = 64),
    attempt TEXT NOT NULL CHECK (length(attempt) BETWEEN 1 AND 64),
    state TEXT NOT NULL CHECK (state IN ('claimed', 'done')),
    nonce TEXT,
    sealed TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL CHECK (expires_at > created_at),
    CHECK ((nonce IS NULL) = (sealed IS NULL)),
    CHECK (state = 'done' OR sealed IS NULL)
  ) STRICT`,
  `CREATE INDEX idempotency_keys_expires_at ON idempotency_keys(expires_at)`,
] as const
