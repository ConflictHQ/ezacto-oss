import type { Hono } from 'hono'
import { captureRequestActivity, type ActivityRecorder } from './activity-log.js'
import { requireSessionPrincipal } from './auth.js'
import type { ApiContext } from './context.js'
import { ApiError, readJsonBody, validationError, type FieldError } from './errors.js'

/**
 * Issue 39, operator export: a signed, single-use, expiring link to a
 * completed backup run, as one ZIP.
 *
 * The file is a copy of the database, credential hashes and authenticator
 * seeds included, so the link is handled as the bearer secret it is:
 *
 * - it is minted only by an administrator's own session -- never an API token,
 *   whose reach is exactly what a leaked one must not widen -- and, where that
 *   administrator has an authenticator enrolled, only with a fresh code;
 * - redeeming it needs nothing but the link (that is the point: `curl` on
 *   another machine), so every refusal is one plain 404 -- never minted,
 *   malformed, expired, spent, run gone, bundle damaged -- and nothing here
 *   says which. A caller over its per-minute allowance gets 429 before the
 *   token is looked at, so guessing costs the guesser and not the database;
 * - the token is never logged, echoed or recorded: the activity log names the
 *   link by id, and the responses say `no-store` and `no-referrer`.
 *
 * Both ends are recorded as `backup.exported`: the mint against the
 * administrator who asked, the download against the link, naming who minted it.
 */

export interface BackupDownloadSecondFactor {
  isEnrolled(userId: number): Promise<boolean>
  verifyCode(
    userId: number,
    code: string,
  ): Promise<'accepted' | 'rejected' | 'not_enrolled' | 'locked'>
}

/** What the routes need of the store and the bundle; the entry builds it. */
export interface BackupDownloadService {
  /** The origin links point at, from configuration and never a request; null leaves a path. */
  readonly origin: string | null
  allow(scope: 'mint' | 'redeem', key: string, now: string): Promise<boolean>
  latestCompletedRunId(): Promise<number | null>
  /** Null when the run does not exist or did not complete. */
  mint(input: {
    backupRunId: number
    userId: number
    now: string
  }): Promise<{ id: number; token: string; backupRunId: number; expiresAt: string } | null>
  /** Spends the link; null for anything that is not a live, unspent one. */
  redeem(
    token: string,
    now: string,
  ): Promise<{ id: number; backupRunId: number; createdByUserId: number } | null>
  /** The bundle as one stream; throws when it cannot be served intact. */
  openArchive(backupRunId: number): Promise<{ stream: ReadableStream<Uint8Array>; filename: string }>
  secondFactor?: BackupDownloadSecondFactor
}

export interface BackupDownloadOptions {
  readonly service: BackupDownloadService
  readonly activity: ActivityRecorder
  readonly clock: () => string
}

export interface BackupDownloadRedeemOptions {
  readonly service: BackupDownloadService
  readonly activity: ActivityRecorder
  readonly clock: () => string
  /** Who is asking, for the allowance; never stored as given. */
  readonly clientKey: (request: Request) => string
}

/** The path a link is redeemed at. Only the token is in it. */
export const BACKUP_DOWNLOAD_PATH = '/backup-download'

const privateHeaders = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-robots-tag': 'noindex, nofollow, noarchive',
} as const

const plain = (status: number, body: string, extra: Record<string, string> = {}): Response =>
  new Response(body, {
    status,
    headers: { ...privateHeaders, 'content-type': 'text/plain; charset=utf-8', ...extra },
  })

const notFound = (): Response => plain(404, 'Not found')

