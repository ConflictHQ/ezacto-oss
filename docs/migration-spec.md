> Localized copy for the build. Source of truth: ezacto `knowledge/docs/`.
> Synced 2026-08-25 — if editing, edit the brain copy and re-sync.

---
title: ezacto-migrate — Harvest Extraction & Migration Specification
type: spec
status: draft
version: 0.1.0
date: 2026-08-25
sources:
  - knowledge/research/harvest-api-v2.md
  - knowledge/docs/domain-model.md
  - knowledge/research/harvest-market.md
---

# ezacto-migrate

The wedge (D7) and the acceptance test for the domain model (PLANNING-PLAN §5). Runs
first against CONFLICT's own account — the OSS gate — then, unchanged, for anyone
leaving Harvest.

**Definition of done for a migration:** the reconciliation report (§6) shows zero
unexplained deltas, and every explained delta is one of the documented gaps in §7.
"It imported without errors" is not done.

Product shape: a standalone CLI (published as `ezacto-migrate`, built from the oss
repo's `packages/migrate`), zero dependency on the rest of
ezacto at extract time. Extract works even if you never install ezacto — that is the
point of the wedge: **get your data out first, decide later.**

```
ezacto-migrate auth        # PAT + account discovery
ezacto-migrate extract     # Harvest → snapshot dir (resumable)
ezacto-migrate verify      # snapshot internal consistency + reports checksums
ezacto-migrate load        # snapshot → ezacto org DB (D1 or SQLite file)
ezacto-migrate reconcile   # ezacto DB ↔ snapshot ↔ Harvest reports
ezacto-migrate sync        # incremental updated_since re-extract + upsert (parallel-run)
```

---

## 1. Auth & preflight

PAT only (no OAuth app needed for a one-shot tool). Headers on every call:
`Authorization: Bearer`, `Harvest-Account-Id`, `User-Agent: ezacto-migrate (email)` —
the missing `User-Agent` 400 is the first support ticket otherwise.

Preflight sequence:

1. `GET id.getharvest.com/api/v2/accounts` — enumerate accounts, pick, resolve
   `Harvest-Account-Id` (never ask the user to find it in the UI).
2. `GET /v2/company` — record `wants_timestamp_timers` (which time-entry shape to
   expect), `clock` (how to parse `started_time`/`ended_time` strings back to
   canonical `HH:MM`), the four `*_feature` flags (which trees will be absent), and
   display settings (imported into `organization`).
3. `GET /v2/users/me` — confirm the token's user is an administrator; warn loudly if
   not (a member-scoped extract silently sees a fraction of the account).

## 2. Extract

### 2.1 Order (FK-safe, from research §15.3)

```
 1 company                         7 projects
 2 users → per-user billable_rates, 8 task_assignments      (account-wide sweep)
   cost_rates, teammates            9 user_assignments       (account-wide sweep,
 3 roles                              is_active=true AND =false)
 4 clients → contacts             10 estimates → messages
 5 tasks                          11 invoices → messages, payments
 6 expense_categories,            12 time_entries            (windowed from/to)
   invoice_item_categories,       13 expenses (windowed) → receipt binaries
   estimate_item_categories       14 reports checksums       (reports budget)
```

Account-wide assignment sweeps (8, 9), not per-project loops. Explicitly sweep
`is_active=false` too — `users/{id}/project_assignments` only returns active.

### 2.2 Rate budget

General endpoints: **100 req / 15 s**; reports: **100 req / 15 min**. Steps 1–13 use
only the general budget; step 14 is the sole reports consumer. Client behavior:
token bucket at ~6 req/s sustained, honor `Retry-After` on 429, exponential backoff
on 5xx. Cost model for our account (~57 invoices): the per-invoice message+payment
loops dominate at 2 calls each — minutes, not hours. Print a call-count estimate
before starting.

### 2.3 Snapshot format (the load-bearing artifact)

A directory, not a database — inspectable, diffable, committable if the user wants:

```
snapshot/
├── manifest.json          # account id, company name, started/finished_at,
│                          # tool version, per-resource counts + page counts,
│                          # updated_since watermark per resource
├── raw/<resource>.jsonl   # one Harvest object per line, verbatim, unmodified
├── receipts/<expense_id>.<ext>
└── checksums.json         # step-14 report aggregates (§6)
```

**Raw means raw.** No transformation at extract time — transform bugs must be fixable
by re-running `load` without re-extracting (the extract is the expensive, rate-limited
step; the transform is free). Pagination follows the response `links` verbatim (doc
mandate), `per_page=2000`, cursor mode.

### 2.4 Resumability

After every page: append objects, fsync, update `manifest.json` progress. A crash or
429 storm resumes mid-resource from the last cursor. `extract` re-run on a complete
snapshot becomes an incremental pass using per-resource `updated_since` watermarks.
**Deletes are invisible to `updated_since`** (no webhooks, research §13) — `sync`
therefore also does periodic full-ID sweeps per resource and marks vanished ids as
deleted-upstream in the manifest.

## 3. Transform & load

Consumes `raw/`, produces an ezacto org DB. Pure function of the snapshot: same
snapshot in, byte-identical DB out (ordering fixed, timestamps carried from source).

Key mappings (details in domain-model §7):

| Harvest | ezacto | Rule |
| --- | --- | --- |
| ids | `harvest_id` columns | Native ids assigned fresh; every table keeps the Harvest id, unique-indexed — this is what makes `sync` upserts and the shim's id echo possible. |
| decimal hours | `seconds` | ×3600, round half-even, record residue in load report if any. |
| money decimals | cents | ×100 exact; **fail loudly** on >2 decimal places, never round silently. |
| `started_time` "8:00am" | `HH:MM` | Parse per snapshot `company.clock`. |
| `access_roles` array | `profile` + `manager_grants` | Per domain-model §2.2. |
| `is_billable`+`is_fixed_fee` | `billing_method` | Truth table; conflicting combos (billable=false, fixed_fee=true) recorded as anomalies, imported as `non_billable`. |
| billable/cost rate rows | append-only tables | Verify Harvest's derived `end_date` chain matches ours (invariant 8); mismatch = anomaly, ours wins. |
| entry `billable_rate`/`cost_rate` | snapshot columns | **Copied verbatim from Harvest, never re-resolved** — Harvest's historical resolution is truth for imported rows. |
| `payment_gateway`/`transaction_id` | `provider=manual` + `provider_transaction_id` | Historical payments import as manual records. |
| invoice `state` + timestamps | same | States imported as-is; state machine governs post-import mutations only. |

### 3.1 D1 write constraints (from D3 — designed in, not discovered)

- ≤100 bound parameters per statement ⇒ batch inserts at `floor(100 / column_count)`
  rows per statement.
- ≤1000 statements per Worker invocation ⇒ when loading to hosted D1, `load` runs as
  a queued, checkpointed job consuming the snapshot from R2; local SQLite loads have
  no such ceiling and are the default dev path.
- 30 s query duration ⇒ no mega-transactions; chunk per-resource with a
  load-progress table so a resumed load is idempotent (INSERT OR REPLACE keyed on
  `harvest_id`).

## 4. Receipts

Download every `receipt.url` binary; store under content hash; verify
`file_size` matches. Failures are anomalies, not fatal (Harvest serves receipts
through time-limited URLs — re-extract refreshes them).

## 5. The `sync` loop (parallel-run)

Market research: switchers parallel-run for up to a **year**. So `sync` is not a
convenience — it is the adoption path. `extract --since` + upsert-by-`harvest_id`
+ delete detection, run on a schedule. One-directional (Harvest → ezacto) forever;
we never write back. Cutover is: stop syncing, start entering time in ezacto,
keep Harvest read-only until the subscription lapses.

## 6. Reconciliation (the actual gate)

Three-way check, emitted as `reconciliation-report.md` + machine-readable JSON:

**A. Snapshot ↔ Harvest reports** (step 14, reports budget):
- `reports/time/{clients,projects,tasks,team}` per fiscal year of account history:
  total_hours, billable_hours, billable_amount per row.
- `reports/expenses/*` same grains; `reports/uninvoiced` current period;
  `reports/project_budget` spent/remaining.
- Rows are **per-currency** (research §12.1) — group accordingly or every
  multi-currency client is a false delta.

**B. ezacto DB ↔ snapshot**: row counts per resource; Σ seconds and Σ cents per
(user, project, month) — invariant 14; invoice totals/due per invoice to the cent;
retainer dangling-id count (expected, §7).

**C. ezacto DB internal**: domain-model §8 invariants run as checks against imported
data (notably 4, 5, 8, 11).

Every delta is classified: `rounding` (bounded, explained), `gap` (§7, enumerated),
or `UNEXPLAINED` (fails the run). The report prints the three classes separately;
the gate is zero UNEXPLAINED.

## 7. Known, documented gaps (from research — decided handling)

| Gap | Handling |
| --- | --- |
| **Retainers: no API.** Invoices reference dangling `retainer.id`s. | Create stub `retainer` rows from the distinct ids found on invoices; balances unknowable via API. `migrate finish-retainers` prints a worksheet (client, linked invoices) for manual balance entry from the Harvest UI (we have exactly 1 ongoing retainer: TeamOne, $24,000 — five minutes of typing). Ledger opens with a manual `adjustment` entry. |
| **Recurring invoices: no API.** `recurring_invoice_id` dangles. | Same: stub rows + worksheet from the UI's 3 visible definitions (subject template, cadence, amount are all on screen — HRVST20/15). |
| **Estimates/approval/activity-log modules disabled** on our account | Nothing to extract; extractor skips per company feature flags and says so. |
| Report-only fields (utilization) | Derived, not stored — recomputed by ezacto; reconciled in A. |
| Forecast | Out of scope (research §14). |
| `statement_key`/`client_key` secrets | **Not imported.** Regenerated — importing another system's public-URL bearer tokens imports its leak surface. Old Harvest links die at cutover; release note item. |
| Avatars | Best-effort download; failures cosmetic. |

## 8. Milestones

| # | Milestone | Proves |
| --- | --- | --- |
| M1 | `auth` + `extract` complete against CONFLICT account, resumable, manifest counts match UI spot-checks | API client + snapshot format |
| M2 | `verify` + checksums | reports budget handling, per-currency grouping |
| M3 | `load` to local SQLite, invariants pass | **the domain model itself** — this is the S3 gate |
| M4 | `reconcile` zero UNEXPLAINED | end-to-end losslessness |
| M5 | `load` to hosted D1 via queue | D1 constraint handling |
| M6 | `sync` steady-state for 2+ weeks | parallel-run viability |
| M7 | retainer/recurring worksheets done, books balance | the manual-gap path |

M3 failing is a **domain-model bug first** — fix the model, then the loader.
