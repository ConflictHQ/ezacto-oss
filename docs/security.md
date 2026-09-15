# Security decisions

The policy behind the authentication code, written down where the code can cite
it. Each section names the routes it governs; changing a decision here means
changing the tests that assert it.

## Which sign-in methods are live

Five methods exist: `password`, `magic_link`, `google`, `github` and `apple`. A
method is live only when **both** of these hold, and they are deliberately
separate states:

- **Configured** — the deployment supplies what the method needs. Google and
  GitHub need a client id and secret; Apple needs `APPLE_CLIENT_ID`; the emailed
  sign-in link needs `MAGIC_LINK_SIGNING_KEY`. Password needs nothing, so it is
  always configured.
- **Enabled** — an administrator has not switched it off, at
  **Settings → Company → Ways in** (`/api/v1/admin/sign-in-methods`).

An instance that has never touched the setting has every configured method
enabled, so upgrading changes nothing.

Switching a method off stops its routes, not just its buttons. Every leg of the
family goes with it — for password that is sign-in, signup, both reset legs and
email verification — and each answers `404 sign_in_method_unavailable` before
reading the presented credential, so a switched-off method is not a place to
test whether an address has an account.

### What the setting refuses

It can empty the set of ways into an instance, and the recovery from that is
database surgery. So it refuses rather than warns:

- **The last one standing.** `409 last_sign_in_method`.
- **The one you yourself use.** `409 would_lock_out_administrator`. What counts
  is evidence, not eligibility: a password on file, a verified address for the
  emailed link, or a provider identity linked by a previous sign-in. If you
  intend to run SSO only, sign in with the provider once first — that links the
  identity — and then switch password off.
- **Switching on what the deployment never configured.**
  `409 sign_in_method_not_configured`. The fix is a deployment change, not
  another click.

Apple is the one method with no button on the sign-in card: the mobile app holds
the platform prompt and posts the identity token to `POST /auth/apple`. It is
listed and switchable all the same — there is no control to hide, so switching it
off has to stop the route, and it does.

### Running SSO only

For a deployment whose people all arrive through an identity provider, the
password path is the one nobody watches. Switching it off closes it. Until you
do, it is guarded by one factor unless the user separately enrolled the second —
see below.

## Two-factor authentication

A user enrols through `POST /api/v1/two-factor` and proves the seed with
`POST /api/v1/two-factor/confirm`. Until that confirmation lands the enrolment
is **pending** and changes no sign-in: a seed nobody has proved would lock the
owner out of an account they can still reach with their password.

### Where the second factor is enforced

Once an enrolment is confirmed, these routes stop and issue a short-lived
challenge instead of a session:

| Route | Credential |
| --- | --- |
| `POST /auth/sign-in` | Password |
| `POST /auth/magic-link/exchange` | The six-digit code from the sign-in email |
| `GET /auth/magic-link/verify` | The link from the sign-in email |
| `POST /auth/oidc/exchange` | An app code minted by a magic-link sign-in |

The challenge is answered at `POST /auth/two-factor/challenge`, which is the
only route that turns one into a session.

### Where it is not, and why

Federated sign-ins are **exempt**: the OIDC and GitHub callbacks, the app codes
those callbacks mint, and Cloudflare Access.

The identity provider owns the factor policy for the account it is asserting. A
second prompt here would add no factor the IdP lacks — anyone arriving on this
path has already satisfied whatever the IdP required — and this instance can
neither audit that policy nor enforce one on the IdP's own session. Requiring a
TOTP code on top of an SSO assertion also breaks the property people run SSO
for: one place to revoke access.

**If you self-host and want a second factor on every sign-in, configure it at
the identity provider.** That is the only place it can be enforced for
federated accounts, and it is the place that can revoke it. The other half of
that posture is switching the password method off entirely — see *Running SSO
only* above — so there is no local path left for the factor to miss.

### The challenge

- Thirty-two random bytes. Only its SHA-256 reaches the database, the same
  bargain the session store makes.
- Delivered as the `__Host-ezacto_2fa_challenge` cookie — `HttpOnly`, `Secure`,
  `SameSite=Lax` — and named in the JSON body as well, for clients that keep no
  cookies. It is worth nothing without a code.
- Five minutes. Single use: the consume happens in the same statement that reads
  the row, so one challenge cannot become two sessions.
- Never placed in a URL. The magic-link redirect lands on `/?two_factor=1`,
  which names no credential; the token stays in the cookie, out of the referrer
  header, the history and any proxy log.
- A wrong code leaves the challenge standing. A typo should cost a retry, not
  the password.

### The attempt ceiling

Five wrong codes lock the factor for fifteen minutes. The count lives on the
enrolment, not on whatever surface presented the code, so
`POST /api/v1/two-factor/confirm`, `DELETE /api/v1/two-factor` and the sign-in
challenge all spend from one budget — switching between them buys nothing, and
neither does requesting a fresh challenge.

A locked factor refuses the correct code too. A lock that only refused wrong
ones would slow an attacker down without ever stopping one.

The refusal is `429 two_factor_locked` and names no interval: a precise answer
would be a free measurement of a shared budget.

An accepted code returns the budget to full.

### Recovery codes

Ten, shown once at enrolment, stored as Argon2id hashes under the same
parameters as a password. Each answers a challenge exactly once. A selector that
matches nothing still burns a verification against a decoy, so an unknown
selector does not answer faster than a wrong code.

If both the authenticator and the recovery codes are lost, an administrator has
to remove the enrolment directly in the database — there is no self-service
reset, because a reset a stranger can trigger is not a second factor.
