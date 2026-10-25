# ez — ezacto CLI

`ez` is the native command-line client over the generated `@conflict-hq/ezacto-client`
package. It supports named organization configs, token login, identity checks,
redacted config output, and both human and JSON output.

## Install

```sh
npm install -g @conflict-hq/ezacto-cli
ez --help
```

Node 22 or later. The package is published from
[ConflictHQ/ezacto-oss](https://github.com/ConflictHQ/ezacto-oss) under the
AGPL v3; `npx @conflict-hq/ezacto-cli --help` runs it without installing.

## Use

```sh
# Safest for an already-issued scoped API token: it never enters shell history.
printf '%s\n' "$EZACTO_TOKEN" | ez login --token-stdin --org conflict

ez whoami
ez whoami --json
ez config
ez log 2h northpeak devops -m 'release work'
ez timer start northpeak devops -m 'incident follow-up'
ez timer status
ez timer stop
ez week
ez logout
```

`--base-url` selects a different ezacto deployment during login. Plain HTTP is
accepted only for localhost development servers; remote credentials require
HTTPS. `--org` selects a named organization, and the most recent login becomes
active.

The default config is `$XDG_CONFIG_HOME/ezacto/config.json`, falling back to
`~/.config/ezacto/config.json`. `EZACTO_CONFIG` or `--config` can override it.
Writes are atomic and the credential file is mode `0600`; command output never
prints the token. `--token` is supported for automation but `--token-stdin` or
the `EZACTO_TOKEN` environment variable avoids exposing a token in process lists
and shell history.

Time commands resolve project names/codes and task names through the native API.
Durations accept compact hour/minute forms such as `2h`, `90m`, and `1h30m`.
`--date` selects the spent date for `log` or `timer start`; `--week` accepts any
date in the Monday–Sunday week to render. Starting a timer relies on the same API
invariant as the web app: the previous running timer is stopped atomically before
the new one starts.

## Packaging

The CLI bundles the shared report capability inventory into `dist/money.js`.
`@ezacto/core` is a build dependency only; it must never appear in the published
runtime dependencies. Build before packing, and publish version 0.1.3 through the
existing `npm-v0.1.3` release workflow after the fix is merged. Version 0.1.2
cannot be repaired in place; pin 0.1.1 until the patch is published.

Run `npm run test:package -w @conflict-hq/ezacto-cli` from the repository root
after building the workspaces. It packs both release candidates, globally installs
them into a temporary prefix outside the checkout, and exercises help, the bundled
report inventory, and a SQLite backup through the installed `ez` command. This
check runs in CI and before either package is published; it needs access to npm
for public dependencies and cleans up its temporary installation afterward.

## Instance module availability

`ez --help` and `ez report list` work offline and describe commands supported by
this client. They do not promise that the selected instance enables every module
or that the current token has every permission. A report name in the inventory
is not a successful capability check.

Remote invoice commands, reports and exports retain the server's module and
permission checks. A `403` with `module_disabled` means the operator has switched
the module off; signing in again or granting a token another scope cannot enable
it. JSON failures preserve the server code, HTTP status and request ID. The CLI
does not fall back to another endpoint or provider after a refusal.

The SSO switch controls interactive provider sign-in, not validation of an
already-issued API token. `ez login` stores a token; it does not start an SSO
flow. `ez backup`, `restore`, `backup-decrypt` and `export --verify` operate on
local files. `backup --sync-to` is an explicit operator copy to the configured
S3-compatible destination, not the instance's managed backup service. These
recovery commands remain available with `BACKUPS_ENABLED=false`; possession of
the files and destination credentials is still required.

## Report permissions

`ez report list` names the scope required by each report. `ez uninvoiced` and
organization reports require `reports:read`, available to accounting, executive
managers and administrators. Members can use `ez report run my-hours --from
YYYY-MM-DD --to YYYY-MM-DD` with `time_entries:read`. Project budgets use
`projects:read` and the server enforces project visibility.

Before resolving filters or loading a report, the CLI checks the scopes stored
at login. If a required scope is missing, it names that scope and the stored
profile. API failures retain their code, message, HTTP status and request ID in
`--json` output and readable error text. Permissions are still enforced by the
server; local config cannot grant access.

## Editing draft invoices

```sh
ez sudo invoice edit 1400 --subject "October retainer" --notes-file notes.txt \
  --issue-date 2026-10-05 --due-date 2026-11-04 --terms net_30
ez sudo invoice edit 1400 --line 2 --quantity 3 --rate 150.50 --description "Review"
ez sudo invoice unlink-time 1400 --entries 101,102
```

`sudo` requires an administrator API token with `invoices:read` and
`invoices:write`. It prompts privately for the same administrator's verified
email and password, then any enrolled authenticator/recovery or email second
factor. Password sign-in must be enabled. For automation, pass `--reauth-stdin`
and pipe a private JSON object with `email`, `password`, and optional `code`
(authenticator or recovery code); credentials are never command-line arguments.
Email-code reauthentication is interactive.

The server issues an elevation bound to that API token and that draft invoice
for at most 15 minutes. The CLI holds it in memory and revokes it when the
command finishes; it never saves the password or elevation in config. Ordinary
`ez invoice edit` and `unlink-time` calls without elevation receive HTTP 403.

`edit` reviews the draft before reauthentication and refuses a changed document.
Each write carries a fresh `Idempotency-Key` and `expected_version`. Line numbers
are one-based; rates are decimal currency units. Header and line edits are
separate commands: if the header saves and a later line fails, the CLI reports
the saved header so the operator can review it before retrying.

`unlink-time` additionally requires `time_entries:write`. It releases only the
explicit stopped entries linked to the named draft, atomically; an ineligible or
cross-invoice selection changes nothing. Invoice line amounts remain as saved
and need review. Every edit/release records the actor, elevation and exact
before/after values in the same database transaction.
