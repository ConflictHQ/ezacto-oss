# Sentry: error reporting for operators

The Cloudflare Worker includes optional Sentry error reporting. It is off until `SENTRY_DSN` is configured. The current container and browser application do not acquire Sentry instrumentation just because you set that variable.

## Create the project and configure CI

1. Create or select the intended Sentry organization and a Cloudflare/JavaScript project. Use [Sentry's Cloudflare guide](https://docs.sentry.io/platforms/javascript/guides/cloudflare/) to locate its client key/DSN; the SDK is already integrated in eZacto.
2. Save the DSN as the GitHub **environment secret** `SENTRY_DSN` for the Worker deployment (`dev` or `prod`). This enables runtime delivery. Do not substitute a Sentry API auth token for the DSN.
3. For readable release stack traces, set the environment **variables** `SENTRY_ORG` and `SENTRY_PROJECT` to their slugs and the environment **secret** `SENTRY_AUTH_TOKEN` to a Sentry token authorized for the release/source-map operations used by your project. Consult [Sentry CLI configuration](https://docs.sentry.io/cli/configuration/). This token is used by CI, not shipped to the Worker or browser.
4. Deploy through the normal application workflow. Inspect both the deployment and **symbolicate — give Sentry the source maps** steps. The latter is optional and allowed to fail; a green deployment by itself does not prove successful symbolication.

| Setting | Destination | Purpose |
| --- | --- | --- |
| `SENTRY_DSN` | Worker runtime secret | Error ingestion project |
| `SENTRY_ORG`, `SENTRY_PROJECT` | CI environment variables | Source-map upload destination |
| `SENTRY_AUTH_TOKEN` | CI environment secret | Authorization to manage release artifacts |
| `ENVIRONMENT` | Runtime deployment configuration | Distinguishes development and production |
| `RELEASE` | Set by deployment to the Git commit SHA | Joins runtime errors to the uploaded release |

The workflow bundles source maps and uploads them for that commit. It does not need a second SDK installation or a browser tracking script. Source maps can contain application source; restrict project access accordingly.

## Verify delivery separately from source maps

In a development/test deployment, use a controlled, non-sensitive failure in a test-only route or inspect a known error already produced by the application. Do not create a public production crash endpoint or provoke a live payment to test monitoring. Confirm the event's project, `environment`, `release`, timestamp and stack trace in Sentry. For API failures carrying a `request_id`, correlate it with the UI/API response and Worker log.

The repository's local regression check uses a fake DSN and intercepts all outbound envelopes:

```sh
npm exec -w ezacto-worker -- vitest run test/payment-sentry.test.ts
```

That proves SDK wiring and request-ID propagation without sending an event to Sentry. Record an actual provider event separately before calling a deployment's delivery verified.

Runtime defaults are `sendDefaultPii: false` and `tracesSampleRate: 0`: error reporting, with tracing disabled. These settings are not a guarantee that error messages contain no personal data. Review Sentry scrubbing, access, retention and representative events before production use. Session replay and marketing analytics are separate integrations.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No events | Correct environment secret, actual redeploy, project DSN, outbound access and Sentry quota/filters |
| Events exist but stacks are unreadable | Upload step ran successfully, token permissions, org/project slugs and exact matching release SHA |
| Upload reports invalid token | The saved token was not truncated at an `=` character; re-enter it through secure stdin rather than splitting it |
| Production events show under development | Runtime `ENVIRONMENT`, selected GitHub environment and deployment target |
| Only some failures arrive | Handled validation/authentication responses are not necessarily exceptions; compare the relevant error-reporting path |

For rotation, replace the relevant secret, deploy, and verify before retiring the old credential where overlap is supported. For disablement, remove `SENTRY_DSN` from the authoritative environment and redeploy; remove the CI upload token if uploads should also stop. Previously collected events remain subject to the project's retention/deletion controls.

Implementation reference: `entries/worker/src/index.ts`, `entries/worker/src/app.ts`, `entries/worker/src/runtime.ts`, `scripts/render-deploy-secrets.mjs`, `.github/workflows/deploy.yml`.
