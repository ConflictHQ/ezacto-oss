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

Runtime defaults remain `sendDefaultPii: false` and `tracesSampleRate: 0`.
The Worker rebuilds every outgoing error event from a narrow allowlist: a static
error message/class, known owned bundle/source filenames and line/column
positions, release SHA, environment, static phase/status and server-generated
request/trace IDs. Raw exception/provider text, URLs, headers, bodies, users,
breadcrumbs, arbitrary scopes/contexts and source-line contents are omitted.
When the original stack is unavailable, the reporter does not substitute its
own capture location. This boundary covers handled and automatic SDK captures;
it does not change existing operator-log retention or access.

`request_id` matches the API error response where one exists. The fresh
`runtime_trace_id` and Sentry trace context correlate errors within one request
or background invocation; incoming request/trace headers do not choose them.
These are error-correlation identifiers. Performance-transaction sampling,
session replay and marketing analytics remain disabled/separate.

## Embedded runtimes

The existing named `worker` export and instrumented default Cloudflare entry
remain available. An operator embedding the raw Worker should use
`createWorker({ reportError })` to receive caught failures without depending on
an initialized Cloudflare Sentry client. This trusted process-local callback
receives the original `Error` plus a closed phase (`api`, `bootstrap`,
`readiness`, `idempotency`, `scheduled`, `queue`, `payment`), optional API request
ID, fresh trace ID and HTTP status where applicable. No DSN or callback is added
to serialized Worker bindings. The receiver must apply its own privacy boundary
before sending the original exception anywhere.

Callback throws/rejections cannot replace an HTTP response or change a retry or
payment decision. Returned promises are observed and registered with the
invocation's `waitUntil`; an embedding host must drain that context. A direct
`createApp` caller may inject its optional fifth telemetry argument, but must
own any asynchronous drain; the Worker factory supplies it. Handled payment
exceptions can accompany a successful HTTP response or background result, so a
host must not filter those solely by final HTTP 5xx status. Keep errors from
abandoned transaction attempts separate from the winning response.

Local SDK-envelope interception proves capture, privacy and correlation without
using Sentry. A controlled fixture using the real SDK and a real project DSN can
also verify receipt by its exact event ID; label its execution location and
synthetic environment. Such a local receipt is not a production exception, and
an ingest HTTP 200 alone is not proof that the event was indexed in the intended
project.

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
