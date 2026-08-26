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
// This story writes the resume record. It does not yet read it back to skip
// completed work — resuming mid-resource is its own story, with its own kill -9
// acceptance test.

import { parseUserMe, scopeChangeBetween, visibilityWarning } from './auth.js'
import type { HarvestEnv } from './env.js'
import {
  DEFAULT_BASE_URL,
  type HarvestApiError,
  type HarvestClientConfig,
} from './harvest-client.js'
import { appendPage, readIds, reconcileToCount, startResource } from './jsonl.js'
import { readManifestIfExists, writeManifest, type ManifestResource } from './manifest.js'
import { fetchWithPolicy, paginate, RESUME_GUIDANCE, type PaginateDeps } from './paginator.js'
import { createRateLimiter, RATE_LIMIT, RATE_WINDOW_MS } from './rate-limiter.js'
import { RESOURCES, type ResourceStep } from './resources.js'

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
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const startedMs = Date.now()

  const manifest = await readManifestIfExists(snapshotDir)
  if (!manifest) {
    throw new Error(
      `no manifest.json in ${snapshotDir} — extract needs the account id and the company ` +
        `preflight that auth records. Run \`ezacto-migrate auth --snapshot-dir ${snapshotDir}\` first.`,
    )
  }

  const config: HarvestClientConfig = {
    pat: env.pat,
    userAgentEmail: env.userAgentEmail,
    accountId: manifest.account.id,
    baseUrl: options.baseUrl,
    timeoutMs: options.timeoutMs,
  }

  // One limiter for the whole run: the budget is per account, not per resource.
  // It is created before the identity check so that request counts against it too.
  const limiter = createRateLimiter({ sleep })
  const deps: PaginateDeps = { limiter, sleep, log }

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
      delete manifest.updated_since[step.name]
      resources[step.name] = {
        count: 0,
        total_entries: null,
        pages: 0,
        requests: 0,
        missing_parents: 0,
        next_url: null,
        parent_id: null,
        pass: 0,
        complete: true,
        incremental: false,
        skipped_reason: `${step.requires ?? 'feature'} is false`,
        started_at: startedAt,
        finished_at: startedAt,
      }
      await persist()
      continue
    }

    // Resuming means a *previous* run wrote pages for this resource and never
    // reached `complete: true` — a crash or an unretryable failure mid-sweep.
    // `prior.pages > 0` (or, for a fan-out, `prior.parent_id` having been set) is
    // what tells that apart from a resource this run has simply not reached yet:
    // both look like "not complete" in the manifest, but only one has a cursor
    // worth continuing from.
    const resuming =
      prior !== undefined &&
      !prior.complete &&
      prior.skipped_reason === null &&
      (prior.pages > 0 || (step.kind === 'child' && prior.parent_id !== null))

    // A prior run finished this resource. For a `list` step that becomes an
    // `updated_since` incremental pass (§2.4) — appended onto the existing file,
    // never re-swept. `child` steps stay out of that: they fan out over the
    // *current* parent ids read back off disk, and Harvest's child endpoints
    // (messages, rates, payments) do not offer a comparable filter — re-sweeping
    // them in full each run is what stays correct without one.
    //
    // `prior.skipped_reason === null` excludes a resource whose feature was off
    // last run and is on now: that record is `complete: true` with `count: 0`
    // and no `updated_since` entry (the skip branch above deletes it) — treating
    // it as incremental would query `updated_since=undefined` and never sweep the
    // rows this account has always had.
    const incrementalEligible =
      prior !== undefined && prior.complete && prior.skipped_reason === null && step.kind === 'list'
    const watermark = incrementalEligible ? manifest.updated_since[step.name] : undefined

    const record: ManifestResource = resuming
      ? { ...prior, complete: false, finished_at: null }
      : incrementalEligible
        ? { ...prior, complete: false, finished_at: null, incremental: true, started_at: startedAt }
        : {
            count: 0,
            total_entries: null,
            pages: 0,
            requests: 0,
            missing_parents: 0,
            next_url: null,
            parent_id: null,
            pass: 0,
            complete: false,
            incremental: false,
            skipped_reason: null,
            started_at: startedAt,
            finished_at: null,
          }
    resources[step.name] = record

    if (resuming) {
      // The file can be one page ahead of the manifest (fsynced, not yet
      // claimed) if the previous run died between the two — drop what the
      // manifest never got to count, so the page it names is re-fetched once,
      // not skipped or duplicated.
      await reconcileToCount(snapshotDir, step.name, record.count)
    } else if (!incrementalEligible) {
      await startResource(snapshotDir, step.name)
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
          // Append first, then claim it. A crash between the two re-fetches one page.
          await appendPage(snapshotDir, step.name, page.objects)
          record.count += page.objects.length
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
          // Skipped entirely for an incremental pass: total_entries there counts
          // rows matching `updated_since`, not the collection, and comparing it to
          // the file's cumulative count would read every incremental pass as a
          // truncation.
          if (!tallied) {
            tallied = true
            if (!record.incremental && page.totalEntries !== null) {
              record.total_entries = (record.total_entries ?? 0) + page.totalEntries
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
        const params = {
          ...step.params,
          ...extra,
          ...(record.incremental ? { updated_since: watermark as string } : {}),
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
      let refused = 0
      let refusedStatus = 0
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
          if (record.pages > pagesBefore) {
            throw new Error(
              `${step.name}: ${step.parent} ${parentId} answered ${err.status} on page ` +
                `${record.pages - pagesBefore + 1} of its own pagination, after ` +
                `${record.pages - pagesBefore} page(s) of it were already written to ` +
                `raw/${step.name}.jsonl. That is a truncated ${step.parent}, not a missing one: ` +
                `continuing would count the partial rows and record ${step.name} as complete. ` +
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
          if (step.optional && (err.status === 403 || err.status === 404)) {
            record.requests += 1
            refused += 1
            refusedStatus = err.status
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
            log(
              `${step.name}: ${step.parent} ${parentId} returned 404 — deleted since the ` +
                `${step.parent} sweep; recording it as missing and continuing`,
            )
            continue
          }
          throw err
        }
      }

      // …unless *every* parent 404s, which is not a race — it is a path that does
      // not exist for this account. Recording an empty resource as complete is
      // exactly the silent-data-loss failure the registry's guess-guard exists for.
      if (missing > 0 && missing === parents) {
        throw new Error(
          `${step.name}: Harvest returned 404 for every one of the ${parents} ${step.parent} this ` +
            `step fanned out over (last: ${step.path(lastParentId)}). Either that path is wrong for ` +
            `this account or the whole ${step.parent} collection was deleted mid-run — refusing to ` +
            `record an empty ${step.name} as a complete resource.`,
        )
      }
      if (missing > 0) {
        record.missing_parents = missing
      }
      if (refused > 0) {
        record.skipped_reason =
          refused === parents
            ? `Harvest returned ${refusedStatus} for all ${parents} ${step.parent} — ${step.name} is not enabled on this account`
            : `Harvest returned ${refusedStatus} for ${refused} of ${parents} ${step.parent} — those ${step.name} are not in this snapshot`
        log(`${step.name}: ${record.skipped_reason}`)
      }
    }

    // Harvest states the size of every collection it paginates, and that tally is
    // the only witness to this sweep from outside: `count` is the rows we wrote,
    // which agrees with itself whether the sweep ran to the end of the collection
    // or stopped at the first `links.next: null` that should not have been null.
    // Recorded for `verify` (§6) either way, and said out loud when they disagree.
    // None of this applies to an incremental pass — `sweep` never tallies
    // total_entries for one (see above), so `record.total_entries` here is still
    // whatever the last full sweep left it at, and comparing it to a cumulative
    // `count` that now includes incremental rows would misread every incremental
    // pass as a truncation.
    if (
      !record.incremental &&
      record.total_entries !== null &&
      record.total_entries !== record.count
    ) {
      const gap = record.total_entries - record.count
      // Rows created or deleted *while* the sweep ran move the tally either way by
      // a little, and that is the only benign reading. A shortfall past that is the
      // sweep having stopped early — the same permanent truncation this file
      // refuses to accept from a child parent, and refusing it there while logging
      // it here would be an inconsistency, not a judgement call. Marking the step
      // complete stamps updated_since, which puts the missing rows out of reach of
      // every later incremental pass.
      log(
        `WARNING: ${step.name} — Harvest reported ${record.total_entries} entries and the snapshot ` +
          `holds ${record.count} rows (${gap > 0 ? `${gap} short` : `${-gap} over`}). Rows created or ` +
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
    // An incremental pass has no total_entries to fall short of — exhausting its
    // (filtered) cursor is the whole of what "complete" means for one.
    const short =
      !record.incremental && record.total_entries !== null && record.count < record.total_entries

    record.complete = !short
    record.finished_at = now().toISOString()
    if (record.complete) {
      // The watermark is the time *before* this pass's first request, never
      // after: a row updated while the sweep was running must be re-read next
      // time, not stepped over because the clock had already moved past it.
      // `record.started_at`, not the local `startedAt` — resuming an interrupted
      // pass keeps the *original* pre-crash timestamp there (see above), and a
      // watermark stamped from the later resume time would step over any row
      // updated in the gap between the crash and the resume.
      manifest.updated_since[step.name] = record.started_at
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
          .map(([name, r]) => `${name} holds ${r.count} of ${String(r.total_entries)} entries`)
          .join('; ') +
        `. Every other resource is on disk and manifest.json records which ones fell short; ` +
        `finished_at is left null and their watermarks unstamped, so a re-run sweeps them again. ` +
        RESUME_GUIDANCE,
    )
  }

  manifest.finished_at = now().toISOString()
  await persist()

  // The limiter, not the page tally, is what the account's rate budget actually
  // saw: it counts retries, and it counts the requests an optional step spent
  // being refused.
  return { resources, requests: limiter.granted, durationMs: Date.now() - startedMs }
}
