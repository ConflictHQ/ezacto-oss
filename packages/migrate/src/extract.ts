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
import { appendPage, readIds, startResource } from './jsonl.js'
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

    if (!enabled(step)) {
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
        skipped_reason: `${step.requires ?? 'feature'} is false`,
        started_at: startedAt,
        finished_at: startedAt,
      }
      await persist()
      continue
    }

    const record: ManifestResource = {
      count: 0,
      total_entries: null,
      pages: 0,
      requests: 0,
      missing_parents: 0,
      next_url: null,
      parent_id: null,
      pass: 0,
      complete: false,
      skipped_reason: null,
      started_at: startedAt,
      finished_at: null,
    }
    resources[step.name] = record
    await startResource(snapshotDir, step.name)
    await persist()

    /** Consume one sweep, checkpointing after every page. */
    const sweep = async (
      path: string,
      params: Record<string, string> | undefined,
      pass: number,
      parentId: number | null,
    ): Promise<void> => {
      // Every page of one sweep repeats the same tally, so it is taken once and
      // added to the resource's — a resource is one sweep per pass, per parent.
      let tallied = false
      try {
        for await (const page of paginate(
          { resource: step.name, path, collection: step.collection, params },
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
          if (!tallied) {
            tallied = true
            if (page.totalEntries !== null) {
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
      for (const [pass, extra] of passes.entries()) {
        await sweep(step.path, { ...step.params, ...extra }, pass, null)
      }
    } else {
      const parentCount = resources[step.parent]?.count ?? 0
      log(
        `${step.name}: fanning out over ${parentCount} ${step.parent} ` +
          `(~${parentCount} requests, ~${budgetSeconds(parentCount)}s at the budget)`,
      )
      let parents = 0
      let refused = 0
      let refusedStatus = 0
      let missing = 0
      let lastParentId = 0
      for await (const parentId of readIds(snapshotDir, step.parent)) {
        parents += 1
        lastParentId = parentId
        const pagesBefore = record.pages
        try {
          await sweep(step.path(parentId), undefined, 0, parentId)
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
    if (record.total_entries !== null && record.total_entries !== record.count) {
      log(
        `WARNING: ${step.name} — Harvest reported ${record.total_entries} entries and the snapshot ` +
          `holds ${record.count} rows. Rows created or deleted while the sweep was running explain a ` +
          `small gap; a large one means the sweep stopped early — check raw/${step.name}.jsonl before loading.`,
      )
    }

    record.complete = true
    record.finished_at = now().toISOString()
    // The watermark is the time *before* this step's first request, never after:
    // a row updated while the sweep was running must be re-read next time, not
    // stepped over because the clock had already moved past it.
    manifest.updated_since[step.name] = startedAt
    await persist()

    log(
      `${step.name}: ${record.count} rows, ${record.pages} pages, ${record.requests} requests` +
        (record.missing_parents > 0 ? `, ${record.missing_parents} missing parents` : '') +
        (record.skipped_reason ? ` (${record.skipped_reason})` : ''),
    )
  }

  manifest.finished_at = now().toISOString()
  await persist()

  // The limiter, not the page tally, is what the account's rate budget actually
  // saw: it counts retries, and it counts the requests an optional step spent
  // being refused.
  return { resources, requests: limiter.granted, durationMs: Date.now() - startedMs }
}
