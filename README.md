# ezacto-oss

Open-source time tracking & invoicing — the Harvest replacement. Single org, free.

**Private pre-release.** This repo goes public at the OSS gate (we run our own
books on it). The database, native API, Worker entry, versioned OpenAPI contract,
generated TypeScript client, and `ez` CLI are under active construction per `PLAN.md`.
Start at [`bootstrap.md`](bootstrap.md). Licence: to be chosen before the public
flip (D8).

Self-hosting:

- [Cloudflare Workers guide](docs/self-host-worker.md)
- [single-container, no-Cloudflare guide](docs/self-host-container.md)
- [backup and restore status and tested container procedure](RESTORE.md)
