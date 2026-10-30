# Staff sign-in code request binding (#1311)

The six-digit staff code belongs to the app or browser that requested it. The
email says where to enter the code; its long sign-in link can still be opened on
another device. Request and exchange JSON bodies are unchanged.

The request endpoint issues a random 32-byte Secure, HttpOnly, SameSite=Lax
cookie with a ten-minute lifetime. Cookie issuance and reuse are independent of
whether the email exists or the request was throttled, preserving the generic
202 response. Only its SHA-256 hash is stored with the code. Missing, malformed,
duplicate or mismatched cookies cannot consume another request's attempts.
Browser cross-origin requests are refused; native clients without Origin/Fetch
Metadata remain supported. Native clients must retain the normal HTTP cookie
jar and send credentials on both requests.

Code redemption and wrong-attempt increments require the user and exact request
hash. Five wrong attempts still exhaust that request. A resend after the existing
60-second email throttle assigns a new code to that requester, detaching the old
code binding without deleting its long email token. Only an unconsumed row can
hold the active binding, and consumption is atomic. A successful exchange clears
the requester cookie while retaining normal session/two-factor behavior.

Migration 175 adds the nullable hash and partial unique index. Already-issued
unbound codes cannot be redeemed after deployment; the corresponding emailed
long link still works until its ordinary expiry. Users can request a new code.
No token lifetime, TOTP, portal verification or activity-log policy changes are
included.

One sign-in request per browser is the supported flow. Concurrent first requests
from a cookie-less shared jar may leave the last response's cookie paired with a
different email; the exchange then fails closed. Requesting a fresh code in that
browser recovers, or the long email link can be used. This change does not claim
to prevent all login denial of service: the existing user-level mail throttle
and deployment-level protections remain separate.

## Verification

- The new two-requester native API regression failed with 401 for the victim's
  correct code on both SQLite and D1 before the fix, then passed afterwards.
- Native SQLite/D1 tests cover requester isolation, wrong/missing/tampered
  cookies, replay, one successful concurrent exchange, old-code replacement,
  long-token survival and resend after a lost successful response.
- The existing magic-link/two-factor suites verify the long-link handoff and
  second-factor paths continue to work.
- `apps/web/playwright.staff-code.config.ts` runs a disposable real Container
  runtime and Chromium on localhost. It checks Secure/HttpOnly cookie storage,
  automatic cookie sending, code redemption, cookie clearing and the resulting
  administrator session.
- The optional `EZACTO_STAFF_CODE_MOBILE_SOURCE` run bundles the existing mobile
  API functions without editing that repository. It proves their unchanged
  request/exchange/mint sequence against Chromium's Fetch cookie jar. This is
  not a React Native, iOS or Android device/storage acceptance claim.

To repeat the browser protocol check after normal dependency builds:

```sh
EZACTO_STAFF_CODE_FIXTURE_PORT=4294 npx playwright test --config apps/web/playwright.staff-code.config.ts
```

The harness refuses unowned directories, blocks provider network requests,
keeps credentials out of logs/traces, and removes its private runtime/database
when stopped. Its capture endpoint exists only in the test fixture.
