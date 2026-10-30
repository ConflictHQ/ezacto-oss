import { GithubReaderCommandError, githubAppJwt } from '@ezacto/integrations'
import { atomicStatements } from './atomic-statements.js'
import { NativeGithubReaderAdmin, type GithubReaderAuthority } from './github-reader-admin.js'
import type { GithubAppCredentials } from './github-reader-service.js'
import type { InvoiceStateDatabase } from './invoice-state.js'
const encoder = new TextEncoder()
const base64 = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
const decode = (text: string) =>
  Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0))
const hash = async (text: string) =>
  base64(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))))
const fail = (kind: 'invalid' | 'unavailable' | 'conflict' = 'invalid'): never => {
  throw new GithubReaderCommandError(kind)
}
export interface GithubAppSetupOptions {
  key: string | undefined
  origin: string
  now(): Date
  fetch(request: Request): Promise<Response>
}
export const githubAppSetupSchema = [
  `CREATE TABLE github_app_setup_requests (state_hash TEXT PRIMARY KEY, actor_user_id INTEGER NOT NULL REFERENCES users(id), session_id INTEGER NOT NULL REFERENCES sessions(id), expires_at TEXT NOT NULL, claimed_at TEXT) STRICT`,
  `CREATE TABLE github_app_credentials (id INTEGER PRIMARY KEY CHECK(id=1), app_id TEXT NOT NULL, slug TEXT NOT NULL, sealed TEXT NOT NULL, actor_user_id INTEGER NOT NULL REFERENCES users(id), session_id INTEGER NOT NULL REFERENCES sessions(id), created_at TEXT NOT NULL) STRICT`,
  `CREATE TRIGGER github_app_setup_authority BEFORE INSERT ON github_app_credentials BEGIN
   SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=NEW.actor_user_id AND u.is_active=1 AND u.profile='administrator' AND s.id=NEW.session_id AND s.profile_snapshot='administrator' AND s.revoked_at IS NULL AND julianday(s.idle_expires_at)>julianday(NEW.created_at) AND julianday(s.absolute_expires_at)>julianday(NEW.created_at) AND NOT EXISTS(SELECT 1 FROM account_closures c WHERE c.user_id=u.id)) THEN RAISE(ABORT,'github_setup_forbidden') END;
   END`,
] as const
export const createGithubAppSetup = (
  database: InvoiceStateDatabase,
  options: GithubAppSetupOptions,
) => {
  const admin = new NativeGithubReaderAdmin(database)
  const rows = async (text: string, ...params: unknown[]) =>
    (await atomicStatements(database, [{ text, params }]))[0] ?? []
  const key = async () => {
    if (!options.key || !/^[A-Za-z0-9_-]{43}$/.test(options.key)) return fail('unavailable')
    const bytes = decode(options.key)
    if (bytes.length !== 32 || base64(bytes) !== options.key) return fail('unavailable')
    return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt'])
  }
  const context = (appId: string) =>
    encoder.encode(`ezacto-github-app-v1:${new URL(options.origin).origin}:${appId}`)
  const credentials = async (): Promise<GithubAppCredentials | null> => {
    const row = (await rows('SELECT app_id,sealed FROM github_app_credentials WHERE id=1'))[0]
    if (!row) return null
    try {
      const sealed = JSON.parse(String(row.sealed)) as { iv: string; ciphertext: string }
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: decode(sealed.iv), additionalData: context(String(row.app_id)) },
        await key(),
        decode(sealed.ciphertext),
      )
      return {
        appId: String(row.app_id),
        ...(JSON.parse(new TextDecoder().decode(plain)) as {
          privateKey: string
          webhookSecret: string
        }),
      }
    } catch {
      return fail('unavailable')
    }
  }
  return {
    credentials,
    async info() {
      const row = (await rows('SELECT app_id,slug FROM github_app_credentials WHERE id=1'))[0]
      return row
        ? {
            id: String(row.app_id),
            slug: String(row.slug),
            installation_url: `https://github.com/apps/${String(row.slug)}/installations/new`,
          }
        : null
    },
    async supported() {
      try {
        await key()
        return true
      } catch {
        return false
      }
    },
    async begin(authority: GithubReaderAuthority, organization?: string) {
      await admin.status(authority, options.now().toISOString())
      await key()
      if ((await rows('SELECT id FROM github_app_credentials WHERE id=1')).length)
        return fail('conflict')
      if (
        organization !== undefined &&
        !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(organization)
      )
        return fail()
      const state = base64(crypto.getRandomValues(new Uint8Array(32)))
      const origin = new URL(options.origin).origin
      const now = options.now()
      await rows(
        'DELETE FROM github_app_setup_requests WHERE expires_at<=? OR actor_user_id=? RETURNING state_hash',
        now.toISOString(),
        authority.userId,
      )
      await rows(
        'INSERT INTO github_app_setup_requests(state_hash,actor_user_id,session_id,expires_at) VALUES(?,?,?,?) RETURNING state_hash',
        await hash(state),
        authority.userId,
        authority.sessionId,
        new Date(now.getTime() + 3600000).toISOString(),
      )
      return {
        registration_url: `https://github.com/${organization ? `organizations/${organization}/settings/apps/new` : 'settings/apps/new'}?state=${encodeURIComponent(state)}`,
        manifest: JSON.stringify({
          name: `eZacto reader ${new URL(origin).hostname.replace(/[^a-zA-Z0-9-]/g, '-').slice(-20)}`,
          url: origin,
          public: false,
          hook_attributes: { url: `${origin}/webhooks/github-work-items`, active: true },
          redirect_url: `${origin}/api/v1/work-items/github/setup/callback`,
          default_permissions: { issues: 'read', metadata: 'read' },
          default_events: ['issues', 'repository'],
        }),
      }
    },
    async complete(authority: GithubReaderAuthority, state: string, code: string) {
      await admin.status(authority, options.now().toISOString())
      const encryptionKey = await key()
      if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[A-Za-z0-9_-]{1,200}$/.test(code)) return fail()
      const claimed = await rows(
        'UPDATE github_app_setup_requests SET claimed_at=? WHERE state_hash=? AND actor_user_id=? AND session_id=? AND claimed_at IS NULL AND expires_at>? RETURNING state_hash',
        options.now().toISOString(),
        await hash(state),
        authority.userId,
        authority.sessionId,
        options.now().toISOString(),
      )
      if (claimed.length !== 1) return fail('conflict')
      let value: Record<string, unknown>
      try {
        const response = await options.fetch(
          new Request(`https://api.github.com/app-manifests/${code}/conversions`, {
            method: 'POST',
            redirect: 'manual',
            headers: {
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2026-03-10',
              'User-Agent': 'ezacto-github-reader',
            },
            signal: AbortSignal.timeout(10000),
          }),
        )
        if (!response.ok) {
          await response.body?.cancel()
          return fail('unavailable')
        }
        const reader = response.body?.getReader()
        if (!reader) return fail('unavailable')
        const chunks: Uint8Array[] = []
        let length = 0
        for (;;) {
          const item = await reader.read()
          if (item.done) break
          length += item.value.length
          if (length > 65536) {
            await reader.cancel()
            return fail('unavailable')
          }
          chunks.push(item.value)
        }
        const bytes = new Uint8Array(length)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.length
        }
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Record<
          string,
          unknown
        >
      } catch {
        return fail('unavailable')
      }
      if (
        !Number.isSafeInteger(value.id) ||
        Number(value.id) < 1 ||
        typeof value.slug !== 'string' ||
        !/^[a-z0-9-]{1,100}$/.test(value.slug) ||
        typeof value.pem !== 'string' ||
        value.pem.length > 32768 ||
        !/^-----BEGIN (?:RSA )?PRIVATE KEY-----\n/.test(value.pem) ||
        typeof value.webhook_secret !== 'string' ||
        value.webhook_secret.length < 16 ||
        value.webhook_secret.length > 4096
      )
        return fail('unavailable')
      try {
        await githubAppJwt(String(value.id), value.pem, options.now().getTime())
      } catch {
        return fail('unavailable')
      }
      await admin.status(authority, options.now().toISOString())
      const appId = String(value.id),
        iv = crypto.getRandomValues(new Uint8Array(12))
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: context(appId) },
        encryptionKey,
        encoder.encode(
          JSON.stringify({ privateKey: value.pem, webhookSecret: value.webhook_secret }),
        ),
      )
      try {
        await rows(
          'INSERT INTO github_app_credentials(id,app_id,slug,sealed,actor_user_id,session_id,created_at) VALUES(1,?,?,?,?,?,?) RETURNING id',
          appId,
          value.slug,
          JSON.stringify({ iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) }),
          authority.userId,
          authority.sessionId,
          options.now().toISOString(),
        )
      } catch {
        return fail('conflict')
      }
    },
  }
}
