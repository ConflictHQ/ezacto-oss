# Apple credential lifecycle for self-hosted instances

The official iOS app uses `com.ezacto.app` and a narrowly scoped eZacto Apple
credential service at `https://apple-auth.ezacto.com`. This service supports
Apple authorization and revocation; it is not a hosted eZacto workspace. The
workspace remains on the operator's server. Operators must disclose this
additional service when they enable official native Apple sign-in.

## Configuration and trust

Set `APPLE_CLIENT_ID=com.ezacto.app` and `APP_BASE_URL` to the instance's exact
canonical HTTPS origin, without a trailing slash, path, query or credentials.
The existing Apple sign-in policy must also be enabled. The native client checks
`GET /auth/apple/native-capabilities` for `{available:true,lifecycle_version:1}`
before authorization. An older server without this protocol must be upgraded;
identity-token-only sign-in is not accepted, including for existing accounts.

Do not install the Apple team's signing key, refresh tokens or native cleanup
capabilities on a self-hosted server. The credential service owns encrypted Apple
token custody. The native client keeps its request-scoped capability in secure
storage. The instance stores only pseudonymous subject digests, origin/grant
bindings and signed-event evidence. These remain personal security records, not
anonymous data. The Apple team's OAuth signing key is distinct from an App Store
Connect API key.

The instance verifies service receipts against the fixed issuer and fixed JWKS
URL `https://apple-auth.ezacto.com/.well-known/jwks.json`. It never follows a
client-provided key URL or redirect. Key responses are bounded and cached;
key-service outages produce retryable errors. Native receipts require ES256,
exact instance audience, current validity, subject, grant and generation. Web
channel receipts and Services ID audiences cannot authorize native sign-in.
Independent Apple ID-token verification additionally checks `com.ezacto.app`,
the receipt's nonce and matching subject. A receipt does not grant membership;
normal invitation/domain and instance sign-in rules still apply.

## Deletion and provider cleanup

Local account closure deletes local sign-in credentials and identities. Before
that atomic operation, the server captures each known Apple cleanup obligation.
Capture and status checks must not revoke externally. A rejected closure review
must not change external Apple access. The native app revokes through the Apple
credential service and delivers the service's signed revocation receipt without
retaining ordinary workspace credentials.

The proof-only instance endpoints accept JSON `{receipt}`:

- `POST /auth/apple/deletion-requests/:id/binding` accepts a fresh **cleanup**
  grant bound to that exact request. This allows recovery after local closure;
  an unrelated sign-in receipt cannot rebind a request.
- `POST /auth/apple/deletion-requests/:id/revocation` accepts evidence for the
  exact expected origin, subject digest, request, grant and generation.

Only HTTP 204 means matching evidence was durably stored or the same immutable
event was already stored. The app may acknowledge service delivery only then.
HTTP 409 means evidence was not accepted; 401 means invalid proof; 503 means a
retryable verification or storage outage. Responses are generic and noncacheable;
proofs belong in request bodies, never URLs, logs, analytics or support bundles.
Endpoints bound body sizes and rate-limit proof attempts per instance.

A refreshed delivery JWT may change its issuance/expiry while retaining the
original event ID and revocation time. Deduplication uses immutable event claims,
not JWT bytes. A newer authorization changes the expected generation for a
pending request; old evidence cannot silently satisfy it. Completed historical
requests are not reopened by a later authorization elsewhere.

The requester sees only `not_linked`, `pending`, `revoked` or `manual_required`.
Every known identity and channel must be resolved before the aggregate says
`revoked`. Native evidence cannot discharge web-token obligations. Missing
historical token custody, or older closures without per-identity evidence,
remain `manual_required`; one recovered proof cannot establish that unknown
other grants were revoked. Explain Apple's manual account-connection controls
without preventing local account closure or falsely reporting provider cleanup.

Provider cleanup is not complete data erasure. Remaining business records,
exports, attachments, email copies and backups still require the operator's
[retention review](account-closure-data-inventory.md). A selected privacy-law
checkbox does not establish a lawful basis or certify compliance.

## Recovery and service ownership

The credential service keeps active grants until revocation/replacement; it does
not silently purge a live grant solely due to age. Pending receipt delivery has
a disclosed 90-day recovery window, with review due after 30 days, and supports
receipt renewal. Acknowledged delivery or explicit user discard removes that
request's recovery context. These are engineering recovery windows, not legal
retention periods. The instance's separate deletion-status capability has its
own [expiry rules](account-closure-data-inventory.md#following-a-request-after-sign-in-access-closes).

Web Apple sign-in uses separate Services IDs and encrypted server-held custody.
Its adapter must capture obligations before closure, perform external cleanup
only after valid authorization, and retry without losing undelivered evidence.
Administrators can use the closure review’s “Retry server-managed Apple cleanup”
button after local closure. Its `POST /api/v1/admin/deletion-requests/:id/apple-cleanup`
endpoint accepts `{}` and requires an administrator session and normal CSRF checks.
Provider or persistence outages leave local access closed and cleanup unresolved.

Do not enable a web channel whose custody and aggregate cleanup adapter are not
configured. An unsupported or uncertain obligation stays actionable rather than
being inferred complete from a shared Apple subject.
