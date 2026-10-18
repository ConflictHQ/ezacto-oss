# Transactional email: operator setup

Email carries sign-in links, password recovery and application messages. Verify it before depending on emailed authentication. The Worker and container use different transports; a verified sender alone does not prove delivery.

## Cloudflare Worker: Amazon SES

1. Choose the AWS region that will send mail. Create and verify the sending domain/identity there, publish its DNS authentication records, and configure the intended configuration set and delivery-event destinations. Follow [SES identity verification](https://docs.aws.amazon.com/ses/latest/dg/verify-addresses-and-domains.html).
2. Check sandbox status in that region. Sandbox accounts restrict recipients; identity verification does not remove that restriction. Use verified recipients or the mailbox simulator for testing, then request production access through AWS. [SES regional requirements](https://docs.aws.amazon.com/ses/latest/dg/regions.html) apply independently to failover regions.
3. Provide the runtime's AWS credentials with the required SES sending permission for that identity. Store `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and, for temporary credentials, `AWS_SESSION_TOKEN` as GitHub environment secrets. Arrange rotation before temporary credentials expire.
4. Set GitHub environment variables `SES_REGION`, `SES_FROM` and, if used, `SES_CONFIGURATION_SET`. The first four required values are the access key, secret key, region and sender; a partial SES configuration is rejected.
5. Deploy through CI. Confirm queue/scheduler bindings and an approved organization sender, then send one controlled message to an operator-owned inbox. Check actual inbox receipt and provider delivery/bounce evidence as well as application queue state.

The Worker also supports Mailgun: `MAILGUN_API_KEY` is a secret, with `MAILGUN_DOMAIN`, `MAILGUN_REGION` and `MAIL_FROM` as deployment variables. Configure exactly one Worker transport. The secret renderer rejects simultaneous SES and Mailgun configuration; it does not select a provider silently.

## Container: SMTP

Set `SMTP_URL` and `SMTP_FROM` in the private container environment. Use your provider's authenticated SMTP endpoint, credentials and TLS requirements; see [container setup](self-host-container.md). If SES provides the SMTP endpoint, use its SMTP credentials rather than treating the Worker AWS API credentials as interchangeable with an SMTP password.

Restart/redeploy the container after configuration changes. Verify its scheduler is running so queued messages are processed. Test inbox delivery with an operator-owned recipient and confirm the configured sender is the one the organization intends to use.

## Mail the instance sends its own people

Three kinds of mail go from the instance to the people who work in it, on the
same deployment sender and queue as the sign-in mail. Each one is recorded in
the email log (Settings, Deliveries) and, on the public demo, held to the
domains the demo may email.

| Mail | Who gets it | When |
| --- | --- | --- |
| Budget alert | The project's managers; administrators too when Company settings, Notifications says so, or when the project has no manager with an address | Once each time a project with "Notify when over budget" crosses its threshold. Checked every minute. |
| Daily time reminder | People who switched it on (Settings, You), by email | On their chosen days at their chosen time on their own clock, only if they have tracked less than a usual day (weekly capacity over the chosen days; a running timer counts) |
| End-of-week submission reminder, and the manager digest | Everyone not opted out; people who approve timesheets and asked for it | Only while the Approval module is on and an administrator has set a day and time under Company settings, Notifications. About last week on a Monday to Thursday, about the week now ending after that. |

Every decision is written to `notification_deliveries` before anything is
queued, keyed by (kind, person, scope, period), so a retried event or a sweep
that runs twice mails nobody twice. A reminder that is more than two hours
late is skipped, not sent. A message the queue never picked up is queued again
from its record. The Worker does this on the minute cron; the container on its
outbox tick, at most once a minute. A deployment with no sender (`MAIL_FROM` on
the Worker) records budget alerts in the activity log and sends nothing.

## Authentication and sender checks

Email sign-in also requires `MAGIC_LINK_SIGNING_KEY`; configuring a transport alone does not enable every authentication route. Check Ways in and retain a working administrator recovery method while testing. For Apple relay recipients, follow [Apple sender registration](apple-setup.md) too.

Where organization sender approval/attestation applies, changing the deployment's sending address can invalidate the old approval. Review the sender state rather than retrying delivery indefinitely. The public demo can further restrict recipient domains; an application acceptance is not proof that demo mail was sent externally.

| Symptom | Check |
| --- | --- |
| Provider accepts but inbox is empty | Delivery/bounce events, recipient suppression, spam folder and sender authentication |
| SES rejects an address | Region, verified identity, sandbox recipient restriction, permissions and sending status |
| Messages stay queued | Queue consumer/scheduler, retries, dead-letter state and provider error |
| SMTP authentication fails | Correct SMTP credential type, endpoint, port and TLS settings |
| Mail stopped after credential rotation | New values actually deployed; temporary AWS session token rotated with its key pair |

For a transport change, review queued mail, prepare and verify the new sender, then switch the complete configuration through CI. Preserve message/audit history and account for retries before sending manual replacements. Removing a transport will affect login recovery and queued messages; it is an operational change, not just a UI preference.

Implementation reference: `scripts/render-deploy-secrets.mjs`, `entries/worker/src/runtime.ts`, `entries/container/src/config.ts`, `packages/mailer/`.
