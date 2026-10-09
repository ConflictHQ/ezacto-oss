# Apple sign-in on the demo and team websites

Web Apple sign-in serves two approved first-party deployments. It uses the
central Apple credential service; the native application continues to verify
only its bundle audience. The native `APPLE_CLIENT_ID` must never include a web
Services ID.

| Site | Services ID | Website domain | Exact return URL |
| --- | --- | --- | --- |
| Team | `com.ezacto.web` | `app.example.com` | `https://app.example.com/auth/apple/callback` |
| Public demo | `com.ezacto.web` | `ezacto.io` | `https://ezacto.io/auth/apple/callback` |

The public source mirror replaces the private team hostname with
`app.example.com`. That hostname is illustrative: the central credential
service does not accept it as a callback or offer independent operator
onboarding through it. Publishing this source does not expand the service
allowlist.

## Apple portal setup

Under Team `H9G2335LXV`, associate the shared Services ID `com.ezacto.web` with
the existing primary App ID `com.ezacto.app`. Register each domain and exact HTTPS return URL under
the shared Services ID's Sign in with Apple web configuration. Use a Sign in with
Apple key for the primary app, never an App Store Connect API key. The central
service alone receives the Apple key ID/private key and mints short-lived ES256
client secrets. No Apple private key, refresh token or client secret belongs in
this application's deployment configuration or browser bundle.

Apple's setup instructions:
https://developer.apple.com/help/account/capabilities/configure-sign-in-with-apple-for-the-web .
Server code exchange requirement:
https://developer.apple.com/documentation/signinwithapple/verifying-a-user .

Both websites use the same production Services ID; exact site origins and
callbacks remain independently bound to each challenge and signed receipt.
This does not isolate Apple's revocation effects. Before enabling mixed
native/web production, disposable Apple accounts must establish subject correspondence for the primary native
app and the web Services ID on both sites. Never join subjects by guessed
correspondence or email. Fixture tests establish our checks, not Apple's grouping behavior.

## Independent self-hosted deployments

The shared first-party Services ID and credential service support only the two
sites listed above. Independent self-hosted operators need their own Apple
Developer App ID, Services ID and Sign in with Apple key, together with an
integration that supports their deployment. This implementation deliberately
rejects arbitrary operator audiences and origins: setting a custom ID or key
in these settings does not enable self-hosted Apple web sign-in. Shared identity
support for other deployments requires a separate explicit design and review.
Hosted-by-us tenant routing belongs to the hosted platform. The bundled native
mobile app continues to use the separate first-party `com.ezacto.app` audience.

## Application configuration

Each deployment uses its existing canonical `APP_BASE_URL` from the table above.
No callback or service origin is accepted from the browser or forwarded headers.
The container normalizes incoming request URLs from its configured application
origin, including when an HTTPS reverse proxy talks HTTP internally.

| Setting | Value |
| --- | --- |
| `APPLE_WEB_ENABLED` | `true` only during coordinated acceptance or after its gates pass |
| `APPLE_WEB_SERVICES_ID` | The exact Services ID for this deployment |
| `APPLE_WEB_CAPABILITY_KEYS` | JSON object of key ID to canonical base64url 32-byte AES key |
| `APPLE_WEB_ACTIVE_KEY_ID` | Key ID used for new ciphertext |
| `APPLE_WEB_ROUTING_SECRET` | Separate stable random 32-byte key, canonical base64url |
| `APP_BASE_URL` | Exact canonical HTTPS origin, no path or trailing slash |

The routing secret HMACs the Apple subject for custody lookup; do not rotate it
casually, because it identifies existing custody records. Encryption keys are
versioned: add a new key and select its ID for new writes while retaining keys
needed to decrypt existing records. A missing key leaves cleanup unresolved;
never represent that state as revoked. Preserve custody keys when disabling
sign-in. With complete custody configuration retained, setting
`APPLE_WEB_ENABLED=false` hides new web sign-in while retaining explicit
browser cleanup and operator closure support. The central service has its own
web enablement flag and fixed-host policy.

