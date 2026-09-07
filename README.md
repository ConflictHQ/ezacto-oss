# ezacto-oss

Open-source time tracking & invoicing — the Harvest replacement. Single org, free.

**Private pre-release.** This repo goes public at the OSS gate (we run our own
books on it). The database, native API, Worker entry, versioned OpenAPI contract,
generated TypeScript client, and `ez` CLI are under active construction per `PLAN.md`.
Start at [`bootstrap.md`](bootstrap.md).

## Licence

[GNU AGPL v3](LICENSE), copyright CONFLICT LLC. Self-host it, modify it, run it
inside your company — that costs you nothing and obliges you to nothing. Offer a
*modified* ezacto to others as a network service and you owe those users the
source of your modifications.

CONFLICT LLC also offers ezacto under commercial terms for anyone who does not
want that obligation. Keeping both possible is why contributions need the
agreement in [`CLA.md`](CLA.md) — see [`CONTRIBUTING.md`](CONTRIBUTING.md) for
the reasoning.

Self-hosting:

- [Cloudflare Workers guide](docs/self-host-worker.md)
- [single-container, no-Cloudflare guide](docs/self-host-container.md)
- [backup and restore status and tested container procedure](RESTORE.md)
