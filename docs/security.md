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

## Backups

Two of them, in different formats, from different code paths, on different
schedules. Neither is sufficient alone and a bug in one is unlikely to be a bug
in the other, which is the only property that makes the second worth its cost.

| | written by | at | carries | restores with |
| --- | --- | --- | --- | --- |
| CSV bundle | the Worker, from its own R2 binding | 03:00 UTC | every table's rows, per-table SHA-256, a manifest | rebuild the schema from source, then import the CSVs |
| SQL dump | a scheduled GitHub Action, via D1's export API | 04:00 UTC | the whole database — schema, indexes, triggers, rows | `wrangler d1 execute --file`, or `sqlite3` directly |

The Worker cannot produce the SQL dump: D1's export is an account-level API call
and no Worker holds an API token. The Action cannot produce the CSV bundle
without reaching into the database itself. Hence one of each.

**Nothing is ever deleted.** There is no retention step in either path and no
lifecycle rule to add one. A night's SQL dump compresses to a couple of
megabytes, so a year of them is a few gigabytes, and the storage costs less per
month than the time spent deciding what to throw away.

### What the bundles carry

Both carry credential material — password hashes, authenticator seeds,
recovery-code hashes, API-token hashes. That is deliberate: an instance whose
people cannot sign in has not been restored. It means both are exactly as
sensitive as the database they came from, and more portable. The SQL dump never
becomes a GitHub Actions artifact for that reason; it goes from the runner
straight to R2.

The CSV bundle's manifest names the tables a restore should skip
(`restore_skips`) — live sessions, sign-in links and OAuth transactions, which
are captured because a backup is a record but would, if reloaded, revive a
session somebody revoked.

### What they do not carry

- **Attachment bytes.** Both back up the attachment *metadata*; the files
  themselves stay in R2 and nothing copies them.
- **Attachment bytes**, still — see above. That gap is unchanged.

### Where a backup lands

One layout, decided in one place so three destinations cannot drift:

```
<instance-fqdn>/backups/YYYY/MM/backup-DD-HHMMSS.sql.gz[.gpg]
<instance-fqdn>/backups/YYYY/MM/backup-DD-HHMMSS.manifest.json
```

Namespaced by instance, so one bucket can hold several and a restore never has
to guess which book it is holding. Foldered by month, so a listing reads as a
calendar rather than a heap.

### Encryption

Every copy that leaves Cloudflare is encrypted; the R2 copy is not.

The passphrase is symmetric rather than a keypair, and that is a considered
choice, not a shortcut: the runner builds the plaintext dump itself, so guarding
against "CI can decrypt" would buy nothing at all. What the encryption buys is
that the bytes sitting in somebody else's storage are unreadable to anyone who
reaches that bucket.

R2 stays plaintext for the same reason it is the primary: it already shares a
trust boundary with the live database, and it is the copy you reach for first. A
lost passphrase should cost you the off-site copies, never all of them at once.

Where no passphrase is configured the off-site copies still go, plaintext, with
a warning. Refusing to deposit a backup would trade a real one for a tidy rule.

### The off-site copies

The SQL dump is also deposited in S3 and in GCS, in the operator's own accounts,
and a fortnight of nights is kept as a GitHub artifact. A backup that shares a
provider with the thing it backs up is one account suspension away from being no
backup at all; three providers is three suspensions.

Each off-site leg runs whenever the dump itself succeeded, independently of the
others. If R2 fails we are holding a good dump and an empty bucket, which is the
moment the off-site copies are worth most.

CI reaches it through GitHub OIDC rather than a stored key, and the role is
deliberately narrow in two ways:

- **Trust** is scoped to `repo:<owner>/<repo>:environment:prod`, not to the
  repository generally and not to a branch. Only a job that declares the prod
  environment can assume it, so the environment's protection rules gate AWS
  access too, and nothing from a fork can reach it.
- **Permission** is `s3:PutObject` and nothing else. No read, no delete, no
  list. CI can deposit a backup and can never retrieve or destroy one. The
  bucket is versioned, so the worst a compromised run can do is add objects.

The off-site leg runs whenever the dump itself succeeded, not only when the R2
upload did. If R2 fails we are holding a good dump and an empty bucket, which is
the moment the off-site copy is worth most.

The S3 bucket blocks public access and encrypts at rest, and the object on top of
that is encrypted with the passphrase above.
