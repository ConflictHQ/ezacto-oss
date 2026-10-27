# Personal calendar consent

Calendar access is a separate per-user grant. Do not reuse a Google sign-in
grant or paste an access/refresh token into eZacto. Each person connects their
own calendar from **You → Calendars**. Events become proposals only; accepting
one still requires choosing the project and task. No provider event is written
and no meeting becomes billable time automatically.

## Provider registration

Configure a dedicated calendar OAuth client, and complete the provider's
verification/consent requirements before enabling it for real users. These
instructions do not create or approve a provider registration.

| Provider | Requested access | Exact callback path |
| --- | --- | --- |
| Google | `https://www.googleapis.com/auth/calendar.readonly`, offline access | `/api/v1/calendar-connections/google/callback` |
| Microsoft | delegated `https://graph.microsoft.com/Calendars.Read` and `offline_access` | `/api/v1/calendar-connections/microsoft/callback` |

Register the full callback URL under the instance's configured `APP_BASE_URL`.
It must use HTTPS outside localhost. Microsoft uses a confidential web client,
not an SPA or application-permission grant. The default tenant endpoint is
`common`; `organizations`, `consumers` or a tenant UUID may be configured.

Set these values in the deployment secret store (or the container environment):

- `GOOGLE_CALENDAR_CLIENT_ID` and `GOOGLE_CALENDAR_CLIENT_SECRET`
- `MICROSOFT_CALENDAR_CLIENT_ID` and `MICROSOFT_CALENDAR_CLIENT_SECRET`
- Optional `MICROSOFT_CALENDAR_TENANT`

The standard deployment workflow carries those same secret names. Neither
provider is available without its client pair, and the public demo suppresses
all provider credentials. The callback origin comes from configuration, never
from a return URL supplied by the browser.

The authorization request uses random state and S256 PKCE. A Secure, HttpOnly
per-provider cookie binds the callback to the requesting browser. Only state
and requester hashes are stored in the short-lived attempt row. A callback
requires the same live native session and connection generation; replay,
another person, an expired attempt or a changed connection cannot install a
grant. Successfully exchanged credentials that lose the final admission race
are encrypted into cleanup custody.

## Refresh and disconnect

Access tokens are refreshed only as needed. Rotated credentials are sealed and
persisted before a provider read proceeds. Existing instance/user/provider and
generation fences protect both credentials and proposal commits. The existing
minute maintenance hook checks at most five due connections; failed reads keep
their old cursor and are spaced apart. Manual refresh uses the same pipeline.

Disconnect immediately removes local access and cancels unaccepted proposals.
Accepted time entries are retained. Google token revocation runs from encrypted
cleanup custody; transient failure remains pending and does not claim success.

Microsoft does not offer an app-scoped revocation endpoint under these read
permissions. Remove the app's access in the appropriate provider page:

- Work/school account: [Microsoft My Apps](https://myapps.microsoft.com/)
- Personal account: [Microsoft account permissions](https://account.live.com/consent/Manage)

Then deliberately confirm removal in eZacto. This records an immutable **owner
attestation**, not provider-verified revocation. It releases only that person's
matching, current-instance disconnect or reauthorization cleanup record and
allows a new consent flow. It cannot resolve another person's record, an
account-closure obligation or a restored instance's cleanup. Administrator
cleanup counts distinguish these attestations from provider revocations.

## Verification limits

The repository tests real SQLite/D1 custody, runtime routes and browser cookie
behavior with owned provider fixtures, including delayed callbacks, logout,
replay and token rotation. No real Google or Microsoft grant is implied by those
fixtures. Live provider consent, tenant policy and verification remain an
operator acceptance step.

Provider references: [Google web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)
and [Microsoft authorization-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow).
