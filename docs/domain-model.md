> Localized copy for the build. Source of truth: ezacto `knowledge/docs/`.
> Synced 2026-08-27 — if editing, edit the brain copy and re-sync.

---
title: ezacto — Domain Model Specification
type: spec
status: draft
version: 0.1.0
date: 2026-08-25
sources:
  - knowledge/research/harvest-api-v2.md
  - HRVST20/UI-INVENTORY.md
  - knowledge/decisions/D2-D7-proposed.md
  - knowledge/decisions/D13-money-movement.md
  - knowledge/decisions/D14-email.md
  - knowledge/decisions/D21-invoice-totals-and-payments.md
---

# ezacto Domain Model

Everything downstream cites this document. Its acceptance gate (PLANNING-PLAN §5,
S3): **every row of CONFLICT's real Harvest export must be expressible in this model,
losslessly.** The migration spec (`migration-spec.md`) is the executable test of that
claim; where the two disagree, one of them is wrong and the discrepancy is a bug to
resolve, not to paper over.

Design stance, in order of precedence:

1. **Losslessly import everything Harvest can export.** (Compat is a mapping problem,
   not a schema problem.)
2. **Do not inherit Harvest's mistakes into our native model.** Canonical times not
   locale strings, rejected writes not silent drops, first-class retainers and
   recurring invoices, webhooks.
3. **Structural tenancy.** One organization = one database (D3). No `org_id` column
   exists anywhere; the tenant boundary is the connection.

---

## 1. Conventions

| Concern | Rule |
| --- | --- |
| Primary keys | `id INTEGER PRIMARY KEY` (SQLite rowid, 64-bit). External/API ids are the same value — no UUID double-bookkeeping. Harvest ids preserved on import in `harvest_id` columns (unique, nullable). |
| Money | `INTEGER` **cents** + `currency` (ISO 4217 `TEXT`). Never floats. Display formatting (symbol/code position, separators) is an org setting, not data. |
| Hours | `INTEGER` **seconds** internally. The API serializes decimal hours for compat, but seconds is truth — it is exact, sums cleanly, and matches Harvest's own `weekly_capacity` (already seconds). |
| Dates | `TEXT` ISO 8601 date (`2026-08-25`). |
| Timestamps | `TEXT` ISO 8601 UTC with `Z`. Every table carries `created_at`, `updated_at`. |
| Times of day | `TEXT` canonical 24h `HH:MM`. **Never locale-formatted in storage.** The Harvest compat shim formats per the org's `clock` setting at the serializer only. |
| Soft delete | Archival via `is_active`/`archived_at`, matching Harvest's model. Hard delete only where Harvest allows it (e.g. a user with no time or expenses). |
| Enums | `TEXT` with CHECK constraints; lowercase snake values in our native model even where Harvest mixes case (`bill_by: 'Project'` → `bill_by: 'project'`; the shim maps case). |

### 1.1 Tenancy shape

```
account DB (SaaS catalog only; absent in OSS)   org DB (one per organization)
├── accounts                                    ├── organization   (singleton row)
├── organizations → database binding            ├── users, clients, projects, …
└── billing (Stripe)                            └── everything below
```

The OSS SKU is exactly one org DB. Nothing in this spec references the catalog.

---

## 2. Entity catalog

### 2.1 `organization` (singleton)

Harvest's `company` + the Preferences/Modules settings surface (UI inventory §38).

