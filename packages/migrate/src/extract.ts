// `ezacto-migrate extract` — Harvest account → snapshot dir (migration-spec §2).
//
// Walks RESOURCES in FK-safe order, appends every page to raw/<resource>.jsonl
// verbatim, and rewrites manifest.json after each page. The ordering there is
// load-bearing and never the other way round: rows hit the disk before the
// manifest claims them, so a crash under-claims (worst case: one page re-fetched)
// instead of over-claiming (worst case: a snapshot that lies about its contents).
//
// The same rule one level up: `finished_at` is cleared before the first step and
// restamped only after the last, so a run that dies leaves a snapshot that says it
// is unfinished rather than one carrying the previous run's stamp.
//
// The record is read back as well as written (§2.4). A resource a run died
// inside carries `interrupted: true` and a cursor, and is continued from it; one
// that finished is refreshed with an `updated_since` pass whose rows are staged
// and merged, never appended blindly; anything else — including a sweep that ran
// out of cursor short of Harvest's own tally — is swept again from page 1.
//
// A child fan-out's checkpoint is positional in raw/<parent>.jsonl ("every parent
// before this one was dealt with"), so it describes one *generation* of that file.
// Sweeping the parent again from page 1 replaces the list the checkpoint indexes
// into, and the checkpoint goes with it: the fan-out starts over rather than
// resuming into a list that reordered under it.

import { parseUserMe, scopeChangeBetween, visibilityWarning } from './auth.js'
import { downloadBinaries, sanitizePriorBinaries } from './binaries.js'
import type { HarvestEnv } from './env.js'
import {
  archiveInvoicePdfs,
  readInvoicePdfInputs,
  type InvoicePdfThrottle,
} from './invoice-pdfs.js'
import {
  DEFAULT_BASE_URL,
  type HarvestApiError,
  type HarvestClientConfig,
} from './harvest-client.js'
import {
  appendPage,
  mergeIncremental,
  readIds,
  reconcileToCount,
  reconcileToFile,
  startResource,
} from './jsonl.js'
import { readManifestIfExists, writeManifest, type ManifestResource } from './manifest.js'
import {
  fetchWithPolicy,
  paginate,
  RESUME_GUIDANCE,
  type PaginateDeps,
  type Page,
} from './paginator.js'
import { collapseBetweenTokens, spansLines } from './raw-slices.js'
import { createRateLimiter, RATE_LIMIT, RATE_WINDOW_MS } from './rate-limiter.js'
import { RESOURCES, type ResourceStep } from './resources.js'
import { acquireSnapshotLock, releaseSnapshotLock } from './snapshot-lock.js'

export interface ExtractResult {
  resources: Record<string, ManifestResource>
  requests: number
  durationMs: number
}

export interface RunExtractOptions {
  env: HarvestEnv
  snapshotDir: string
  /** Injectable clock — tests never depend on a real `now`. */
  now?: () => Date
  log?: (line: string) => void
  sleep?: (ms: number) => Promise<void>
  /** Test seam: point the whole sweep at a local server. */
  baseUrl?: string
  timeoutMs?: number
  /** Reused by sync so extraction and its ID witnesses share one API budget. */
  session?: ExtractSession
  /** sync already holds the snapshot-wide mutation lock for its nested extract. */
  lockHeld?: boolean
  /** Test seam for the invoice web-surface throttle; never the Harvest API limiter. */
  invoicePdfThrottle?: InvoicePdfThrottle
}

/** One Harvest API session and its account-wide general-endpoint budget. */
export interface ExtractSession {
  config: HarvestClientConfig
  deps: PaginateDeps
  limiter: ReturnType<typeof createRateLimiter>
}

export interface CreateExtractSessionOptions {
  env: HarvestEnv
  accountId: string
  log?: (line: string) => void
  sleep?: (ms: number) => Promise<void>
  baseUrl?: string
  timeoutMs?: number
}

/**
 * Creates the reusable session used by `extract` and `sync`. Keeping the
 * limiter here makes it impossible for sync's second phase to unknowingly
 * spend outside the account's one general-endpoint budget.
 */
export const createExtractSession = (options: CreateExtractSessionOptions): ExtractSession => {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const log = options.log ?? ((line: string) => console.log(line))
  const limiter = createRateLimiter({ sleep })
  return {
    config: {
      pat: options.env.pat,
      userAgentEmail: options.env.userAgentEmail,
      accountId: options.accountId,
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs,
    },
    deps: { limiter, sleep, log },
    limiter,
  }
}

/** Seconds a given number of requests costs at the general budget. */
const budgetSeconds = (requests: number): number =>
  Math.ceil((requests * RATE_WINDOW_MS) / RATE_LIMIT / 1000)

const isApiError = (err: unknown): err is HarvestApiError =>
  err instanceof Error && typeof (err as HarvestApiError).status === 'number'

/**
 * The same refusal, said somewhere it can be acted on. `Harvest API error: 404
 * {"message":"Not Found"}` reaching a user names no resource, no path and no
 * parent, and says nothing about what the snapshot on disk now holds or what a
 * re-run will do to it. `status` is carried through, because the caller classifies
 * on it after this wrapping.
 */
/**
 * How far behind the server's clock a watermark is stamped. Overlap is free — a
 * re-read row upserts by `harvest_id` and changes nothing (E13) — while a gap is
 * permanent, because `updated_since` can never reach back past it. The bias is
 * deliberate and one-directional.
 *
 * The `Date` header is when the *response* was written, already after the query
 * ran; without the lag a row updated in between falls in the gap.
 */
const WATERMARK_LAG_MS = 60_000

/**
 * Harvest's own clock, as an ISO string lagged by the margin above, or null when
 * the response carried no readable `Date`.
 */
