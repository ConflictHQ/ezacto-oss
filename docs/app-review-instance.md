# Mobile App Review self-hosted instance

The iOS/Android app connects to customer-operated eZacto servers. This deployment
is one self-hosted test instance for reviewing that client; it is not a hosted
service offering. Private issue #964 tracks its end-to-end acceptance.

## Fixed boundaries

| Resource                        | Identity                                                  |
| ------------------------------- | --------------------------------------------------------- |
| Host                            | `review.ezacto.io`                                        |
| Worker and D1 database          | `ezacto-app-review`                                       |
| R2 bucket                       | `ezacto-app-review-attachments`                           |
| Email queue / dead-letter queue | `ezacto-app-review-email` / `ezacto-app-review-email-dlq` |
| GitHub environment              | `app-review`                                              |

This is the bounded exception to the two regular deployment targets. No
per-branch previews or arbitrary deployment-name input. `deploy-app-review.yml`
is manual and main-only, runs the shared verification gates, and renders the
existing prod template with fixed review identities. `workers_dev` stays false;
`DEMO_MODE` is absent, so uploads work and nightly demo resets do not run.
The dev and normal prod workflows/configuration retain their existing targets.

The database, bucket, queues, passwords and signing key must be separate from
both real books and the public demo. Use fictional records only. Authentication
is required for business records and attachments. No email, OIDC, payment
integration, or Sentry credentials are inherited from other environments.

The review payload explicitly sets the official native app audience
`APPLE_CLIENT_ID=com.ezacto.app`. This public identifier cannot be overridden by
inherited environment values. It does not enable browser Apple sign-in or install
an Apple private key. The canonical instance origin remains
`https://review.ezacto.io`; Apple credential custody stays in the separate
first-party service. The workspace's normal sign-in and provisioning policies
still apply.

## Provision and operate

Create the `app-review` GitHub environment with three separately generated secrets:
`REVIEW_CURSOR_SIGNING_KEY` (32 random bytes in canonical base64url),
`REVIEW_BOOTSTRAP_TOKEN` (the existing `ezacto_<16>_<43>` token format), and
`REVIEW_OWNER_PASSWORD` (24–128 non-whitespace characters). Repository Cloudflare
credentials must allow the existing D1, R2, Queues and Worker provisioning actions
and the `ezacto.io` zone. Keep the private operator copy outside git with mode 600;
never publish passwords/tokens in issues, logs, artifacts or recordings.

Dispatch `deploy-app-review.yml` from main. It resolves one exact D1 name, renders
the production template in the ephemeral checkout, provisions exact queue/bucket
names, and refuses assumed R2 existence. An existing migration ledger must match
this source before upgrade; the runtime applies migrations to a fresh database.
The bootstrap guard is installed before deployment. Exact retries enroll the
fictional administrator `reviewer@ezacto.example`, then verify password sign-in,
API-token access, cookie flags, logout revocation and anonymous access denial.
Only successful verification removes the temporary bootstrap endpoint secret;
a failed enrollment leaves the first-run guard in place for an operator retry.
The owner API token remains a private administrative credential.

Preserve these credentials across redeploys: bootstrap refuses mismatched owner
state or password. The workflow does not wipe/reset data. Once the review starts,
keep its source and fixture data stable and do not redeploy without a reason.

## Acceptance after deployment

Deploy the compatible native lifecycle backend before testing newer mobile builds.
As an administrator, enable Apple in the instance's sign-in policy and verify
`GET /auth/apple/native-capabilities` reports
`{available:true,lifecycle_version:1}`. A configured audience alone is not proof
of compatibility or successful Apple authentication. Use a separately authorized
disposable Apple identity under the normal invitation/provisioning rules to test
sign-in, account closure and provider cleanup. Keep the stable password-based
reviewer login and administrator recovery access intact. Verify the public
credential-service disclosure before the native Apple prompt.

Populate synthetic clients, projects, time, invoices and expenses through the
normal API. Establish a stable reviewer login and a separate disposable account
for deletion. Verify the submitted native build can sign in and use these records.
Verify receipt upload, duplicate retry, authenticated exact-byte download and
anonymous denial. Demonstrate deletion request and administrator fulfilment using
only the disposable identity. No mail provider is configured: do not promise an
email was sent when only a request was recorded.

Place the private reviewer credentials in App Store Connect, not in this repo.
Record the exact server source, mobile build, physical-device OS and successful
QA evidence in the mobile review notes. The deployment workflow passing alone
does not satisfy this acceptance list or authorize a claim that Apple can review
all features.

Keep this instance available throughout App Review. After review and any appeal,
retire it through an explicit operator cleanup: verify the fixed resource names,
remove its custom domain and Worker, then its queue/DLQ, R2 objects/bucket and D1
database; revoke the environment credentials. Do not delete by a broad prefix or
remove any normal dev/prod resources. Cleanup is deliberately not automatic.
