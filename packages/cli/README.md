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
