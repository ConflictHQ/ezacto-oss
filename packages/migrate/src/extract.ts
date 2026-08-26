// `ezacto-migrate extract` — Harvest account → snapshot dir (migration-spec §2).
//
// Walks RESOURCES in FK-safe order, appends every page to raw/<resource>.jsonl
// verbatim, and rewrites manifest.json after each page. The ordering there is
// load-bearing and never the other way round: rows hit the disk before the
// manifest claims them, so a crash under-claims (worst case: one page re-fetched)
// instead of over-claiming (worst case: a snapshot that lies about its contents).
//
// This story writes the resume record. It does not yet read it back to skip
// completed work — resuming mid-resource is its own story, with its own kill -9
// acceptance test.

import { visibilityWarning } from './auth.js'
import type { HarvestEnv } from './env.js'
import type { HarvestApiError, HarvestClientConfig } from './harvest-client.js'
import { appendPage, readIds, startResource } from './jsonl.js'
import { readManifestIfExists, writeManifest, type ManifestResource } from './manifest.js'
import { paginate, type PaginateDeps } from './paginator.js'
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

  // The same warning auth raises, re-raised from the manifest before the first
  // request: a member-scoped PAT produces a snapshot that is a fraction of the
  // account and looks, from its exit code, exactly like a complete one.
  const warning = visibilityWarning(manifest.preflight.user)
  if (warning) log(warning)

  const config: HarvestClientConfig = {
    pat: env.pat,
    userAgentEmail: env.userAgentEmail,
    accountId: manifest.account.id,
    baseUrl: options.baseUrl,
    timeoutMs: options.timeoutMs,
  }

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

  // One limiter for the whole run: the budget is per account, not per resource.
  const limiter = createRateLimiter({ sleep })
  const deps: PaginateDeps = { limiter, sleep, log }

  const resources: Record<string, ManifestResource> = { ...manifest.resources }

  const persist = async (): Promise<void> => {
    manifest.resources = resources
    await writeManifest(snapshotDir, manifest)
  }

  for (const step of RESOURCES) {
    const startedAt = now().toISOString()

    if (!enabled(step)) {
      resources[step.name] = {
        count: 0,
        pages: 0,
        requests: 0,
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
      pages: 0,
      requests: 0,
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
        await persist()
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
      for await (const parentId of readIds(snapshotDir, step.parent)) {
        try {
          await sweep(step.path(parentId), undefined, 0, parentId)
        } catch (err) {
          // An optional step is one we can only discover by being refused —
          // teammates is gated by company.team_feature, which /v2/company does
          // not report. A refusal is an answer about the account, not a failure.
          if (step.optional && isApiError(err) && (err.status === 403 || err.status === 404)) {
            // The refusal cost a request against the budget even though it
            // yielded no page — the manifest's cost record has to say so.
            record.requests += 1
            record.skipped_reason = `Harvest returned ${err.status} for ${step.name} — the feature is not enabled on this account`
            log(`${step.name}: ${record.skipped_reason}, skipping`)
            break
          }
          throw err
        }
      }
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