| Field | Type | Notes |
| --- | --- | --- |
| `name` | text | |
| `address` | text | Multiline. One address; the invoice-config and e-invoicing addresses reference it or override (see `invoice_config`). |
| `week_start_day` | enum `saturday\|sunday\|monday` | |
| `time_entry_mode` | enum `duration\|start_end` | = Harvest `wants_timestamp_timers` inverted naming. Org-wide, like Harvest. |
| `time_format` | enum `decimal\|hours_minutes` | Display only. |
| `clock` | enum `12h\|24h` | Display + compat-shim serialization only. |
| `date_format` | text | One of Harvest's six patterns. |
| `currency` | text | Org default currency. |
| `currency_code_display` / `currency_symbol_display` | enum | As Harvest. |
| `decimal_symbol` / `thousands_separator` | text | |
| `weekly_capacity_default` | int seconds | Default 126000 (35h) for compat; ours surfaces it in Preferences. |
| `fiscal_year_start_month` | int 1–12 | UI-only in Harvest; first-class here. |
| `timesheet_deadline` | `{day, time}` | Nullable. |
| `reminder_policy` | json | Offsets + capacity-threshold %, per UI 30b. |
| `auto_lock` / `auto_submit` | bool | Harvest "NEW" prefs. |
| `time_entry_notes_required` | bool | |
| `time_rounding` | enum `none\|nearest_6\|nearest_15\|nearest_30\|up_6\|up_15\|up_30` | The complete setting set evidenced by [Harvest's Preferences controls](https://support.getharvest.com/hc/en-us/articles/360048179912-Customizing-account-preferences). Drives native `rounded_seconds` (§3.4). |
| `modules` | json | Feature flags: `expenses, invoices, estimates, approval, team, client_portal, activity_log`. Disabled modules disappear from nav (UI §38 Modules — keep this). |
| `require_2fa` / `require_sso` | bool | Commercial-tier enforcement; columns exist in OSS, enforcement is Identity-seam concern (D4). |

### 2.2 `user`

| Field | Type | Notes |
| --- | --- | --- |
| `first_name`, `last_name`, `email` | text | Email unique. |
| `telephone` | text | Present on Harvest object; import it. |
| `employee_id` | text | UI 09a; **not in Harvest API** — import blank, UI-editable. |
| `timezone` | text | IANA. |
| `is_contractor` | bool | Drives contractor report + payout surfaces (D13 lane C). |
| `is_active` | bool | |
| `has_access_to_all_future_projects` | bool | Standing assignment grant. |
| `weekly_capacity` | int seconds | Per person (UI shows 50/40/25/20/15h in our own account). |
| `profile` | enum `member\|project_manager\|people_admin\|accounting\|executive_manager\|administrator` | §5. |
| `is_owner` | bool | Exactly one true. Owner's profile is immutable-administrator (UI 09e). |
| `roles` | m2m → `role` | Free-text business labels. **No permission effect** (Harvest doc, verbatim). |
| `departments` | m2m → `department` | UI 09a; not in Harvest API. |
| `avatar_url` | text | |
| `saml_exempt` | bool | Import-only until SSO exists. |

**Deviation:** Harvest's `access_roles` array (base role + manager sub-roles) maps
onto `profile` + a `manager_grants` json column for the seven manager sub-roles.
Import preserves the full array; native UI exposes the six-profile radio (UI 09e)
first and grants later.

Delete rule (Harvest parity): hard delete only when the user has no time entries and
no expenses; otherwise archive.

### 2.3 `user_billable_rate` / `user_cost_rate` — append-only, effective-dated

| Field | Type | Notes |
| --- | --- | --- |
| `user_id` | fk | |
| `amount_cents` | int | |
| `start_date` | date nullable | null = "all prior". Cannot be future (Harvest parity). |
| `end_date` | date nullable | **Derived**: next row's start − 1 day; open-ended newest. Never written directly. |

No update, no delete (matches Harvest: POST-only). A rate correction is a new row.
These tables are the source that time-entry snapshots (§3.3) resolve against.

### 2.4 `role`, `department`

`role`: `{name, user_ids}` — report-filter labels only. `department`: same shape, from
UI 09a. Neither carries permissions.

### 2.5 `teammate_assignment`

Manager → managed users. `(manager_id, user_id)` rows; **PATCH is set-semantics** in
the compat shim (full replace, per API doc). Gated by `modules.team`.

### 2.6 `client`

| Field | Type | Notes |
| --- | --- | --- |
| `name` | text | |
| `address` | text | |
| `currency` | text | Defaults to org currency. |
| `is_active` | bool | |
| `statement_key` | text | Server-generated opaque secret; grants unauthenticated statement URL. Never accepted on write. Rotatable. |
| `payment_terms` | enum `upon_receipt\|net_15\|net_30\|net_45\|net_60\|custom` | UI 35 puts terms/tax/discount defaults on the client; API doesn't. First-class here, exported to shim as extension. |
| `default_tax_pct`, `default_tax2_pct`, `default_discount_pct` | real nullable | Invoice defaults (UI 35). |

### 2.7 `contact`

`client_id` fk, `title`, `first_name` (required), `last_name`, `email`,
`phone_office`, `phone_mobile`, `fax`, `invoice_recipient_status` enum
`none|recipient|cc|bcc` (drives default recipient population on invoice messages).
Contacts are reassignable between clients (Harvest parity).

### 2.8 `project`

| Field | Type | Notes |
| --- | --- | --- |
| `client_id` | fk | **Immutable while invoices are linked** (UI 28 invariant — enforce, don't just document). |
| `name`, `code` | text | Code shown as `[code]` prefix everywhere. |
| `is_active` | bool | |
| `billing_method` | enum `non_billable\|time_materials\|fixed_fee` | Collapses Harvest's `is_billable` + `is_fixed_fee` + pill vocabulary into one honest enum. Shim maps back. |
| `bill_by` | enum `project\|tasks\|people\|none` | Rate-resolution selector (§4). |
| `hourly_rate_cents` | int nullable | Used when `bill_by = project`. |
| `fee_cents` | int nullable | Fixed-fee amount. |
| `budget_by` | enum `project\|project_cost\|task\|task_fees\|person\|none` | |
| `budget_seconds` | int nullable | Hours budgets. |
| `cost_budget_cents` | int nullable | Money budgets. |
| `budget_is_monthly` | bool | The ↻ resetting budget. |
| `cost_budget_include_expenses` | bool | |
| `notify_when_over_budget` / `over_budget_pct` / `over_budget_notified_on` | bool / real / date | |
| `show_budget_to_all` | bool | |
| `report_visibility` | enum `managers\|everyone` | UI 28 permissions radio. |
| `starts_on`, `ends_on` | date nullable | Non-blocking (time can be tracked outside range). |
| `notes` | text | Admin-visible only (UI 28). |
| `tags` | m2m → `project_tag` | UI 28/23a; not in Harvest API — import n/a. |
| `billing_currency` | text nullable | UI 28: project rate currency; costs always org currency. |

`project_tag`: `name`; projects and tags use a many-to-many join whose primary key is
`(project_id, project_tag_id)`. Tags are native metadata: Harvest exposes no project-tag
API, so migration does not synthesize them.

**Milestones** (Harvest "What's new" Aug 2026): `project_milestone` table
`{project_id, name, amount_cents, due_on, invoiced_invoice_id}` — fixed-fee schedule
billing. In scope for the model, later phase for UI.

### 2.9 `task`

`name`, `billable_by_default` (default true), `default_hourly_rate_cents`,
`is_default` (auto-added to new projects — "Common tasks"), `is_active`. Account-global
template; the project instance is `task_assignment`.

### 2.10 `task_assignment`

`project_id` + `task_id` unique. `is_active`, `billable`, `hourly_rate_cents`
(used when `bill_by = tasks`), `budget_seconds` / `budget_cents` (used when
`budget_by ∈ {task, task_fees}`).

Compat quirk preserved in the shim only: Harvest defaults `billable=false` on explicit
POST but seeds from `task.billable_by_default` during project creation. **Our native
API defaults from the task template in both paths** — the sane behavior — and the shim
reproduces Harvest's inconsistency.

### 2.11 `user_assignment`

`project_id` + `user_id` unique. `is_active`, `is_project_manager`,
`use_default_rates` (true → resolve via §2.3 tables; false → this row's
`hourly_rate_cents`), `budget_seconds` (when `budget_by = person`).

### 2.12 `time_entry` — the core object

| Field | Type | Notes |
| --- | --- | --- |
| `user_id`, `project_id`, `task_id` | fk | `user_assignment_id`, `task_assignment_id` resolved and stored too (fast joins + Harvest-shaped embeds). |
| `spent_date` | date | |
| `seconds` | int | Truth. Decimal `hours` is a serialization. |
| `seconds_without_timer` | int | Non-null elapsed checkpoint for both tracking modes. While stopped it equals `seconds`; while running it is the accumulated duration before the current run. Live elapsed adds `(now − timer_started_at)` in duration mode or `(now − spent_date+started_time)` in start/end mode. |
| `rounded_seconds` | int | **Stored, not computed at read** (§3.4). |
| `timer_started_at` | timestamp nullable | Non-null ⇔ running (duration mode). |
| `started_time`, `ended_time` | time nullable | Start/end mode. Canonical `HH:MM`. Running ⇔ `ended_time` null. |
| `notes` | text | Org may require (`time_entry_notes_required`). |
| `billable` | bool | Inherited from task_assignment at creation; never client-supplied on create (compat). |
| `budgeted` | bool | Independent of billable. |
| `billable_rate_cents`, `cost_rate_cents` | int nullable | Exactly two independent snapshots (§3.3). Null means unresolved or not applicable; never substitute zero. |
| `approval_status` | enum `unsubmitted\|submitted\|approved` | Axis 1. |
| `invoice_id` | fk nullable | Axis 2; `is_billed` ⇔ non-null. |
| `external_ref` | json nullable | `{id, group_id, account_id, permalink}` + derived `{service, service_icon_url}` from a service registry keyed on permalink host. `id` indexed **as text**. |
| `calendar_event_ref` | json nullable | UI 33/39 "Pull in a calendar event". |

`is_locked` and `locked_reason` are **derived, never stored** (§3.2).

Invoice-FK staging: the projects/time migration does not create bare or unconstrained
`time_entry.invoice_id` or `project_milestone.invoiced_invoice_id` columns. The money
migration creates `invoice` first, then adds both columns as nullable real foreign keys.
The entity catalog describes the resulting final schema.

Timer semantics (hard compat requirement): creating an entry while omitting the
terminating field (`hours`/`seconds` in duration mode, `ended_time` in start/end mode)
**starts a running timer**. `stop`/`restart` are explicit operations. At most one
running entry per user; starting a new one stops the previous (Harvest behavior).

**Native-API deviation from Harvest:** writes to locked entries return `422` with a
machine-readable reason. The compat shim reproduces Harvest's silent field-drop for
locked expenses only, because clients depend on it.

### 2.13 `expense` / `expense_category` / `attachment`

`expense`: `user_id`, `project_id`, `expense_category_id`, `spent_date`, `notes`,
`units` nullable, `total_cost_cents`, `billable` (default **true**), same three-axis
state as time entries (shared implementation), `invoice_id` nullable,
with attachments related through the shared attachment model rather than a dedicated
receipt column.

Unit rule: category has `unit_price_cents` ⇒ client sends `units`, we compute
`total_cost = units × unit_price`; else client sends `total_cost` directly.

`expense_category`: `name`, `unit_name`, `unit_price_cents` nullable, `is_active`.
Delete disabled while referenced (UI 07) — enforce with FK RESTRICT + archive path.

`file_object` is content-addressed binary identity: content hash, `file_key` on
R2/disk, file size, and content type. `attachment` is the logical file name,
uploader, and reference to that object. Owner-specific join tables use real foreign
keys for invoice, recurring definition, estimate, expense, or project ownership;
there is no unchecked generic `owner_type/owner_id`. A Harvest receipt is an
expense-owned attachment in native storage; `receipt` survives only as a Harvest
shim/extract vocabulary. Static recurring attachment policy belongs to this model;
generated-report attachments remain downstream of F2 + F6. This is the one
multipart surface in the API.

Reimbursement (UI 06, gated in Harvest): `reimbursable` bool, `reimbursement_status`
enum `none|pending|approved|paid`, `payout_ref` — columns in the model now, surfaces
later; lane-C rules from D13 apply.

### 2.14 `invoice`

| Field | Type | Notes |
| --- | --- | --- |
| `client_id` | fk | |
| `created_by_user_id` | fk nullable | Native creator when resolvable; imports also retain immutable source creator id/name provenance so deleted Harvest users do not erase attribution. |
| `number` | text unique | Auto-sequence when omitted. |
| `subject`, `purchase_order`, `notes` | text | |
| `currency` | text | |
| `issue_date`, `due_date` | date | `payment_terms` enum as client. |
| `tax_rate_ppm`, `tax2_rate_ppm`, `discount_rate_ppm` | int nullable | Exact parts per million of one (`72_500 = 7.25%`), each `0..1_000_000`; decimal-percent inputs parse exactly and reject beyond four fractional percentage digits (D21). |
| `state` | enum `draft\|open\|paid\|closed` | **Never directly writable** (§6). |
| `sent_at`, `paid_at`, `paid_date`, `closed_at` | ts/date nullable | State-machine outputs. |
| `period_start`, `period_end` | date nullable | Derived from imported line items. |
| `client_key` | text | Server-generated public-URL secret; rotatable. |
| `estimate_id`, `retainer_id`, `recurring_invoice_id`, `project_id` | fk nullable | All **real FKs** here — Harvest dangles two of these with no API. `project_id` is the UI 19 "linked project". |
| `reminder_policy` | json nullable | `{first_after_days, every_days}` (UI 19). Scheduled via queue jobs (D14). |
| `payment_options` | json | Unique native option set: `stripe_checkout`, `paypal_checkout`, `quickbooks_checkout`, `mercury_transfer`, `wise_transfer`, `bill_com_checkout`, `bill_com_transfer`. Bill.com is reserved vocabulary, not a claimed adapter. Harvest's `[ach, credit_card, paypal]` is preserved separately and mapped only where unambiguous. |
| Derived (read-only): `amount_cents`, `due_amount_cents`, `tax_amount_cents`, `tax2_amount_cents`, `discount_amount_cents`, `written_off_cents` | | Computed from line items + payments; stored for query speed, recomputed on any mutation in the same transaction. |

**Exact totals (D21).** Discount applies before both parallel, non-compounding taxes.
The discount share of the subtotal and of each independently taxable base rounds
half-away-from-zero, then each tax rounds by the same signed rule. The aggregate order
is consistent with Harvest's documented “subtotal, including ... discounts” tax base;
the partial-tax allocation and midpoint rule are ezacto-native, not a parity claim.
Calculations use integer cents/rates only and reject signed aggregate overflow above
`9_000_000_000_000` cents. Importer-owned source total/payment-option observations
refresh atomically only for a newer Harvest `updated_at` and retain the latest source
record when its undocumented boundary behavior differs from the native rule.

`invoice_line_item`: `invoice_id`, `position`, `kind` (**denormalized category name
string** — loose coupling is Harvest-correct and we keep it), `description` (rich
text), `quantity` (real — decimal on invoices), `unit_price_cents`, `amount_cents`
derived, `taxed`, `taxed2`, `project_id` nullable. Line items mutate **only through
the invoice** (add / update-by-id / `_destroy`), transactionally with totals.

`invoice_item_category`: `name`, `use_as_service`, `use_as_expense` — the flags are
API-writable in our native model (Harvest gates them to UI; shim keeps them
read-only).

**Invoice generation from tracked time** (`line_items_import`): finds uninvoiced
billable time (by `rounded_seconds`) and expenses for given projects/date range,
rolls up per `summary_type` (`project|task|people|detailed` / expenses
`project|category|people|detailed`), prices via §4, creates lines, and **links every
consumed entry/expense to the invoice in one transaction**. Double-billing is a
correctness bug class; this write is the reason invoice creation is transactional.

### 2.15 `invoice_message` / `estimate_message`

First-class records (they drive the state machines): immutable scalar sender
snapshots `sent_by`, `sent_by_email`, `sent_from`, `sent_from_email`; a nullable
real `sender_identity_id` relation may be added when the email schema exists, but is
never required for historical provenance and is never a bare placeholder.
Common fields are `recipients` json `[{name,email}]`, `subject`, `body`,
`send_me_a_copy`, and nullable `event_type`, **plus delivery outcome**
`delivery_status` enum
`queued|sent|bounced|complained|failed` and `provider_message_id` (D14 feedback loop —
our addition; Harvest has nothing).

Invoice messages additionally carry `attach_pdf`, `thank_you`, `reminder`, and
`send_reminder_on`. Estimate messages do not grow those invoice-only columns, and
their recipients are required on native sends, matching the source contract.

Writable invoice `event_type`: `send|close|re-open|draft`. Estimate:
`send|accept|decline|re-open`; `view` and `invoice` are **system-emitted only** and
rejected on write.

### 2.16 `invoice_payment`

Per D13/D21: `invoice_id`, positive `amount_cents`, `paid_at` **or** `paid_date`
(exactly one), immutable payment `currency`, `notes`, `recorded_by_user_id` nullable
(null = system/webhook),
`payment_provider` enum
`manual|stripe|paypal|quickbooks|mercury|wise|bill_com`, `provider_shape` enum
`manual|checkout|reconciliation`, nullable real provider-account FK, provider
transaction id, nullable unique bank-deposit FK, and canonical timestamps. Provider
and shape use the exact D21 matrix; external transaction identity is unique within
its real provider account. Imported and native external/bank-confirmed payments are
immutable except delete/re-create; native manual corrections follow D21's narrower
update rules.

Harvest imports map to `manual/manual` rather than guessing from gateway names and
retain immutable raw `source_paid_at`/`source_paid_date`, recorder name/email, and
gateway id/name provenance. Storage keeps canonical `paid_at` XOR `paid_date`; the
importer prefers a source timestamp when Harvest responses populate both, records a
date-disagreement anomaly, and the shim re-emits the preserved pair. Native
`send_thank_you` is command behavior defaulting false (the shim defaults true for
compat), not a stored historical field.

Payment currency must equal invoice currency at insert/confirmation. Invoice currency
is immutable while any payment or suggested/confirmed bank deposit refers to it.
`harvest_id IS NOT NULL` distinguishes immutable imported manual payments from
correctable native `manual/manual` rows.

`payment_provider_account` is credential-free provider/account identity. Credentials
arrive with later integrations. `bank_deposit` references a reconciliation-shaped
account and stores stable per-account provider transaction id, posted timestamp,
amount cents, currency, memo, counterparty, `suggested_invoice_id`, and
`match_state = unmatched|suggested|confirmed`. A suggestion creates no payment and
does not change due. Explicit confirmation atomically creates the one applied payment;
deleting it unconfirms the deposit. `match_state` therefore belongs to deposit staging,
not to `invoice_payment`.

`invoice.reference_token` is nullable except when a transfer option is enabled; it is
server-generated as unique `EZ-` plus 12 uppercase hex characters and printed for
deposit matching.

### 2.17 `estimate` + `estimate_line_item` + `estimate_item_category`

As Harvest (research §11), including nullable `created_by_user_id` plus immutable
source creator id/name provenance on import, with two fixes: `quantity` is real (consistent with
invoices — the shim serializes int for estimates), and **estimate → invoice
conversion is a first-class operation** (market research: named user complaint;
Harvest emits `event_type: invoice` but has no conversion API). Conversion copies
lines, links `invoice.estimate_id`, emits the `invoice` system event.

**Physical v1 storage contract (#123).** `estimate` persists the Harvest header as
canonical cents, fixed-point percentage rates, canonical dates/timestamps, a
server-generated public `client_key`, optimistic `version`, and state
`draft|sent|accepted|declined`. `estimate_line_item` stores ordered, parent-owned
lines with a bounded `REAL quantity`, denormalized category-name `kind`, integer-cent
price/amount, and tax flags; it deliberately has no project relationship.
`estimate_item_category` is the simpler name-only Harvest category.

`estimate_message` stores the four immutable sender scalars, exact recipient JSON,
subject/body, `send_me_a_copy`, delivery outcome, and all six representable events.
The native write seam accepts only `send|accept|decline|re-open`, requires a nonempty
recipient list for `send`, and rejects `view|invoice`; a separate trusted service seam
records those system events. It has none of the invoice-only PDF, thank-you, reminder,
or scheduled-reminder fields. Migration `0018_estimates` adds the tables and the real
nullable `invoice.estimate_id` FK after the invoice foundation without rewriting
existing invoice rows; cross-client links are rejected.

### 2.18 `retainer` — first-class (Harvest's biggest model gap)

Harvest: no API, no ledger, funds invisible to financial reports. Market research
flags this as a top-four v1 requirement. Ours:

| Field | Type |
| --- | --- |
| `client_id`, `project_id` nullable | fk |
| `state` | enum `ongoing\|closed` |
| `denomination` | enum `money\|hours` |
| `amount_cents` | nullable; required only for a money-denominated contract |
| `seconds` | nullable; required only for an hours-denominated contract (API hours convert per DV-2) |
| `locked_rate_cents`, `rate_locked_at` | nullable pair; hours only |
| `period`, `rollover`, `expires_at`, `on_exhaustion` | F5 policy (`on_exhaustion = overflow` is the explicit overdraw permission) |

For v1 a retainer has **exactly one denomination**: exactly one of `amount_cents` or
`seconds` is populated. The dual-cap form (for example, 100 hours or $15,000,
whichever comes first) is explicitly deferred beyond v1; it must not be approximated
with two balances or two linked retainers in this schema. The deferred contract is
named `retainer-dual-cap-contract`; it has no v1 plan node until that later decision
is shaped.

`retainer_ledger` is append-only: `{retainer_id, kind:
deposit|drawdown|expiry|reset|adjustment, amount, invoice_id nullable, occurred_on,
notes}`. `amount` is cents for a money retainer and seconds for an hours retainer; an
entry must use its parent's denomination. Deposits arrive via deposit-invoices;
drawdowns link the drawing invoice. Balance is a SUM in that denomination and is
never stored; history is the UI (fixes "retainers is a stub", UI critique §5.t).
Accounting treatment for money retainers: deposits are **deferred revenue**,
recognized on drawdown — this is what makes the Profitability report honest where
Harvest's is not.

### 2.19 `recurring_invoice` — first-class (Harvest gap #2)

`client_id`, `subject_template` + `notes_template` (variables `%invoice_issue_month_name%`
etc. — keep Harvest's vocabulary so imports of UI-visible templates render
identically), `cadence` (`every_n_months`, `day_of_month` — **calendar-anchored**,
fixing the "can't generate on the 1st" complaint), `next_issue_on`, `amount` model
(fixed lines json or `line_items_import` config), `auto_send` bool,
`can_draw_from_retainer_id` nullable — recurring invoices **can** draw retainers,
which Harvest documents as impossible. Generation is a scheduled queue job.

**Shared transactional outbox storage (D13 rev / D17; not a recurring-invoice
child):** `event_outbox` has `id` (text
primary key and stable downstream idempotency key), `aggregate_type`,
`aggregate_id`, `aggregate_sequence`, `event_type` (TEXT, intentionally
extensible), `payload_json`, `occurred_at`,
`available_at`, `published_at` nullable, `attempt_count` default 0, and `last_error`
nullable. A unique constraint on `(aggregate_type, aggregate_id,
aggregate_sequence)` makes producer retries idempotent and fixes per-aggregate
order. An index on `(published_at, available_at, occurred_at, id)` supports the
ready-event dequeue; the unique constraint supplies the aggregate-order lookup.
The invoice state machine owns writing events in the same batch as transitions;
the later drainer owns subscriber delivery records and their unique
`(subscriber_id, event_id)` receipt.

### 2.20 `saved_report`

`name`, `owner_user_id`, `definition` json (report type + filters + period), `is_pinned`,
`shared_with` json. Filter state serializes to URL (old-UI analysis recommendation);
a saved report is a named URL state.

### 2.21 Email & config singletons

- `sender_identity`: `{email, display_name, is_default, verification_status,
  dkim_status}` — "Send messages as" (UI 17d) + D14 domain verification.
- `invoice_config` (singleton): company info override, default values (rounding,
  show-total-hours, terms, subject/notes templates, online payments), appearance
  (logo `file_key`, branding mode, brand/background colors), message templates
  (invoice/reminder/thank-you), e-invoicing sender identity (Peppol/UBL fields,
  UI 17e), field-label overrides json (UI 17f), item types (§2.14).
- `email_log`: every outbound message — `{to, template, subject, provider,
  provider_message_id, status, related_type/id}` (D14: mandatory bounce/complaint
  handling needs this).
- `webhook_subscription` (our addition; Harvest has none): `{url, secret, events[],
  is_active}` + `webhook_delivery` log. Event vocabulary v1:
  `time_entry.*, expense.*, invoice.*, invoice_payment.*, project.*, client.*`.

### 2.22 `notification_preference`

Per user (UI 09f): daily reminder `{enabled, time, days[], channels{email, desktop,
slack}}`, `include_in_team_reminders`, `weekly_digest`, `notify_project_deleted`.
No pre-checked marketing opt-in — we are not doing that.

---

## 3. The three-axis state model (time entries and expenses)

Axes are independent; conflating them is the classic clone mistake.

1. **Approval**: `approval_status` — `unsubmitted → submitted → approved`
   (module-gated; when approval module is off, everything stays `unsubmitted` and the
   axis is invisible).
2. **Invoicing**: `invoice_id` nullable. `is_billed` is `invoice_id IS NOT NULL`.
3. **Editability**: `locked = derived(entry)` — true when invoiced, approved,
   an already-computed policy-lock fact is present, or any parent
   (project/task/client) is archived. The policy subsystem owns auto/manual lock
   boundaries and supplies the fact; this derivation does not recalculate policy.

`locked_reason_code` is derived with this stable precedence when more than one cause
applies: `invoiced`, `approved`, `policy_locked`, `client_archived`,
`project_archived`, `task_archived`. Rendered `locked_reason` text is selected from
that code. Neither value is stored; a stored copy would go stale when approval,
invoice linkage, policy, or parent activity changes.

### 3.3 Rate snapshotting

`billable_rate_cents` and `cost_rate_cents` are the two independent, nullable rate
snapshots. Native entry writes copy the §4 resolver's results verbatim; either result
may be null and null is never converted to zero. They are never recomputed on read.
An explicit, auditable reprice operation may rewrite them using the same resolver and
the entry's `spent_date`.

Imported entries instead copy Harvest's historical `billable_rate` and `cost_rate`
verbatim. Import never re-resolves them.

### 3.4 Rounding

The supported settings are exactly:

`none | nearest_6 | nearest_15 | nearest_30 | up_6 | up_15 | up_30`

For a non-negative native duration `s` and increment `q = minutes × 60`:

- `none`: `s`
- `up`: `ceil(s / q) × q`
- `nearest`: `floor((s + q / 2) / q) × q`

At an exact positive midpoint, `nearest` therefore rounds upward. This midpoint
half-up behavior is the proposed ezacto-native rule; Harvest's official controls
establish the available modes and increments, not its undocumented tie behavior.
Tests and documentation must not describe the tie rule as confirmed Harvest parity.

Imported `rounded_hours` is converted and stored verbatim as `rounded_seconds`; it is
not recomputed using the native rule. Invoices and summary reports consume the stored
rounded value; detailed views and timesheets show raw duration.

---

## 4. Rate resolution (one function, cited everywhere)

```
billable_rate(entry) :=
  project.billing_method == non_billable → none
  bill_by = project → project.hourly_rate
  bill_by = tasks   → task_assignment.hourly_rate
  bill_by = people  → user_assignment.use_default_rates
                        ? user_billable_rate effective at entry.spent_date
                        : user_assignment.hourly_rate
  bill_by = none    → none

cost_rate(entry) := user_cost_rate effective at entry.spent_date
budget grain     := budget_by → which of {project.budget_seconds, project.cost_budget_cents,
                    task_assignment.budget_*, user_assignment.budget_seconds} is live
```

Missing-rate handling: a null resolution is **recorded as null**, surfaced as the
data-quality banner with a deep link to fix (UI critique: Harvest warns three times
and never links the fix; we link the bulk set-rates action). Never render `∞%` —
return-on-cost with zero cost displays as `n/a`.

---

## 5. Permissions

Six-profile radio (UI 09e grid transcribed in UI-INVENTORY §3) + the scattered bits
made explicit:

- Project scoping: everyone tracks only to **assigned** projects (admins included).
- `user_assignment.is_project_manager` defines "their team" for `project_manager`.
- Money redaction happens **in the serializer**, not the route: billable rates
  visible to `accounting|executive_manager|administrator` (+ PM when granted); cost
  rates to `administrator` only; money-valued budgets redacted per profile
  (project-budget report returns different fields by viewer — Harvest behavior,
  kept).
- Owner: cannot change own profile; exactly one owner; transfer is explicit.
- The **agent surface inherits the acting user's profile** — D12 groundwork: the
  in-UI agent can never see or do more than its user.

---

## 6. Invoice state machine

```
            send                    payments cover amount
  draft ──────────────► open ────────────────────────────► paid
    ▲                    │  ▲                                │
    │       draft        │  │ re-open        (delete payment)│
    └────────────────────┘  │                                ▼
                     close  ▼                              open
                          closed  (written off)
```

Transitions occur **only** via message `event_type` or payment mutation, in the same
transaction as the triggering record. `paid` is entered automatically when payments
≥ amount; deleting a payment can regress `paid → open`. Native API adds explicit
`POST /invoices/{id}/transitions` sugar that creates the equivalent message —
one mechanism, two spellings.

**Open event-mapping decision.** D13's native vocabulary distinguishes
`invoice.cancelled` from `invoice.written_off`, while Harvest's `close` event and the
current `closed` state collapse those meanings. No authoritative source decides how
the two native events map to state transitions. The outbox therefore stores an
extensible text event type, and the invoice-state story must settle and document
that mapping before it claims those two events; schema work must not invent it.

---

## 7. Harvest compatibility mapping (shim contract)

The shim (`/harvest/v2`) is a serializer + parameter mapper over this model. Load-
bearing mappings, from research §15.4:

| Harvest behavior | Our storage | Shim behavior |
| --- | --- | --- |
| `started_time: "8:00am"` locale strings | canonical `HH:MM` | Format per `org.clock` on read; accept both forms on write. |
| Embedded full `user_assignment`/`task_assignment` on entries | FKs | Rehydrate full embeds in serializer. |
| Implicit timer start on create | same semantics natively | Pass-through. |
| Silent drop of locked-expense field writes | native 422 | Shim swallows exactly the fields Harvest drops, succeeds. |
| `is_closed` deprecated bool | `approval_status` | Serialize both. |
| `hours` decimals | seconds | Serialize decimal(2); accept decimal. |
| Money decimals | cents | Serialize decimal; accept decimal. |
| Line-item `kind` by name | same | Pass-through. |
| `page`/`cursor`/`links` envelope | native cursor | Emit Harvest envelope incl. `per_page` 2000 default. |
| Rate limits | none native | Shim optionally emulates 429s off; not by default. |
| No webhooks | webhooks exist | Additive; no conflict. |

Out of shim scope (no Harvest contract exists): retainers, recurring invoices,
Forecast, webhooks.

---

## 8. Invariants (the testable list)

Each becomes a test in `ezacto-oss`; the migration reconciliation (migration-spec §6)
re-verifies the aggregate ones against imported data.

1. At most one running time entry per user.
2. A running entry has exactly one open terminator (null `ended_time` XOR non-null `timer_started_at`, per org mode).
3. `locked` entries reject mutation in the native API (422), including via bulk ops.
4. Per D21, `invoice.amount = Σ stored line cents − rounded discount + independently rounded taxes on discounted flagged bases`; `due = amount − Σ applied payments − written_off`. Every component is integer/fixed-point and recomputes transactionally with any line/payment/rate/write-off change.
5. `state = paid ⇔ due_amount ≤ 0 ∧ payments > 0`.
6. Every consumed time entry/expense of a generated invoice has `invoice_id` set in the same transaction (no double-billing window).
7. `project.client_id` immutable while any invoice links the project.
8. Rate tables are append-only; `end_date` always equals next `start_date − 1` or null.
9. Entry snapshots never change except via explicit reprice operations (which are logged).
10. `retainer.balance = Σ ledger` in its single denomination and never negative unless `on_exhaustion = overflow` explicitly permits overdraw.
11. Uninvoiced report totals ≡ what invoice generation would produce for the same filter, to the cent.
12. Exactly one `user.is_owner`.
13. Cross-org anything is impossible by construction (separate databases) — the test is that no code path accepts a database handle plus a foreign org id.
14. `Σ time_entry.seconds` per (user, project, month) after import ≡ Harvest reports checksum for same grain (migration gate).

---

## 9. Deliberate deviations from Harvest (summary)

Numbered for citation from specs: **DV-1** canonical times · **DV-2** cents+seconds
storage · **DV-3** 422 on locked writes · **DV-4** first-class retainer ledger ·
**DV-5** first-class recurring invoices incl. retainer drawdown + calendar anchor ·
**DV-6** estimate→invoice conversion · **DV-7** webhooks · **DV-8** payment
provider/shape model incl. bank reconciliation · **DV-9** delivery-status on
messages · **DV-10** no `∞%`, `n/a` instead · **DV-11** missing-rate warnings deep-
link the fix · **DV-12** `send_thank_you` defaults false natively · **DV-13**
tags/departments/employee_id first-class (UI-only in Harvest).