The public demo additionally requires `DEMO_MODE=true` outside `ENVIRONMENT=prod`.
Demo Apple sign-in branches before user lookup, email linking or provisioning,
then issues only the published Teammate session. It creates no visitor workspace
account. Production cannot turn on this behavior with a stray demo flag.

## Credential custody and cleanup

The browser starts at `/auth/apple/start`. A five-minute transaction binds the
central challenge ID/nonce, exact callback and purpose to a random browser state
cookie. Apple returns a bounded form POST to `/auth/apple/callback`. State,
issuer, audience, nonce, expiry, replay and the central signed binding receipt
must all validate before a session is issued. Tokens and provider error text
never appear in redirect query strings.

The central service durably encrypts Apple's credentials. This application
stores only its own service capability and subject inside AES-GCM ciphertext,
with deployment, subject digest, grant ID and generation authenticated as
associated data. The browser receives an independent opaque Secure/HttpOnly
recovery cookie; that cookie is not the capability and is never derived from
the shared demo session. Team custody records link to the real user so account
closure works without their browser. Demo records have no user association.

Signing in, signing out, callback failure and the nightly demo workspace reset
do not automatically revoke Apple authorization. The sign-in page discloses
that the first-party service retains credentials despite the demo creating no
personal workspace account. Central custody survives workspace resets. The
browser recovery cookie lasts up to 90 days; lost/expired handles and demo resets
require fresh Apple cleanup authorization, not another visitor's shared session.

`/auth/apple/disconnect` explains possible effects on the iPhone app and other
Ezacto sites and requires explicit confirmation in a same-origin POST. A missing
recovery handle offers fresh Apple authorization without creating or entering a
workspace account. If account deletion is already pending, enter its original
request reference to obtain request-bound cleanup proof. A newer verified receipt
can replace custody for that same request and rotates the old browser handle.
Failed or known-stale connections offer this recovery even when the old browser
cookie still exists; the recovery link preserves its original request reference.
Disconnecting Apple does not delete workspace records.

Operator account closure first captures each known web obligation durably without
calling the provider. Revocation runs only after local closure commits. A failed
provider request preserves successful local closure and its pending/manual cleanup
status; administrators can explicitly retry cleanup from the deletion request.
Status and preview reads never revoke credentials. Only
verified matching web revocation proof marks that obligation revoked; proof and
minimal tracking evidence are encrypted at rest. Native receipts cannot discharge
web obligations, or vice versa. Channel provenance distinguishes a newly linked
web-only identity from an older unclassified Apple identity. Signing in again
does not erase historical uncertainty or prove an old native grant revoked.
A newer native/demo/team sign-in can supersede an
older capability. Such a failure remains pending or manual-required until
request-bound reauthorization and matching proof arrive; a shared subject alone
is never evidence that all channels were cleaned up. Ordinary workspace erasure
can proceed while Apple cleanup remains explicitly unresolved.

After proof is persisted locally, the application acknowledges the central
service. A lost ACK leaves the central service's documented bounded delivery
context, not a live Apple token. Cloudflare processes that service's encrypted
storage; its retention and recovery-copy inventory must be published alongside
the website and App Store privacy disclosures before enablement.

## Controlled acceptance and ongoing enablement

- Confirm the shared Services ID, associated primary app, both domains and exact return URLs in Apple Developer.
- Deploy the reviewed native and web lifecycle service, publish its credential-retention inventory and update App Store privacy answers.
- Deploy this server's encrypted capability repository and aggregate native/web account-closure integration; provision separate custody and routing keys.
- Verify disposable accounts across native, team web and demo web: actual exchange, subject correspondence, explicit disconnect, provider-wide impact and request-bound recovery after losing browser state.
- Confirm demo sign-in creates no user or identity link and that one visitor's shared demo session cannot revoke another visitor's authorization.
- Test Hide My Email, cancellation, disabled accounts, expired/replayed callbacks and a temporary lifecycle outage on physical Safari and supported browsers.
- After source, privacy, configuration and deployment checks pass, coordinate a controlled acceptance window with the central service and each website enabled deliberately. Disable new sign-in immediately if real-provider checks fail; preserve custody settings for cleanup. Retain ongoing enablement only after that site passes the checks above. Do not treat mocked provider tests as provider acceptance.
