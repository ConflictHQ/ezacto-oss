# Architecture (from decisions D2–D7, D13–D14 — canonical records in the umbrella repo (ConflictHQ/ezacto))

- **Runtime:** TypeScript + Hono + Drizzle. Worker (default) + container. Hono and
  Drizzle both run on both targets; entry points are thin.
- **Data:** SQLite dialect everywhere. Hosted = D1, one database per organization
  (tenancy is a connection). Self-host container = one SQLite file. Current
  recovery is D1 Time Travel or a stopped-container physical snapshot; the D18
  nightly R2 and portable logical exports remain tracked by #37 and #28.
  D1 limits designed against: 100 bound params/statement, 1000 statements/invocation,
  30s/query, 10 GB/db.
- **API:** REST `/api/v1` (canonical, honest) + `/harvest/v2` shim (compat quirks at
  the serializer only). OpenAPI generated and published; cli/mcp/mobile/extension
  consume generated clients. Webhooks are additive (Harvest has none).
- **Auth:** pluggable `Identity` seam. Access impl first (verify JWT signature
  against team-domain JWKS; never bare CF-Access-* headers). Native magic-link +
  password at v1.0.
- **Email:** pluggable `Mailer`, HTTP-first (Workers cannot SMTP; SMTP is
  container-only). **AWS SES v2** is the first implementation, using SigV4 from
  the Worker and lifted from `ConflictHQ/mailsend`. Every send is a queued job
  with a logged delivery outcome. Suppression is checked before send; receipts
  retain the SES message ID, request ID, and latency. Send as the user's domain
  (SPF/DKIM/DMARC aligned), from a dedicated sending subdomain so transactional
  mail cannot damage the deliverability of humans' inboxes on the apex.
- **Money:** users-get-paid only. Checkout shape (Stripe/PayPal/QBO pay links +
  webhooks) and reconciliation shape (Mercury: reference tokens, suggested-match
  queue, unmatched state). **We never hold funds. No billing code exists here.**
- **Jobs:** Cloudflare Queues on Workers / in-process queue in container, one
  interface. Reminders are scheduled jobs cancelled on payment, not cron scans.
