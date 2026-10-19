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

These guides cover the OSS application. Hosted subscription billing, marketing analytics, beta admission and the hosted router have separate operators and deployment configuration. A provider name in the data model or an adapter package does not mean a deployable connection exists: for example, do not invent `DEEL_TOKEN`, PayPal or Mercury setup variables from their appearance in payment history. GitHub login exists in the API, but its credential pair is not wired through the current stock Worker deploy workflow or container config parser; enabling it needs an explicit deployment change.

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
