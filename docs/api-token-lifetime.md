# API token lifetime

Issue 599, owner decision of 2026-10-19 (shared with issue 740). There are no
refresh tokens and no renew route. A token is issued with an expiry, and when it
expires the person issues another from their settings page.

## The rule

| Who asks | `expires_at` omitted | `expires_at` within one year | `expires_at` beyond one year, or `null` |
| --- | --- | --- | --- |
| Anyone except an administrator | expires one year after issue | as asked | refused, `422 validation_failed`, field `expires_at`, code `too_long` |
| Administrator | expires one year after issue | as asked | as asked (`null` means never) |

- "One year" is one calendar year from the moment of issue. A date picked a year
  ahead in the settings form is accepted through the end of that UTC day.
- The refusal message reads: "expires_at is more than one year away. A token you
  issue yourself lasts at most one year; ask an administrator for a longer one."
- Omitting `expires_at` is a default, not a refusal, so a client written before
  this rule keeps working and now gets a token that expires.
- The check is in the shared API token route, so the Worker and the container
  behave identically.
- The public demo keeps its own, tighter 24 hour ceiling underneath this rule.

## Tokens that already exist

Nothing is invalidated and nothing is rewritten. A token issued before this rule
with no expiry keeps working until it is revoked, and one with an expiry keeps
it. This includes the bootstrap owner token, which is inserted by the operator
with no expiry. The rule applies to issuing, not to authenticating.

An operator who wants these gone revokes and reissues them: the settings page
lists every token with its expiry (`Never` for these), so they are easy to find.
A forced expiry for old tokens was not chosen because it would sign out apps in
use with no warning; if the owner wants one, it is a separate decision and a
data change.

## Renewal

There is none. An app whose token expired gets a 401 and asks the person for a
new token. Revisit only if mobile users report unexpected sign-outs.
