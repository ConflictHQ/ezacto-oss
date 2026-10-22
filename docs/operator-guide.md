# Operator guide

Set up and operate an eZacto instance: identity, email, error reporting, accounting and payments. Start with the deployment you actually run, then follow the provider guide. Configuration belongs to the instance operator; ordinary workspace users do not need provider credentials.

## Start here

1. Install [Cloudflare Workers](self-host-worker.md) or the [container](self-host-container.md), choose the canonical HTTPS application URL and establish an administrator login.
2. Confirm [backup and restore](../RESTORE.md) before connecting a real company's books.
3. Configure [transactional email](email-setup.md) and [error reporting](sentry-setup.md).
4. Configure a sign-in provider and test it in a second browser before disabling the current administrator's working sign-in method.
5. Connect payment/accounting providers to the intended account. Separate configuration checks from actions that send invoices or move money.

## Setup guides

| Job | Guide | What a successful setup proves |
| --- | --- | --- |
| Apple identity | [Sign in with Apple](apple-setup.md) | Compatible mobile/server releases sign in an allowed user; browser rollout has separate requirements |
| Google identity | [Google sign-in](google-sign-in-setup.md) | The exact callback returns to this instance and creates the expected session |
| Error reporting | [Sentry](sentry-setup.md) | Errors arrive in the intended project/environment with the right release |
| Transactional email | [Email](email-setup.md) | A controlled message reaches its intended inbox through the configured transport |
| Accounting mirror | [QuickBooks Online](quickbooks-setup.md) | The correct realm is connected and a sandbox invoice/payment round trip reconciles |
| Contractor payouts | [Wise](wise-setup.md) | The paying profile and verified destinations are correct; payment execution is separately approved |
| Invoice collection | [Stripe](stripe-setup.md) | A test invoice payment reaches the verified webhook and is recorded once |
| Invoice delivery and reconciliation | [BILL](bill-setup.md) | The right company is configured and an opted-in test client reconciles |
| Credential deployment | [Integrations: where the keys go](integrations.md) | The selected runtime receives the intended configuration through its deployment process |
| Daily payment operations | [Staff payments](staff-payments.md) | The operator understands approvals, scheduling, uncertain outcomes and reconciliation |
| Storage and recovery | [Attachment storage](attachment-storage.md), [backup and restore](../RESTORE.md) | Durable files and a recoverable database exist independently of a running process |

These guides cover the OSS application. Hosted subscription billing, marketing analytics, beta admission and the hosted router have separate operators and deployment configuration. A provider name in the data model or an adapter package does not mean a deployable connection exists: for example, do not invent PayPal or Mercury setup variables (`DEEL_TOKEN` and `DEEL_SYNC_START_DATE` are real, but only for the Deel time sync in [Integrations](integrations.md)) from their appearance in payment history. GitHub login exists in the API, but its credential pair is not wired through the current stock Worker deploy workflow or container config parser; enabling it needs an explicit deployment change.

## Readiness record

For each environment, record the deployed commit/image, canonical URL, provider account/project identifier, credential **names**, operator, last verification time and the evidence location. Keep the values of credentials, authorization codes, payment details and personal test data out of that record. Track these states separately:

- **Configured:** the runtime has the necessary values.
- **Connected:** the provider authenticated and the account identity matches.
- **Verified:** the relevant end-to-end check succeeded.
- **Enabled:** people can actually use the feature under instance policy.

The [security guide](security.md) explains why a configured sign-in method can still be disabled. Likewise, a Wise connection does not prove that a transfer was paid, and a QuickBooks connection does not prove that the background mirror is draining.

## Change, rotate and disable

Update the authoritative environment secret store, deploy through CI, verify the new connection, then retire the old provider credential when the provider supports overlap. Preserve the previous deployment reference and non-secret configuration for rollback. A revoked provider credential cannot be restored by rolling application code back.

Before disconnecting a money provider, review pending invoices, scheduled payments and uncertain transfers with their operator. Preserve provider IDs and audit records for reconciliation. Before disabling an identity provider, verify another working administrator login. Disabling a login method is separate from deleting an account or revoking provider grants.

## Archive a finished year of the activity log

The activity log is append-only and nothing in it is ever deleted. Once a year has finished, an administrator can move the live log into its own archive table from Settings > Activity ("Archive a finished year"). The roll is an operator action, never a schedule: the page offers it, and it runs only when you confirm. It renames the live table to `activity_log_<year>`, keeps every guard on the archive, starts a fresh live table, and records itself in the log as `activity_log.rolled`, all in one transaction. Archived entries still appear in the log, the export and the backup bundle.