export const installBackupDownloadMintRoute = <Bindings extends object>(
  api: Hono<ApiContext<Bindings>>,
  options: BackupDownloadOptions,
): void => {
  const { service } = options
  api.post('/backup/download-links', async (context) => {
    const principal = requireSessionPrincipal(context)
    if (principal.profile !== 'administrator') {
      throw new ApiError({
        status: 403,
        code: 'profile_forbidden',
        message: 'Only administrators can create a backup download link.',
      })
    }
    // Counted before the body is read or a code is checked, so guessing codes
    // through this route is bounded here as well as by the factor's own lock.
    const now = options.clock()
    if (!(await service.allow('mint', String(principal.userId), now))) {
      throw new ApiError({
        status: 429,
        code: 'rate_limit_exceeded',
        message: 'Too many download links requested. Try again in a minute.',
      })
    }
    const body = await readJsonBody<unknown>(context, { maxBytes: 4 * 1024 })
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw validationError([
        { field: 'body', code: 'invalid', message: 'request body must be a JSON object' },
      ])
    }
    const input = body as Record<string, unknown>
    const fields: FieldError[] = Object.keys(input)
      .filter((field) => field !== 'run_id' && field !== 'code')
      .map((field) => ({ field, code: 'unknown', message: `${field} is not accepted` }))
    if (
      input.run_id !== undefined &&
      !(typeof input.run_id === 'number' && Number.isSafeInteger(input.run_id) && input.run_id >= 1)
    ) {
      fields.push({
        field: 'run_id',
        code: 'invalid',
        message: 'run_id must be a positive integer',
      })
    }
    // Length only: which shapes are codes is the factor's business.
    if (
      input.code !== undefined &&
      !(typeof input.code === 'string' && input.code.length >= 1 && input.code.length <= 64)
    ) {
      fields.push({
        field: 'code',
        code: 'invalid',
        message: 'code must contain between 1 and 64 characters',
      })
    }
    if (fields.length > 0) throw validationError(fields)

    if (
      service.secondFactor !== undefined &&
      (await service.secondFactor.isEnrolled(principal.userId))
    ) {
      if (typeof input.code !== 'string') {
        throw new ApiError({
          status: 401,
          code: 'two_factor_code_required',
          message: 'Enter a current verification code to create a backup download link.',
        })
      }
      const verdict = await service.secondFactor.verifyCode(principal.userId, input.code)
      if (verdict === 'locked') {
        throw new ApiError({
          status: 429,
          code: 'two_factor_locked',
          message: 'Too many incorrect verification codes. Try again later.',
        })
      }
      if (verdict !== 'accepted') {
        throw new ApiError({
          status: 401,
          code: 'invalid_two_factor_code',
          message: 'The verification code is invalid.',
        })
      }
    }

    const runId =
      typeof input.run_id === 'number' ? input.run_id : await service.latestCompletedRunId()
    const link =
      runId === null ? null : await service.mint({ backupRunId: runId, userId: principal.userId, now })
    if (link === null) {
      throw new ApiError({
        status: 404,
        code: 'backup_run_not_found',
        message: 'There is no completed backup to download.',
      })
    }
    await captureRequestActivity(context, options.activity, {
      eventType: 'backup.exported',
      subjectId: link.backupRunId,
      occurredAt: now,
      detail: { phase: 'link_minted', link_id: link.id },
    })
    const path = `${BACKUP_DOWNLOAD_PATH}/${link.token}`
    return context.json(
      {
        data: {
          id: link.id,
          run_id: link.backupRunId,
          url: service.origin === null ? path : `${service.origin.replace(/\/+$/u, '')}${path}`,
          expires_at: link.expiresAt,
        },
      },
      201,
      { 'cache-control': 'no-store' },
    )
  })
}

export const installBackupDownloadRedeemRoute = <Bindings extends object>(
  app: Hono<ApiContext<Bindings>>,
  options: BackupDownloadRedeemOptions,
): void => {
  const { service } = options
  app.get(`${BACKUP_DOWNLOAD_PATH}/:token`, async (context) => {
    const now = options.clock()
    if (!(await service.allow('redeem', options.clientKey(context.req.raw), now))) {
      return plain(429, 'Too many requests', { 'retry-after': '60' })
    }
    const link = await service.redeem(context.req.param('token') ?? '', now)
    if (link === null) return notFound()
    // The bundle is opened, and its manifest checked, before the log says it
    // left and before a byte is sent.
    let archive: Awaited<ReturnType<BackupDownloadService['openArchive']>>
    try {
      archive = await service.openArchive(link.backupRunId)
    } catch {
      return notFound()
    }
    await options.activity.capture({
      eventType: 'backup.exported',
      subjectId: link.backupRunId,
      // No session stands behind the download: the link is the authority, and
      // the person who minted it is named in the detail.
      actor: { type: 'system' },
      occurredAt: now,
      captureId: `backup-download-${String(link.id)}`,
      detail: { phase: 'downloaded', link_id: link.id, minted_by: link.createdByUserId },
    })
    return new Response(archive.stream, {
      status: 200,
      headers: {
        ...privateHeaders,
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${archive.filename}"`,
      },
    })
  })
}
