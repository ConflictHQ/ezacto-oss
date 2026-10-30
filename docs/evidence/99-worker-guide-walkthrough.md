# Independent Worker operator walkthrough (#99)

Performed 2026-10-26 by an independent agent who did not author the Worker guide.
This is an actual disposable Cloudflare deployment, not a human acceptance claim.
Source: `df5ff432b6f8dbe8292fe95d3981d693a4f8d53e`. Node 22.21.1; Wrangler 4.131.1.
The [sanitized receipt](99-worker-guide-walkthrough.json) records exact resource
identities, observed results, current-evidence hash, and cleanup checks.

## Scope and isolation

Read `docs/self-host-worker.md`, `RESTORE.md`, the native bootstrap workflows,
and the linked Cloudflare Time Travel documentation before executing. Used a
separate checkout and a new `ezacto-guide99-proof-eacb12cd` resource family: one Worker, one D1,
one R2 bucket, four Queues (email/migration plus their dead-letter queues), one
scheduled-run Workflow, and a new custom domain. Every resource was created
for this run; no dev, production, review, hosted, or customer binding was used.

Existing Wrangler OAuth was used without changing credentials or adding scopes.
The DNS-record API returned 403. Preflight instead verified no exact custom-domain
record and no authoritative DNS answer; the new custom-domain ID was recorded.
Local negative DNS caching delayed fresh and reattached hostnames in earlier
attempts. The final run resolved only its exact hostname from the authoritative
Cloudflare nameserver, retaining normal HTTPS certificate verification and SNI.
No system DNS configuration, hosts file, or existing DNS record was changed.

The native `workflow-main.ts` entry was deployed without a proof shim or seeded
business database. First deployment had no public route, `workers_dev=false`,
and preview URLs disabled. A random bootstrap authority and separate cursor key
were installed atomically from a private secrets file before attaching the
custom domain. Signup returned 404 while bootstrap authority was active. No mail
or other provider credentials were configured; scheduled triggers remained off.

## Executed checks

- `npm ci` and the native web/API/client/CLI build sequence completed.
- Wrangler created all isolated resources and deployed the native entry.
- `/healthz` and `/readyz` returned 200 with the exact source revision; fresh D1
  migrated through `0172_csv_worker_staging`.
- Native bootstrap created one invented owner; exact retry was idempotent.
- Compiled `ez login --token-stdin` and `ez whoami` resolved the native administrator.
- Native owner-password enrollment and password sign-in succeeded. The session
  authenticated `/api/v1/whoami`; revoking it made the old cookie return 401.
- Temporary bootstrap authority was removed. A fresh password session still worked.
- Native API created a retained client, then a second client after a recorded D1
  Time Travel bookmark. Current SQL evidence was exported before rollback.
- Public routing and both Queue consumers were disabled before Time Travel;
  scheduled triggers were already disabled. The isolated database was restored
  in place and quarantined for review. The retained client existed and the later
  client did not. Current closure history was empty; no provider, mail, retention,
  or personal-data changes required replay in this synthetic instance.
- An invented R2 object retained identical bytes across the D1 rollback. This
  proves D1 rollback does not roll back R2, not a complete attachment restore.
- After recording reconciliation, the synthetic quarantine was released and a
  fresh Worker deployment restored the custom domain. Readiness and native
  password sign-in/administrator identity succeeded again.

## Guide friction corrected

The guide's `dev` template is the public demo. Merely renaming the Worker and
storage left `DEMO_MODE=true`; a real self-hosted installation must remove it or
set it false. The configuration instructions also omitted migration Queue/DLQ
names, `MIGRATION_QUEUE_NAME`, and the scheduled Workflow name. The guide now
names all of these and retains their binding names.

A successful upload is not readiness: DNS/certificate propagation and database
initialization are separate. The guide now checks both health and readiness and
points operators to offline recovery prerequisites. Cleanup must detach Queue
consumers before deleting the Worker; an initial cleanup refusal was resolved
and independently checked, rather than reported as success.

## Recovery limits and cleanup

`GET /api/v1/backup/status` correctly reported no completed backup, no failure,
and off-site backup disabled. This run did not trigger the nightly CSV writer,
restore a portable Worker bundle, use S3/GCS, or test provider email. The existing
Worker documentation still says its CSV bundle has no restore command. This
walkthrough also did not configure a GitHub deployment repository or exercise
its secret-driven Actions workflows; local Wrangler/native-bootstrap equivalents
were used. It does not replace human operator acceptance if that remains required.

All final resources were removed. Exact Worker, D1, R2, Queue, Workflow and
custom-domain IDs subsequently returned absent; authoritative A, AAAA and CNAME
answers were empty. The temporary secrets file was removed. Earlier failed or
partial attempts were also cleaned and verified; their native checks are not
substituted for the final completed run. Protected SQL evidence and local command
logs stay outside the repository; only the sanitized receipt is committed.
