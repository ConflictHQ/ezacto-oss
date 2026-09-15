# Security decisions

The policy behind the authentication code, written down where the code can cite
it. Each section names the routes it governs; changing a decision here means
changing the tests that assert it.

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
federated accounts, and it is the place that can revoke it.

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
