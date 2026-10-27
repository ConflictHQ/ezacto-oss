# Security decisions

The policy behind the authentication code, written down where the code can cite
it. Each section names the routes it governs; changing a decision here means
changing the tests that assert it.

## Financial visibility and CONFLICT operating policy

Financial access follows the native permission profile, manager grants and the
identified subject of the requested figure. An employee/contractor flag does not
itself grant or deny access to rates, costs, invoices or financial reports. The
shared rules live in
[`money-permissions.ts`](../packages/core/src/money-permissions.ts).

For the CONFLICT production instance at `app.example.com`, **`own_money`
stays disabled permanently**, per owner decision D44 recorded on
[issue #549, 2026-10-24](https://github.com/ConflictHQ/ezacto-pvt/issues/549#issuecomment-6390787615).
Do not enable it during deployment, onboarding or an access-verification run.
This keeps the optional own-rate and own-payment views off. Existing
administrator financial permissions remain governed by the native profile.
Other self-hosted operators retain the documented administrator-controlled
setting; an absent `own_money` key is off.

When enabled on an instance whose policy permits it, the own-money exception
requires a known acting user and an exact match to the figure's subject. It
never widens access to another person's rates or to an organization budget. The
[personal payment summary](contractor-payments.md) uses the same setting and
subject boundary.

Verification follows owner decision D43 in the same issue: production inspection
is a read-only aggregate of profiles, grants and the effective `own_money` value.
Authenticated denial probes use owner-provisioned test identities and synthetic
records on `ezacto.io`, never real production employees' prices. Record the
deployed revision, status codes and absent field names; keep credentials,
identities and financial payloads out of the evidence. Local synthetic tests
establish code behavior, while production aggregates establish the current
configuration; preserve that distinction in the acceptance record. The
[deployed verification procedure](financial-access-verification.md) includes the
read-only probe and the browser checklist.

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
| `POST /auth/magic-link/verify` | The link from the sign-in email, confirmed on the page its `GET` renders |
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

### The emailed code

A second factor for people who will not set up an authenticator app. It sits
beside TOTP and recovery codes: a person may have any of them, and the challenge
accepts whichever they hold. It counts as the second factor wherever an instance
requires one, because a weaker factor that gets used protects more than a
stronger one that does not.

A person turns it on and off under *Settings* (`POST` and `DELETE
/api/v1/two-factor/email`, session only, and the address must be verified). An
administrator can turn off someone else's, for the person who lost their mailbox
(`DELETE /api/v1/users/:id/two-factor/email`, and `GET` on the same path for
whether it is on). On the web that is the *Emailed sign-in code* section of the
person's Permissions tab in Team, with a confirm step; it is refused on the
public demo. Both are audited as
`two_factor.email_enabled` and `two_factor.email_disabled`.

- **A code and no link.** A link in a second-factor email is a phishing target,
  and mail scanners follow links, which would spend the factor before its owner
  saw it.
- **Password sign-in only, on purpose.** Magic-link sign-in is already a
  credential delivered to the mailbox, so a code to the same mailbox adds a step
  and no factor. That path never issues the emailed factor, and a person whose
  only second factor is the emailed code signs in by magic link as they would
  with none. Federated sign-in is exempt for the reasons above.
- **Sent automatically for email-only people.** Someone who also has an
  authenticator gets the code only after choosing *Email me a code* on the
  challenge screen, so a stolen password cannot be used to fill an inbox.
- **Limits.** The code lives as long as its challenge (five minutes) and is
  stored as a hash only. Five wrong attempts exhaust the challenge; the correct
  code is refused after that, and after one use. Asking for a code again
  replaces the challenge and kills the earlier code. A person can be mailed one
  code a minute and five an hour, the sign-in's own mail included.
- **The trade-off.** It is weaker than an authenticator app. It defends against
  a stolen password; it does not defend against someone who holds the password
  and the mailbox, or who can read the mail in transit. Prefer an authenticator
  app where people will use one.
- **Recovery.** The emailed factor has no recovery codes of its own. Someone who
  loses the mailbox and has no authenticator needs an administrator to turn it
  off.

### Recovery codes

Ten, shown once at enrolment, stored as Argon2id hashes under the same
parameters as a password. Each answers a challenge exactly once. A selector that
matches nothing still burns a verification against a decoy, so an unknown
selector does not answer faster than a wrong code.

If both the authenticator and the recovery codes are lost, an administrator has
to remove the enrolment directly in the database — there is no self-service
reset, because a reset a stranger can trigger is not a second factor.

## The backup download link

An administrator can turn a completed backup run into one ZIP and download it
from another machine with `curl` (issue 39). The ZIP is the whole database as
CSV, so it carries credential hashes and authenticator seeds, and the link to it
is handled as a credential.

- **Minting.** `POST /api/v1/backup/download-links`: an administrator's own
  session only (an API token gets `403 session_required`, any other profile
  `403`). Where that administrator has an authenticator enrolled the body must
  carry a current authenticator or recovery code, spent from the same attempt
  budget as sign-in and disable. An emailed-code-only factor does not gate the
  mint yet. Five mints a minute per administrator, counted before the code is
  read.
- **The link.** `GET /backup-download/<token>`, no session. 256 random bits,
  shown once in the mint response, stored only as a SHA-256, compared in constant
  time. It expires after ten minutes and works once: the statement that spends
  it is the one that decides who gets the file, so of any number of concurrent
  requests exactly one is served.
- **One refusal.** Wrong shape, never minted, expired, already spent, run gone,
  or a bundle whose manifest no longer matches what D1 recorded: the same plain
  `404 Not found`. Thirty requests a minute per caller address, counted before
  the token is looked at (`429` over it). A table object that fails its manifest
  checksum aborts the stream before any of its bytes are sent.
- **Recorded.** `backup.exported` is written at the mint (actor: the
  administrator) and when the download starts (actor: system, naming who minted
  the link), each with the link id and the run. Never the token.
- **Private.** `no-store`, `no-referrer`, `noindex`, no cookie, and nothing but
  the token in the URL. `backup_download_links` and `backup_download_limits` are
  named in the bundle's `restore_skips`.

## The hosted invoice page

`GET /portal/invoices/<token>` is the one invoice surface a client reaches with
no sign-in (issue 936). It exists only for an organization that turned on
Settings > Company > Invoices > "Link the invoice online in the email", which is
off by default; off, the invoice email is exactly what it was and no link is
ever made.

The token in the link is the whole credential, so it is handled as one:

- **Unguessable.** 256 random bits from the platform's CSPRNG, base64url.
- **Hashed at rest.** Only the SHA-256 is stored (`invoice_view_links.token_hash`),
  compared in constant time after the lookup. A copy of the database cannot open
  an invoice. The token is in the email the client was sent and nowhere else:
  not in the message row, the event, a log line or an error.
- **No enumeration.** A malformed token, one never issued, an expired one and one
  whose invoice is no longer sent all get the same plain `404 Not found`. The
  token is never echoed back.
- **Rate limited.** 60 requests a minute per caller address (`cf-connecting-ip`,
  which the container sets from its trusted-proxy rule), counted before the token
  is looked at and stored only as a hash. Over it, `429` with `Retry-After`.
- **Expires.** 180 days after the send that carried it.
- **Private.** `no-store`, `no-referrer`, `noindex`, no cookie, no third-party
  script, image or font. There is no tracking pixel.
- **One link per send.** Since an invoice email is a single message to everyone
  on it, a receipt says the email was opened, not by whom.

Fetching the page records nothing, so a mail scanner that only follows the link
is not a view. A view is the page reporting it was shown in a visible browser
tab, or the PDF being downloaded; the first one runs the `invoice.view` command
as the system, which writes a "Viewed online" row into the invoice's history and
emits `invoice.viewed`. Settings > Deliveries shows the same time against the
email. Request URLs carry the token, so an operator should treat access logs for
`/portal/invoices/` as holding secrets.

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

### Portable scheduled logical copies

The product L2 path encrypts each Worker logical-backup object with AES-256-GCM
before sending it to an operator-owned S3-compatible bucket. A dedicated 32-byte
key stays in deployment secrets and the operator's secret manager; only its
fingerprint, random per-object nonce, frozen source hash and upload receipt enter
the database. Immutable identities prevent retries from changing plaintext under
an existing nonce. The encrypted manifest is published last. RESTORE.md documents
the format, offline decryption, permissions, rotation, size limits and the
remaining attachment/restore boundary. Container CLI copies retain their documented
separate encryption limitations.

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

## Account erasure and retention

Operators can publish their applicable-framework assessment, justified retained
record categories, review intervals, user disclosure and backup handling under
Settings → Company → Erasure and retention. See
[the operator guide](account-erasure-retention.md) for configuration, API access
and legal references. These settings do not execute account closure or delete
backup copies; recording a request or archiving a user is not completed erasure.

### Cloudflare Access session reuse

Repeated requests with the same verified Access assertion and local user share
one native session, including requests handled by separate runtime instances.
The selector is derived from the entire verified assertion with provider-purpose
separation; its cookie secret remains independently random. Only the creating
response receives that cookie. Existing valid application cookies remain
authoritative.

Reused header authentication still checks native user state, role/grants, idle
and absolute expiry, and revocation. A revoked or expired session is not
recreated by presenting the same assertion. Privilege rotation also retires the
old assertion-bound row. Cookie-less clients must refresh their Access assertion
after revocation, expiry, or privilege rotation; a fresh valid assertion can
establish a new session. Browsers retain the normal replacement cookie after
privilege rotation. This limits amplification from repeated use of one
assertion; it is not a rate limit on new assertions issued by the upstream
identity provider. Raw Access assertions are not retained in the database.
