# ez — ezacto CLI

`ez` is the native command-line client over the generated `@ezacto/client`
package. It supports named organization configs, token login, identity checks,
redacted config output, and both human and JSON output.

```sh
# Safest for an already-issued scoped API token: it never enters shell history.
printf '%s\n' "$EZACTO_TOKEN" | ez login --token-stdin --org conflict

ez whoami
ez whoami --json
ez config
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