export const watermarkFrom = (serverDate: string | null): string | null => {
  if (serverDate === null) return null
  const at = Date.parse(serverDate)
  if (!Number.isFinite(at)) return null
  return new Date(at - WATERMARK_LAG_MS).toISOString()
}

/**
 * The lines to write for this page: the records' own wire bytes.
 *
 * When the body could not be sliced, or a record spans lines and so cannot be a
 * JSONL row, the manifest says so instead of quietly re-serialising — quiet
 * re-serialisation is what rewrote ids and money literals before (raw-slices.ts
 * has the worked example).
 */
const rawLines = (
  page: Page,
  resource: string,
  record: ManifestResource,
  log: (line: string) => void,
): string[] => {
  if (page.rawObjects === null || page.rawObjects.length !== page.objects.length) {
    const first = record.reserialized === 0
    record.reserialized += page.objects.length
    if (first) {
      log(
        `WARNING: ${resource} — could not read record bytes out of the response body, so rows are ` +
          're-serialised from the parsed form. Large ids and number literals may not survive ' +
          'verbatim (migration-spec §2.3); the manifest records how many.',
      )
    }
    return page.objects.map((o) => JSON.stringify(o))
  }
  return page.rawObjects.map((slice) => {
    if (!spansLines(slice)) return slice
    record.reflowed += 1
    return collapseBetweenTokens(slice)
  })
}

/**
 * Statuses that answer "this parent has none of these", rather than "your request
 * was wrong", on a step marked `optional`. 403 and 404 are the documented shapes;
 * 422 is what the live account actually returns for teammates.
 */
const INAPPLICABLE_STATUSES = new Set([403, 404, 422])

const inContext = (
  resource: string,
  path: string,
  err: HarvestApiError,
  guidance: string = RESUME_GUIDANCE,
): HarvestApiError => {
  const contextual = new Error(
    `${resource}: request to ${path} failed — ${err.message}. ${guidance}`,
    {
      cause: err,
    },
  ) as HarvestApiError
  contextual.status = err.status
  contextual.fix = err.fix
  contextual.body = err.body
  contextual.retryAfterSeconds = err.retryAfterSeconds
  return contextual
}

