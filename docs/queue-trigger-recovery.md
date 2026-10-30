# Queue-consumer partial deployment recovery

The regular dev/prod workflow uploads Worker code once. Wrangler can then fail
while applying triggers, leaving the new code live and some trigger changes
already applied. A failed deployment is not evidence that the previous release
is still serving.

`scripts/deploy-worker-with-trigger-recovery.mjs` recognizes only the observed
Wrangler partial-update diagnostic whose entire failure list consists of Queue
consumer API requests returning Cloudflare `10013`. After five seconds it runs
`wrangler triggers deploy` once against the same environment and rendered default
configuration. It does not repeat the code upload or secret installation. Mixed
trigger failures, other API codes, authentication failures, interrupted commands,
and an isolated `10013` outside this diagnostic do not qualify.

If recovery fails, the step remains failed and explicitly reports that code may
already be live, triggers may remain partially updated, and successful changes
were not rolled back. Inspect the reported failures and reconcile the configured
resources before accepting a release. The wrapper does not claim rollback.

A successful recovery still must pass the existing deployed Queue/R2 binding
acceptance, exact release smoke check, migration verification where applicable,
and deployed demo acceptance. Those gates remain after the deployment step.

## Investigation and verification

Issue [#1205](https://github.com/ConflictHQ/ezacto-pvt/issues/1205) records two
first-attempt failures, both followed by successful unchanged reruns:

- Dev run `39980867286`, attempt 1, deployment job `120507588400`.
- Prod run `40018744418`, attempt 1, deployment job `120637586389`.

Their retained job logs identify the Queue consumer endpoint, `10013`, and the
partial-update/no-rollback diagnostic. They do not expose a Cloudflare request
ID sufficient for a new upstream incident report.

The [upstream Wrangler changelog](https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/CHANGELOG.md)
from 4.131.1 through 4.152.0 has no identified fix for this consumer-update
failure. Queue subscription/jurisdiction features, Workflow changes and asset
upload retries address other paths. This change retains the existing locked
Wrangler version. Cloudflare documents the separate
[`triggers deploy` command](https://developers.cloudflare.com/workers/wrangler/commands/workers/#triggers-deploy);
the locked 4.131.1 implementation calls the same Queue-consumer updater from
that command without uploading another Worker version.

Local tests use synthetic diagnostics and executable child processes to prove
the bounded recovery and refusal cases. They do not establish Cloudflare's
underlying cause or reproduce a live provider incident. Repeated live consumer
updates and an upstream incident report with a provider request ID remain
separate acceptance work; no production writes were used for this investigation.