The archive takes everything recorded up to the moment of the roll, so entries from the first days of the new year travel with it if you roll late. The current year and a year that was already rolled are refused. The roll needs an administrator session; an API token cannot run it. On Cloudflare D1, take a Time Travel bookmark first, as for any schema operation.

## Troubleshooting order

Check the deployment/environment first, then its configuration status, provider permissions, exact callback or webhook URL, and finally the request ID and provider logs. A `401` from eZacto may mean the operator session expired; a provider `401` means something different. Never paste tokens or complete webhook payloads into public issues.

Vendor setup instructions were checked on 2026-10-09. The named source files in each guide are the implementation reference; verify your release before following steps for a newer version.

## Monthly job definitions and proposed manifests

Administrators can configure month-end pack jobs through the session-only API.
The cadence uses the organization's time zone. A monthly expression is
`M H D * *`: minute 0–59, hour 0–23, day 1–31. A day absent from a month is
skipped. The minute cron (Worker) or maintenance tick (container) catches up the
current monthly occurrence once its scheduled clock has passed; it does not
create a backlog for older missed months.

From a signed-in administrator's browser console, create a job with the actual
client IDs it should cover:

```js
const response = await fetch('/api/v1/scheduled-jobs', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    name: 'Monthly client work detail',
    action: 'month_end_pack',
    scope: { client_ids: [1] },
    cadence: '0 9 1 * *',
    confirmation: 'required',
    confirm_within_minutes: 1440,
  }),
})
const { data: job } = await response.json()
```

An empty `client_ids` list covers all clients. A job proposes the preceding
calendar month's eligible invoices with their concrete client, amount/currency,
recipient and claimed rounded hours (null when the invoice claims no time),
plus each named person's hours in the exact saved report.
Reports must render before a proposal is stored. The proposal and all its items
are committed together, so a failed item leaves no partial manifest. Overlapping
ticks cannot materialize the same job/month twice. Nothing becomes confirmed or
executes merely because a tick ran or a deadline passed.

List jobs at `GET /api/v1/scheduled-jobs` (cursor-paginated), or read one at
`GET /api/v1/scheduled-jobs/:id`. `last_error` explains an empty, malformed or
unrenderable occurrence; `last_checked_at` and `last_run_id` show its latest
inspection and proposal. One failed job does not stop other jobs from proposing.
Read a materialized manifest at `GET /api/v1/scheduled-runs/:id`; this also
provides its state, deadline and confirmation attribution.

Update or pause against the version just reviewed:

```js
await fetch(`/api/v1/scheduled-jobs/${job.id}`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ expected_version: job.version, is_active: false }),
})
```

A stale version returns 409; refresh before choosing a new change. Pausing stops
new proposals. Existing manifests retain their concrete items and original
confirmation deadline when a job is edited. A paused or changed job cannot
commit a proposal from a stale configuration already being rendered. Job
configuration requires an active administrator session; API tokens cannot create,
change or read these definitions. Month-end jobs always require confirmation.

This release supplies definition, proposal, administrator review notices,
authenticated confirmation, durable dispatch and expiry handling. Creating a job
does not authorize client email or initiate a payment.

### Review notices and authenticated answers

A due proposal sends a concrete manifest notice to each active administrator with
a verified primary email, using the deployment sender and the normal durable
Mailer queue. A notice lists the captured client, hours, amount/currency and
recipient for each item, the deadline, and `/scheduled-runs/<id>`. Queue retries
reuse the recorded delivery; they do not compose another notice for that run and
person. Configure email and the application base URL to enable notices.

The email URL carries a signed, single-use review credential in its fragment.
It expires at the proposal's original deadline and is bound to the intended
administrator, run and instance signing key. The browser removes it from the URL
before sign-in, retains it only in memory, and submits it by authenticated POST
after the administrator signs in. It is never sent in a query string, referrer,
browser storage or GET request. The token hash and expiry are committed in the
same transaction as the notification and email-log receipt; queue recovery sends
the original recorded message instead of minting another link.