export const runExtract = async (options: RunExtractOptions): Promise<ExtractResult> => {
  const { env, snapshotDir } = options
  const now = options.now ?? (() => new Date())
  const log = options.log ?? ((line: string) => console.log(line))
  const startedMs = Date.now()
  const lockPath = options.lockHeld ? null : await acquireSnapshotLock(snapshotDir, 'extract')

  try {

  const manifest = await readManifestIfExists(snapshotDir)
  if (!manifest) {
    throw new Error(
      `no manifest.json in ${snapshotDir} — extract needs the account id and the company ` +
        `preflight that auth records. Run \`ezacto-migrate auth --snapshot-dir ${snapshotDir}\` first.`,
    )
  }
  // `manifest.binaries` is runtime input, including on same-account auth and
  // crash resumes. Validate every retained file and rebuild every nested scalar
  // before the first manifest checkpoint can serialize it again.
  const safePriorBinaries = await sanitizePriorBinaries(snapshotDir, manifest.binaries)
  if (safePriorBinaries) manifest.binaries = safePriorBinaries
  else delete manifest.binaries
  const invoicePdfBaseUri = options.baseUrl ?? manifest.preflight.base_uri
  if (typeof invoicePdfBaseUri !== 'string' || invoicePdfBaseUri.trim() === '') {
    throw new Error(
      `${snapshotDir}/manifest.json predates the invoice PDF archive and has no company base_uri. ` +
        `Run \`ezacto-migrate auth --snapshot-dir ${snapshotDir}\` to refresh its preflight before extract.`,
    )
  }
  const session =
    options.session ??
    createExtractSession({
      env,
      accountId: manifest.account.id,
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs,
      log,
      sleep: options.sleep,
    })
  const { config, deps, limiter } = session
  if (config.accountId !== manifest.account.id) {
    throw new Error(
      `the supplied Harvest session is for account ${config.accountId ?? '(none)'}, but ` +
        `${snapshotDir}/manifest.json is stamped for account ${manifest.account.id}`,
    )
  }

  // Who this PAT actually is, asked live rather than read out of the manifest.
  // manifest.preflight describes the token `auth` ran with; this process re-read
  // HARVEST_PAT from the environment and nothing so far has proved it is the same
  // one. An administrator `auth` followed by a member-scoped `extract` sweeps a
  // fraction of the account, prints no warning (the manifest still says
  // administrator), stamps finished_at and exits 0 — the one delta reconcile
  // cannot explain afterwards (§6). One request out of thousands closes it.
  //
  // Through fetchWithPolicy, not a bare fetch: this is the first request of every
  // run, and 429 is the condition the story exists to survive. A bare call would
  // put the one request most likely to meet a warm rate-limit window outside
  // Retry-After, outside the 5xx backoff, and outside the error wrapping (AC #2).
  const identityPath = '/v2/users/me'
  const identityUrl = `${config.baseUrl ?? DEFAULT_BASE_URL}${identityPath}`
  const me = parseUserMe(
    await fetchWithPolicy(identityUrl, 'identity check', config, deps)
      .then((fetched) => fetched.body)
      .catch((err: unknown) => {
        if (!isApiError(err)) throw err
        throw inContext(
          'identity check',
          identityPath,
          err,
          `Nothing was swept: ${snapshotDir} is exactly as the run before this one left it.`,
        )
      }),
  )
  const scopeChange = scopeChangeBetween(manifest.preflight.user, me)
  if (scopeChange) {
    throw new Error(
      `HARVEST_PAT is not the identity ${snapshotDir} was stamped with — ${scopeChange}. The rows ` +
        "already in raw/ show the preflight identity's visibility and this token sees a different " +
        `slice of the account. Export the original PAT, or re-run \`ezacto-migrate auth ` +
        `--snapshot-dir ${snapshotDir}\` to re-stamp the preflight for this one (it gates the change).`,
    )
  }

  // A member-scoped PAT produces a snapshot that is a fraction of the account and
  // looks, from its exit code, exactly like a complete one.
  const warning = visibilityWarning(me)
  if (warning) log(warning)

  const enabled = (step: ResourceStep): boolean =>
    !step.requires || manifest.preflight[step.requires]
  const skipped = RESOURCES.filter((step) => !enabled(step))

  // §2.2: say what this is going to cost before spending it.
  log(
    `extract: ${RESOURCES.length} resource steps into ${snapshotDir}, ` +
      `budget ${RATE_LIMIT} requests / ${RATE_WINDOW_MS / 1000}s (general endpoints)`,
  )
  if (skipped.length > 0) {
    log(
      `skipping ${skipped.length} feature-gated step(s): ` +
        skipped.map((s) => `${s.name} (${s.requires ?? 'disabled'} is false)`).join(', '),
    )
  }

  const resources: Record<string, ManifestResource> = { ...manifest.resources }

  const persist = async (): Promise<void> => {
    manifest.resources = resources
    await writeManifest(snapshotDir, manifest)
  }

  /**
   * Emptying raw/<parent>.jsonl invalidates every fan-out checkpoint taken over it.
   *
   * A child checkpoint is positional (manifest.parent_id): "every parent before
   * this one in raw/<parent>.jsonl was dealt with". Sweeping the parent again from
   * page 1 rewrites that list — Harvest lists newest first, rows are created and
   * deleted while a run is not looking — and resuming into the new one means one of
   * three things, all of which end `complete: true` because the inherited tallies
   * still agree with each other: a parent now in front of the checkpoint is never
   * swept (a gap), a parent now behind it is swept twice (duplicate child rows), or
   * the checkpointed id is gone entirely and the scan skips every parent looking
   * for it (zero requests, and children left in the file whose parents the snapshot
   * no longer holds).
   *
   * Dropped where the file is emptied, rather than detected where the checkpoint is
   * read: the run that empties the parent file may not be the run that later reads
   * the checkpoint, and by then nothing on disk says the two describe different
   * sweeps. `interrupted: false` with `complete: false` is the record extract
   * already reads as "nothing left to continue from" — the child is swept again
   * from its first parent, which is the only reading that can neither gap nor
   * duplicate.
   */
  const dropChildCheckpoints = (parent: string, why: string): void => {
    for (const child of RESOURCES) {
      if (child.kind !== 'child' || child.parent !== parent) continue
      const stale = resources[child.name]
      if (stale === undefined || !stale.interrupted) continue
      log(
        `${child.name}: its fan-out checkpoint (${parent} ${String(stale.parent_id)}) was taken ` +
          `over a raw/${parent}.jsonl this run has ${why} — dropping it, and sweeping ` +
          `${child.name} over the whole ${parent} list instead`,
      )
      stale.interrupted = false
      stale.next_url = null
      stale.parent_id = null
    }
  }

  // A run in flight is not a finished snapshot. `finished_at` is the top-level
  // completeness signal every consumer keys on, and startResource is about to
  // truncate the first raw file — so a re-run that dies three steps in must not
  // leave the previous run's stamp standing over a resource that is now empty.
  manifest.finished_at = null
  await persist()

  for (const step of RESOURCES) {
    const startedAt = now().toISOString()
    // The record this resource ended the previous run in, before this run
    // touches it — undefined the first time extract ever sees this resource.
    const prior = resources[step.name]

    if (!enabled(step)) {
      // `count: 0` is a claim about raw/<resource>.jsonl, so the file has to be
      // made to match it. A feature switched off between runs would otherwise
      // leave the previous run's rows on disk under a manifest that denies they
      // exist — `load` reads raw/ (§3) and would import them, `verify` compares
      // manifest counts and would see none. Same for the watermark: keeping it
      // would let a later incremental pass step over rows this snapshot no
      // longer holds.
      await startResource(snapshotDir, step.name)
      dropChildCheckpoints(step.name, 'emptied')
      delete manifest.updated_since[step.name]
      resources[step.name] = {
        count: 0,
        total_entries: null,
        staged_count: 0,
        staged_total_entries: null,
        pages: 0,
        requests: 0,
        missing_parents: 0,
        refused_parents: 0,
        refused_status: null,
        next_url: null,
        parent_id: null,
        pass: 0,
        complete: true,
        interrupted: false,
        incremental: false,
        skipped_reason: `${step.requires ?? 'feature'} is false`,
        started_at: startedAt,
        watermark_source: null,
        reserialized: 0,
        reflowed: 0,
        finished_at: startedAt,
      }
      await persist()
      continue
    }

    // A process died inside this resource's sweep: the record was claimed and
    // never ran out of passes (or parents). Only such a record carries a
    // checkpoint — `!complete` on its own also covers a sweep that ran to the
    // end of its cursor and came up short of `total_entries`, which has nothing
    // left to fetch where it stopped and has to be swept again from page 1.
    const interrupted =
      prior !== undefined && prior.interrupted && !prior.complete && prior.skipped_reason === null

    // The watermark an `updated_since` pass filters on: the time the run that
    // last completed this resource started sweeping it. Read here rather than
    // inside the eligibility test below because a *re-run* of an interrupted
    // incremental pass needs the same one — it is restamped only when a pass
    // completes, so it is still exactly as valid as it was for the run that died.
    const watermark = manifest.updated_since[step.name]

    // A prior run finished this resource. For a `list` step that becomes an
    // `updated_since` incremental pass (§2.4) — merged into the existing file,
    // never re-swept. `child` steps stay out of that: they fan out over the
    // *current* parent ids read back off disk, and Harvest's child endpoints
    // (messages, rates, payments) do not offer a comparable filter — re-sweeping
    // them in full each run is what stays correct without one. `noUpdatedSince`
    // steps stay out of it too: Harvest ignores a filter it does not implement
    // and hands back the whole collection (research §7, §13).
    //
    // `prior.skipped_reason === null` excludes a resource whose feature was off
    // last run and is on now: that record is `complete: true` with `count: 0`
    // and no `updated_since` entry (the skip branch above deletes it) — treating
    // it as incremental would query `updated_since=undefined` and never sweep the
    // rows this account has always had.
    const canFilter = step.kind === 'list' && !step.noUpdatedSince
    const incrementalEligible =
      prior !== undefined && prior.complete && prior.skipped_reason === null && canFilter

    // An incremental pass the previous run died inside is re-run as one, from its
    // first page. Its rows are staged (jsonl.mergeIncremental) rather than
    // appended, so there is nothing on disk to duplicate by starting over, and
    // what it re-fetches is bounded by what changed since the watermark — cheaper
    // than the alternative it replaces, which was to inherit the last *full*
    // sweep's `pages`/`pass`/`next_url` and read that exhausted cursor as this
    // pass's own: zero requests, then `complete: true` and a watermark stamped
    // over every row the dead run was supposed to collect.
    //
    // `canFilter` again, because a record left `incremental` by a run that
    // predates this step's opt-out has to be swept in full instead of re-run as a
    // pass Harvest has no filter for.
    const reRunIncremental = prior !== undefined && interrupted && prior.incremental && canFilter

    // No watermark, no incremental pass — a filtered sweep with nothing to filter
    // on is a full sweep wearing the wrong record. Falling back to one is the
    // reading that cannot lose rows.
    const incremental = (incrementalEligible || reRunIncremental) && watermark !== undefined

    // Resuming a full sweep from its cursor. `prior.pages > 0` (or, for a
    // fan-out, `prior.parent_id` having been set) is what tells a checkpoint
    // apart from a sweep that died before its first page: there is no page to
    // continue from there, so the resource starts over. An incremental record is
    // never one of these — its pass is re-run above, or the resource is swept in
    // full below, and neither reads the cursor.
    const resuming =
      prior !== undefined &&
      interrupted &&
      !prior.incremental &&
      (prior.pages > 0 || (step.kind === 'child' && prior.parent_id !== null))

    const record: ManifestResource = resuming
      ? { ...prior, complete: false, interrupted: true, finished_at: null }
      : incremental && prior !== undefined
        ? {
            ...prior,
            // A checkpoint of this pass's own. `count` stays: it describes
            // raw/<resource>.jsonl, which an incremental pass does not touch
            // until it merges. Everything else describes the pass in flight, and
            // inheriting it is what made a pass that never got a page look like
            // one that had run to the end of its cursor — including the pass's
            // own witness pair, which starts empty because the pass always starts
            // at page 1.
            staged_count: 0,
            staged_total_entries: null,
            pages: 0,
            requests: 0,
            next_url: null,
            parent_id: null,
            pass: 0,
            complete: false,
            incremental: true,
            interrupted: true,
            started_at: startedAt,
            watermark_source: null,
            reserialized: 0,
            reflowed: 0,
            finished_at: null,
          }
        : {
            count: 0,
            total_entries: null,
            staged_count: 0,
            staged_total_entries: null,
            pages: 0,
            requests: 0,
            missing_parents: 0,
            refused_parents: 0,
            refused_status: null,
            next_url: null,
            parent_id: null,
            pass: 0,
            complete: false,
            incremental: false,
            interrupted: true,
            skipped_reason: null,
            started_at: startedAt,
            watermark_source: null,
            reserialized: 0,
            reflowed: 0,
            finished_at: null,
          }
    resources[step.name] = record

    if (resuming) {
      // The file can be one page ahead of the manifest (fsynced, not yet
      // claimed) if the previous run died between the two — drop what the
      // manifest never got to count, so the page it names is re-fetched once,
      // not skipped or duplicated.
      await reconcileToCount(snapshotDir, step.name, record.count)
    } else if (record.incremental) {
      // Empty the staging file this pass appends to — which is also how the
      // rows of an interrupted pass being re-run here are discarded, before it
      // fetches them again.
      await startResource(snapshotDir, step.name, true)
      // Then check the file this pass is going to merge into against the `count`
      // that claims to describe it — every incremental pass, not only a re-run,
      // because both directions of the disagreement end in a stamped snapshot:
      //
      //  - the file *ahead* of `count` is the merge's ordering hazard, the page
      //    loop's one level up: mergeIncremental commits raw/<resource>.jsonl with
      //    a rename and `count` is only durable at the manifest write several
      //    statements below it. A run killed in between leaves the file holding
      //    merged rows the manifest does not claim, and the re-run of the pass
      //    cannot correct that whenever it stages nothing (the rows the dead pass
      //    fetched were deleted upstream in the meantime): the merge reports no
      //    length, and the record gets stamped `complete` over the discrepancy.
      //  - the file *behind* `count` is rows an fsync promised and the disk no
      //    longer has — a restored or half-copied snapshot dir, a kill inside the
      //    feature-gate skip branch's truncate above with the flag switched back on
      //    afterwards. reconcileToFile refuses that, exactly as reconcileToCount
      //    does for a resumed full sweep: adopting the shorter file would let the
      //    merge below rewrite the resource around it and record the loss as
      //    `complete`, with a fresh watermark over the rows that went missing.
      record.count = await reconcileToFile(snapshotDir, step.name, record.count)
    } else {
      await startResource(snapshotDir, step.name)
      // The rows a child fan-out checkpoint indexes into are gone; so is the
      // checkpoint. Persisted by the write below, before the sweep that replaces
      // them starts, so a crash cannot leave the checkpoint standing over them.
      dropChildCheckpoints(step.name, 'swept again from page 1')
    }
    await persist()

    /** Consume one sweep, checkpointing after every page. */
    const sweep = async (
      path: string,
      params: Record<string, string> | undefined,
      pass: number,
      parentId: number | null,
      startUrl?: string,
      alreadyTallied = false,
    ): Promise<void> => {
      // Every page of one sweep repeats the same tally, so it is taken once and
      // added to the resource's — a resource is one sweep per pass, per parent.
      // `alreadyTallied` is set when this call is *resuming* a pass or parent
      // whose first page — and its contribution to total_entries — was already
      // folded in before the crash; without it, resuming would count that page's
      // total_entries twice.
      let tallied = alreadyTallied
      try {
        for await (const page of paginate(
          { resource: step.name, path, collection: step.collection, params, startUrl },
          config,
          deps,
        )) {
          // Harvest evaluates `updated_since` against its own clock, so the
          // watermark comes from the server's Date header, never from `now()`.
          // A host clock running fast would otherwise stamp a watermark ahead of
          // the server's time and put every row updated in that window out of
          // reach of every later incremental pass — silently, because the pass's
          // own witness pair agrees with itself. Taken from the first response of
          // the pass and kept: a later page's Date is further ahead.
          record.watermark_source ??= watermarkFrom(page.serverDate)

          // Append first, then claim it. A crash between the two re-fetches one page.
          await appendPage(
            snapshotDir,
            step.name,
            rawLines(page, step.name, record, log),
            record.incremental,
          )
          // `count` describes raw/<resource>.jsonl, and an incremental pass writes
          // to raw/<resource>.jsonl.incoming — counting its rows here claims rows
          // the file it names does not hold. The merge below is the only writer of
          // `count` for such a pass, and it usually papered this over by returning
          // the merged file's real length; not when the pass ends up staging
          // nothing (mergeIncremental returns null and never gets to correct it),
          // which is exactly what a re-run of a crashed pass finds when the rows
          // the dead pass fetched were deleted upstream in between. The inflated
          // count then survives into a snapshot stamped complete.
          //
          // The pass's rows are counted all the same, into the field that names
          // the file they are actually in: `staged_count` is one half of the only
          // witness a filtered sweep has against its own truncation.
          if (record.incremental) record.staged_count += page.objects.length
          else record.count += page.objects.length
          record.pages += 1
          record.requests += page.requests
          record.next_url = page.nextUrl
          record.parent_id = parentId
          record.pass = pass
          // Folded in on the first page of the sweep, not after its last. Page 1's
          // rows are already in `count` by the time page 2 can fail, and if the
          // tally were only added at the end, a sweep that died mid-way would keep
          // the rows and drop the one number that says how many there should have
          // been — leaving total_entries reading *lower* than count, i.e. the only
          // outside witness against truncation pointing away from it.
          //
          // An incremental pass tallies into its own pair rather than this one:
          // total_entries for a filtered query counts the rows matching
          // `updated_since`, not the collection, so folding it into the resource's
          // tally and comparing that to the file's cumulative count would read
          // every incremental pass as a truncation. Against `staged_count` — the
          // rows this pass wrote, which is exactly the population Harvest just
          // counted — it is an exact comparison, and the only one such a pass has.
          if (!tallied) {
            tallied = true
            if (page.totalEntries !== null) {
              if (record.incremental) {
                record.staged_total_entries = (record.staged_total_entries ?? 0) + page.totalEntries
              } else {
                record.total_entries = (record.total_entries ?? 0) + page.totalEntries
              }
            }
          }
          await persist()
        }
      } catch (err) {
        // A bare `Harvest API error: 404 {...}` names nothing the reader can act on.
        if (isApiError(err)) throw inContext(step.name, path, err)
        throw err
      }
    }

    if (step.kind === 'list') {
      const passes = step.passes ?? [undefined]
      // Where the previous run's cursor sits: mid-pass (resume that pass from its
      // `next_url`) or between passes (skip straight to the next one) — `pass` and
      // `next_url` are shared across every pass of one resource because they are
      // one sweep-in-flight at a time, so the pair always names exactly one spot.
      const resumePass = resuming ? record.pass : 0
      const resumeUrl = resuming ? record.next_url : null
      for (const [pass, extra] of passes.entries()) {
        if (resuming) {
          if (pass < resumePass) continue
          if (pass === resumePass && resumeUrl === null) continue // that pass already finished
        }
        const startUrl = resuming && pass === resumePass ? (resumeUrl ?? undefined) : undefined
        // Every pass of an incremental step carries the filter, including the
        // ones a resumed run reaches after the pass it resumed. Written against
        // `watermark` itself rather than a cast: an `updated_since` that is not a
        // string is a filter Harvest either rejects or ignores, and the second is
        // the whole collection arriving where the changed rows were expected.
        const params = {
          ...step.params,
          ...extra,
          ...(incremental && watermark !== undefined ? { updated_since: watermark } : {}),
        }
        await sweep(step.path, params, pass, null, startUrl, startUrl !== undefined)
      }
    } else {
      const parentCount = resources[step.parent]?.count ?? 0
      log(
        `${step.name}: fanning out over ${parentCount} ${step.parent} ` +
          `(~${parentCount} requests, ~${budgetSeconds(parentCount)}s at the budget)`,
      )
      // Same idea as the list-step cursor above, one level deeper: `parent_id` is
      // the parent whose own pagination `next_url` describes. A crash right after
      // finishing a parent (next_url back to null) leaves nothing to resume in
      // it — the fan-out just has to skip past an id it already fully swept.
      let parents = 0
      // Inherited on a resume, all of them: a resumed fan-out skips past the
      // parents the dead run already dealt with, so a refusal it observed is one
      // this run will never see again. Re-deriving these from what this run
      // happens to meet is how a resource whose children are missing came to
      // report full coverage.
      let refused = resuming ? (record.refused_parents ?? 0) : 0
      const refusedStatuses = new Set<number>(
        resuming && record.refused_status ? [record.refused_status] : [],
      )
      let missing = resuming ? record.missing_parents : 0
      let lastParentId = 0
      let resumePending = resuming
      const resumeParentId = resuming ? record.parent_id : null
      const resumeUrl = resuming ? record.next_url : null
      for await (const parentId of readIds(snapshotDir, step.parent)) {
        parents += 1
        lastParentId = parentId
        let startUrl: string | undefined
        if (resumePending) {
          if (parentId !== resumeParentId) continue
          resumePending = false
          if (resumeUrl === null) continue // this parent already fully swept
          startUrl = resumeUrl
        }
        const pagesBefore = record.pages
        // `pagesBefore` is captured fresh each run, so it cannot see the pages a
        // *previous* run already wrote for the parent it was checkpointed inside.
        // `startUrl` is that checkpoint: it is set only when this parent is being
        // resumed mid-pagination, which is to say only when raw/<resource>.jsonl
        // already holds page(s) of it. Without this, a resumed parent whose very
        // first request — its stored cursor — answers 404 or 403 leaves
        // `record.pages` where it started and reads as a parent that gave us
        // nothing, i.e. as the missing/refused case below.
        const resumedMidParent = startUrl !== undefined
        try {
          await sweep(step.path(parentId), undefined, 0, parentId, startUrl, startUrl !== undefined)
        } catch (err) {
          if (!isApiError(err)) throw err

          // Neither refusal below is available once this parent has yielded a page.
          // Both continue the fan-out and let the step finish `complete: true`, and
          // both are statements about a parent that gave us *nothing* — "it is gone",
          // "the feature is off for it". A failure partway through a parent's own
          // pagination is neither: its page 1 is already in raw/<resource>.jsonl and
          // in `count`. Swallowing that would keep the partial rows, record the
          // resource as a complete sweep, and — because the step then stamps
          // updated_since — put the missing rows out of reach of every later
          // incremental pass. The truncation is permanent; the run must stop.
          if (record.pages > pagesBefore || resumedMidParent) {
            const written = record.pages - pagesBefore
            throw new Error(
              `${step.name}: ${step.parent} ${parentId} answered ${err.status} ` +
                (resumedMidParent
                  ? `partway through its own pagination — this run resumed it at the cursor a ` +
                    `previous run checkpointed inside it, so page(s) of it are already in ` +
                    `raw/${step.name}.jsonl`
                  : `on page ${written + 1} of its own pagination, after ${written} page(s) of ` +
                    `it were already written to raw/${step.name}.jsonl`) +
                `. That is a truncated ${step.parent}, not a missing one: continuing would count ` +
                `the partial rows and record ${step.name} as complete. ` +
                RESUME_GUIDANCE,
              { cause: err },
            )
          }

          // Both refusals below cost a request against the budget even though they
          // yielded no page — the manifest's cost record has to say so.
          //
          // An optional step is one we can only discover by being refused —
          // teammates is gated by company.team_feature, which /v2/company does not
          // report. But Harvest's 403 is scoped to the object asked for ("the object
          // you requested was found but you don't have authorization", research
          // §0.3), so one refusal is an answer about one parent. The fan-out
          // continues; only a refusal from every parent says anything about the
          // account, and that is decided after the loop.
          //
          // Checkpointed here rather than after the loop, and the checkpoint moved
          // past this parent with it: a refusal is this fan-out dealing with a
          // parent, exactly like a sweep of one. Left to the end, both the tally
          // and the position were a crash away from being lost — and a resume that
          // rewound to the last *swept* parent would count every refusal in between
          // a second time.
          //
          // 422 is in the set on the evidence of the live account, not the docs:
          // Harvest answers /v2/users/{id}/teammates with
          // `422 {"message":"User must be a Manager to have teammates"}` for every
          // non-manager — a statement about this parent, not a complaint about the
          // request, and no documented error schema tells the two apart
          // (research §0.3, §15.5).
          if (step.optional && INAPPLICABLE_STATUSES.has(err.status)) {
            record.requests += 1
            refused += 1
            refusedStatuses.add(err.status)
            record.refused_parents = refused
            record.refused_status = err.status
            record.parent_id = parentId
            record.next_url = null
            await persist()
            continue
          }
          // A 404 on a child endpoint means the parent row is gone. extract runs
          // against an account people are still using (§5), so an invoice deleted
          // between the parent sweep and this fan-out is a race, not a failure —
          // recorded and continued past, rather than taking every later step down
          // with it.
          if (err.status === 404) {
            record.requests += 1
            missing += 1
            record.missing_parents = missing
            record.parent_id = parentId
            record.next_url = null
            await persist()
            log(
              `${step.name}: ${step.parent} ${parentId} returned 404 — deleted since the ` +
                `${step.parent} sweep; recording it as missing and continuing`,
            )
            continue
          }
          throw err
        }
      }

      // The scan ran off the end of raw/<parent>.jsonl without ever meeting the
      // parent it was resuming at, so it skipped every parent in the file looking
      // for one that is not in it — no requests issued, and the tallies below are
      // the dead run's, which agree with each other and would stamp the step
      // complete over children that were never fetched. The checkpoint is stale:
      // dropping it (and saying so) is what makes the re-run sweep this step from
      // its first parent instead of reproducing this forever.
      if (resumePending) {
        record.interrupted = false
        record.next_url = null
        record.parent_id = null
        await persist()
        throw new Error(
          `${step.name}: resumed at ${step.parent} ${String(resumeParentId)}, which ` +
            `raw/${step.parent}.jsonl does not hold — the checkpoint describes a ${step.parent} ` +
            `sweep this snapshot has since replaced, and all ${parents} ${step.parent} in the file ` +
            `now were skipped looking for it. The checkpoint has been dropped: re-run to sweep ` +
            `${step.name} over the whole ${step.parent} list again.`,
        )
      }

      // …unless *every* parent 404s, which is not a race — it is a path that does
      // not exist for this account. Recording an empty resource as complete is
      // exactly the silent-data-loss failure the registry's guess-guard exists for.
      if (missing > 0 && missing === parents) {
        // The checkpoint goes before the throw, exactly as the stale-checkpoint
        // case above does it — and for the same reason. Every one of those 404s
        // checkpointed itself, so the record still says `interrupted` at the last
        // parent: left standing, the next run resumes into it, skips every parent
        // looking for that id, `continue`s past it (its next_url is null), issues
        // no request at all, inherits this tally and throws this same error —
        // forever, even once the path answers again. Both the usage text and
        // RESUME_GUIDANCE promise a re-run resumes; the only way out was editing
        // manifest.json by hand.
        record.interrupted = false
        record.next_url = null
        record.parent_id = null
        record.missing_parents = 0
        await persist()
        throw new Error(
          `${step.name}: Harvest returned 404 for every one of the ${parents} ${step.parent} this ` +
            `step fanned out over (last: ${step.path(lastParentId)}). Either that path is wrong for ` +
            `this account or the whole ${step.parent} collection was deleted mid-run — refusing to ` +
            `record an empty ${step.name} as a complete resource. The checkpoints those 404s left ` +
            `behind have been dropped: re-run to sweep ${step.name} over the whole ${step.parent} ` +
            `list again.`,
        )
      }
      if (refused > 0) {
        const statuses = [...refusedStatuses].sort((a, b) => a - b).join('/')
        record.skipped_reason =
          refused === parents
            ? `Harvest returned ${statuses} for all ${parents} ${step.parent} — ${step.name} is not enabled on this account`
            : `Harvest returned ${statuses} for ${refused} of ${parents} ${step.parent} — those ${step.name} are not in this snapshot`
        log(`${step.name}: ${record.skipped_reason}`)
      }
    }

    // An incremental pass fetched fresher copies of rows raw/<resource>.jsonl
    // already holds. Merging them in — keeping one line per id — is what stops
    // the file growing a second copy of every changed row, which `count` would
    // inflate, `load` would upsert away (leaving `verify` an unexplained delta,
    // §6), and any child step fanning out over this resource would turn into a
    // duplicate request and a duplicate child row per changed parent.
    //
    // Before the checkpoint is cleared: a crash mid-merge leaves the staged rows
    // on disk and the record still saying a pass is in flight, so the next run
    // re-runs the pass and merges again onto the same file.
    if (record.incremental) {
      const merged = await mergeIncremental(snapshotDir, step.name)
      if (merged !== null) record.count = merged
    }

    // Out of passes (or out of parents): whatever the tallies below say, there is
    // no page left to fetch where this sweep stopped, so the record must stop
    // reading as resumable. A sweep that comes up short stays `complete: false`
    // and is swept again from page 1 next run — resuming it would issue no
    // requests at all and reproduce the same shortfall, forever.
    record.interrupted = false

    // Harvest states the size of every collection it paginates, and that tally is
    // the only witness to this sweep from outside: `count` is the rows we wrote,
    // which agrees with itself whether the sweep ran to the end of the collection
    // or stopped at the first `links.next: null` that should not have been null.
    // Recorded for `verify` (§6) either way, and said out loud when they disagree.
    //
    // An incremental pass is witnessed the same way, by the pair scoped to it.
    // Harvest states a `total_entries` for a filtered query too — the rows matching
    // it — and what the pass staged is exactly the population that tally counts, so
    // the two compare exactly. The resource-level pair says nothing about a pass:
    // `total_entries` is the last full sweep's and `count` is a file the merge above
    // has just folded new rows into. Reading that one was why a truncated filtered
    // sweep had no witness at all.
    const witness = record.incremental ? record.staged_total_entries : record.total_entries
    const written = record.incremental ? record.staged_count : record.count
    if (witness !== null && witness !== written) {
      const gap = witness - written
      // Rows created or deleted *while* the sweep ran move the tally either way by
      // a little, and that is the only benign reading. A shortfall past that is the
      // sweep having stopped early — the same permanent truncation this file
      // refuses to accept from a child parent, and refusing it there while logging
      // it here would be an inconsistency, not a judgement call. Marking the step
      // complete stamps updated_since, which puts the missing rows out of reach of
      // every later incremental pass.
      log(
        `WARNING: ${step.name} — Harvest reported ${witness} ` +
          (record.incremental
            ? `entries changed since ${record.started_at} and this pass staged ${written} rows`
            : `entries and the snapshot holds ${written} rows`) +
          ` (${gap > 0 ? `${gap} short` : `${-gap} over`}). Rows created or ` +
          `deleted while the sweep was running explain a small difference; a large one means the ` +
          `sweep stopped early — check raw/${step.name}.jsonl before loading.`,
      )
    }

    // Harvest's own tally is the only witness to this sweep from outside it:
    // `count` agrees with itself whether the sweep ran to the end of the
    // collection or stopped at the first `links.next: null` that should not have
    // been null. Where the two disagree we do not know which happened, and
    // `complete` is not the field to guess in — stamping it would also stamp
    // `updated_since`, and a watermark is what puts the rows a sweep missed out of
    // reach of every later incremental pass. So the step stays open, the run
    // carries on through the remaining resources, and the summary below refuses to
    // call the snapshot finished.
    // Only a *shortfall* can hide rows. Writing more than Harvest's page-1 tally
    // means rows were created while the sweep ran — surprising enough to log, but
    // it cannot conceal a truncation, and failing a run over it would fail every
    // extract of an account somebody is still using.
    //
    // A filtered pass is held to the same rule against its own witness, and has to
    // be: it is the path that carries the volume on every re-run, and it is the one
    // that stamps a watermark. A pass handed fewer rows than Harvest said matched
    // its filter, completing, would move the watermark past the changed rows it
    // never fetched — out of reach of this pass and of every later one, which is
    // the loss the full-sweep path calls permanent and refuses.
    const short = witness !== null && written < witness

    record.complete = !short
    record.finished_at = now().toISOString()
    if (record.complete && record.watermark_source === null) {
      log(
        `WARNING: ${step.name} — no readable Date header on any response, so no updated_since ` +
          'watermark is stamped. The next run re-sweeps this resource in full, which is slower ' +
          'than an incremental pass but cannot step over a row.',
      )
    }
    if (record.complete && record.watermark_source !== null) {
      // The watermark is the time *before* this pass's first request, never
      // after: a row updated while the sweep was running must be re-read next
      // time, not stepped over because the clock had already moved past it.
      // `record.started_at`, not the local `startedAt` — resuming an interrupted
      // pass keeps the *original* pre-crash timestamp there (see above), and a
      // watermark stamped from the later resume time would step over any row
      // updated in the gap between the crash and the resume.
      manifest.updated_since[step.name] = record.watermark_source
    }
    await persist()

    log(
      `${step.name}: ${record.count} rows, ${record.pages} pages, ${record.requests} requests` +
        (record.missing_parents > 0 ? `, ${record.missing_parents} missing parents` : '') +
        (record.skipped_reason ? ` (${record.skipped_reason})` : ''),
    )
  }

  // `finished_at` is the top-level completeness signal every consumer keys on, so
  // it is stamped only when every resource actually finished. A run that swept 30
  // resources and came up short on one is not a finished snapshot, and exiting 0
  // over it would hand `load` a truncated account with nothing to notice it by.
  const incomplete = Object.entries(resources).filter(([, r]) => !r.complete)
  if (incomplete.length > 0) {
    throw new Error(
      `extract did not complete: ${incomplete.map(([name]) => name).join(', ')} — ` +
        incomplete
          .map(([name, r]) =>
            r.incremental
              ? `${name} staged ${r.staged_count} of the ${String(r.staged_total_entries)} entries ` +
                `Harvest reported changed`
              : `${name} holds ${r.count} of ${String(r.total_entries)} entries`,
          )
          .join('; ') +
        `. Every other resource is on disk and manifest.json records which ones fell short; ` +
        `finished_at is left null and their watermarks unstamped. A sweep that ran out of pages ` +
        `short of Harvest's own tally has no page left to continue from, so a re-run sweeps those ` +
        `resources again from page 1 — and resumes anything the run was still inside of from its ` +
        `last checkpoint.`,
    )
  }

  const binaries = await downloadBinaries({
    snapshotDir,
    prior: safePriorBinaries,
    timeoutMs: options.timeoutMs,
    log,
    onProgress: async (archive) => {
      manifest.binaries = archive
      await persist()
    },
    webAuth: {
      origin: manifest.preflight.base_uri,
      pat: env.pat,
      accountId: manifest.account.id,
      userAgentEmail: env.userAgentEmail,
    },
  })
  manifest.binaries = binaries
  // Receipt/avatar downloads finish before the longer invoice sweep. Make
  // their new index durable before the first client-facing request.
  await persist()
  const invoicePdfInputs = await readInvoicePdfInputs(snapshotDir)
  const invoiceResource = resources.invoices
  if (!invoiceResource || invoicePdfInputs.length !== invoiceResource.count) {
    throw new Error(
      `raw/invoices.jsonl holds ${invoicePdfInputs.length} invoice row(s), but manifest.json ` +
        `claims ${invoiceResource?.count ?? 'none'} — refusing to build a PDF archive from an ` +
        'incomplete or mismatched source file',
    )
  }
  binaries.invoice_pdfs = await archiveInvoicePdfs({
    snapshotDir,
    // `baseUrl` is the whole-sweep local-server seam used by extract tests.
    // Production never sets it and uses the web origin captured by auth.
    baseUri: invoicePdfBaseUri,
    expectedFullDomain: manifest.preflight.full_domain,
    ...(options.baseUrl !== undefined ? { testBaseUri: options.baseUrl } : {}),
    invoices: invoicePdfInputs,
    prior: safePriorBinaries?.invoice_pdfs,
    timeoutMs: options.timeoutMs,
    throttle: options.invoicePdfThrottle,
    log,
    onProgress: async (archive) => {
      binaries.invoice_pdfs = archive
      await persist()
    },
  })
  log(
    `invoice_pdfs: ${binaries.invoice_pdfs.summary.archived} archived, ` +
      `${binaries.invoice_pdfs.anomalies.length} anomalies, ` +
      `${binaries.invoice_pdfs.summary.skipped} unchanged`,
  )

  manifest.finished_at = now().toISOString()
  await persist()

  // The limiter, not the page tally, is what the account's rate budget actually
  // saw: it counts retries, and it counts the requests an optional step spent
  // being refused.
  return { resources, requests: limiter.granted, durationMs: Date.now() - startedMs }
  } finally {
    if (lockPath !== null) await releaseSnapshotLock(lockPath)
  }
}
