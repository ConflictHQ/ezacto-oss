# ezacto MCP server

`ezacto-mcp` is the read-only Model Context Protocol server for ezacto. It uses
the same named organization and scoped API token stored by `ez login`; it never
accepts or prints a session cookie or password.

The token needs `time_entries:read` for time, `projects:read` for projects and
project budgets, `reports:read` for uninvoiced and client-rollup reports, and
`clients:read` when a report identifies a client by name. The API remains the
authority for row access and profile-based redaction.

```sh
ez login --token-stdin --org conflict
claude mcp add --transport stdio --scope local ezacto -- \
  ezacto-mcp --org conflict
claude mcp get ezacto
```

Inside Claude Code, `/mcp` shows connection status. A useful smoke test is:

> What's uninvoiced for northpeak?

Names and codes are matched exactly after case and punctuation normalization;
ambiguous matches fail instead of selecting an arbitrary record. Without an
explicit `from` or `to`, report tools cover the full supported date range.

For a config outside the default XDG location, pass `--config PATH` or set
`EZACTO_CONFIG`. Use `--org NAME` to select a non-active organization.
