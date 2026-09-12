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