This credential records only an authenticated opening. It grants no sign-in,
confirmation, cancellation or execution authority. GET requests never spend it; spending requires a POST from the intended active
administrator session. A second
opening or an opening at/after the deadline is refused by the link endpoint. The
canonical `/scheduled-runs/<id>` subject remains readable with an administrator
session, including after a link was used or expired, so audit bookmarks remain
useful. A stale email link explains its state and shows only the record that the
current session is already allowed to read.

Confirm or Cancel remains a separate explicit authenticated POST. The decision
is single use: repeat confirmation returns the original decision, and expiry or
cancellation cannot become confirmation. Opening or replaying a review link never
answers the run. The instance uses its cursor-signing secret with a separate
review-link signing context; rotating that secret invalidates old review links.
Older emails without a review fragment remain ordinary authenticated subject
bookmarks and never gain action authority.

The manifest screen shows each captured item and its recorded result. If an
answer's response is lost, refresh before trying again; the screen reloads the
server's state instead of assuming the answer failed.

### Saved reports, delivery and recovery

Each proposal saves its exact PDFs in the attachment store before it becomes
answerable. Use **Review saved PDF** beside an item to inspect that document.
Changing a report brand, notes or live time afterwards does not replace the saved
PDF. Report-note warnings are captured with it; when warnings exist, confirmation
requires an explicit acknowledgement on the review screen. The acknowledgement is
recorded with the administrator and the original confirmation time.

After confirmation, the Worker minute cron starts a Cloudflare Workflow for the
captured proposal. Each checkpoint dispatches a bounded item batch; durable
one-minute sleeps separate retry passes. The container maintenance queue calls the
same executor and receipts. A Workflow restart cannot repeat completed items.
Cron checks at most ten eligible runs per pass in oldest-checked order, so a
control-plane failure cannot indefinitely starve later proposals. Workflow IDs
include proposal identity and retry-budget generation: an explicit failed-item
retry creates a new instance, and a nightly demo reset cannot reuse an old one.
Errored instances may restart; cron respects an operator's pause or termination.
The binding is `SCHEDULED_RUN_WORKFLOW`, exported class `ScheduledRunWorkflow`;
Wrangler provisions the named Workflow with the Worker deployment. Older unbound
installations retain direct minute-cron dispatch until they adopt this config.

For both runtimes, each item owns a 15-minute lease. Another executor cannot
enter it while the lease is live, and a recovered lease cannot be settled by the old executor.
Automatic attempts stop after three failures or interruptions. The manifest names
the failed item and its reason. **Retry failed items** authorizes another bounded
window for exhausted failures only; it never repeats a completed item. The same
control is `POST /api/v1/scheduled-runs/:id/retry`, with an administrator session.

Before queue handoff, the dispatcher records an immutable delivery intent, sender
binding and attachment identity. An interrupted handoff reuses those identities
and the captured recipient instead of composing another message or adding another
attachment. A changed invoice recipient or a closed invoice is refused before a
new intent is recorded. A missing or changed artifact is refused; restore the
original artifact rather than replacing what was reviewed. Sender configuration
must remain valid for the recorded binding when a queued handoff is retried.

**Complete** means every item was handed to the mail queue. The per-item delivery
status separately shows queued, sent or failed provider delivery. A scheduled pack
sends work detail; it does not mark an invoice paid or initiate a transfer. The
activity log records proposal, attributed confirmation/cancellation, expiry,
per-item attempts/results, retry authorization and completion. These events and
their subject links are administrator-only.

The Worker needs configured attachment storage and organization email delivery;
the container uses its normal disk attachment store and SMTP sender. Saved reports are registered as file objects; retain the instance's attachment
store with its database when backing up or restoring.
Older proposals without saved reports remain readable but are never silently
rendered and sent by the dispatcher. Pause their old job and create a replacement
job with the reviewed scope, then review and confirm its newly captured proposal;
cancel an older unconfirmed proposal. A legacy confirmation with no captured PDF
remains a named failed item rather than an invented delivery.

### Off-site backup visibility

Company → Backups labels L1 (the R2 logical export) and L2 (the verified encrypted
S3-compatible copy) separately. A successful L1 does not imply an L2 copy exists.
Progress, the last completed copy and actionable E14 failures come from durable
receipts. **Check off-site destination** verifies an encrypted probe with the
configured credentials; it does not create a backup. Configure the dedicated
deployment secrets and retain the encryption key as described in RESTORE.md.
Worker logical copies exclude attachment bytes and do not replace physical/SQL
recovery. Self-hosted container operators schedule the existing CLI bundle copy.
