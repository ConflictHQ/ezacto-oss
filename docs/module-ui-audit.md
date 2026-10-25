# Module-dependent surface audit

Issue #1259. This inventory covers the native product only. It does not claim
that a provider is configured, connected or verified. A hidden control is not an
authorization boundary: native API authorization and module gates still apply.

The operator flags are `SSO_ENABLED`, `BACKUPS_ENABLED`, `INVOICES_ENABLED` and
`ACCOUNTING_ENABLED`. Organization settings and runtime capability responses are
separate. In particular, the current native module-settings API accepts only
`approval`, `expenses`, `own_money` and `activity_log`; `team` and `client_portal`
are domain-inventory names, not currently writable module-setting API keys.

## CLI and operator surfaces

| Surface | Assumption / behavior before audit | Disposition when unavailable | Reason / verification |
| --- | --- | --- | --- |
| `ez --help` command/options inventory | Listed every client command without explaining instance availability | Fixed: explicitly identifies offline inventory, module/permission requirements and policy refusal | Help must work without credentials or a network request; focused CLI test |
| `ez report list` (human, JSON, CSV) | Lists all supported report definitions without checking the selected instance | Intentionally retains canonical offline inventory; help and CLI guide qualify availability | Stable machine-readable inventory is not an authorization/capability claim; test proves no network request |
| `ez invoice` generate/send/list/edit/unlink-time and sudo | Uses native API, which can refuse a disabled invoice module | Intentionally preserves native refusal; no fallback or reauthentication recommendation | Focused real-SDK transport fixture proves one request, 403/code/request ID retained, no success output |
| CLI reports/uninvoiced/export | Stored token scopes checked locally; native API enforces current access | Intentionally unchanged; docs distinguish scopes from instance module policy | A cached scope cannot enable a module; no provider fallback |
| `ez login`, whoami/config/logout | API-token operations; no browser SSO flow | Intentionally remains with SSO off | SSO policy does not revoke otherwise-valid API tokens |
| CLI time logging/timer/week/time export | Native time APIs rather than invoice/accounting providers | Intentionally remains with invoices/accounting off, subject to native permissions | Independent time operations do not need an invoice provider |
| CLI local backup/restore/decrypt/verify | Works on explicit operator files, not server backup endpoints | Intentionally remains with server backups off; help and guides now explicit | Recovery must not depend on a running/enabled server backup module |
| CLI `backup --sync-to` | Operator-selected S3-compatible copy | Intentionally remains explicit local operator operation | Not managed off-site runtime backup; requires operator destination credentials |
| CLI webhooks logs/replay | Session-authenticated native operation, not one of the disabled provider modules | Intentionally unchanged | No SSO/invoice/accounting capability is inferred by offering the command |
| Provider setup-guide catalog | General instructions may name a provider even when an instance disables it | Intentionally retained as operator reference; runtime availability distinguished from configuration | Static documentation cannot know an instance's flags and does not activate a provider |
| Operator module guide | Described routes/navigation, but did not cover client inventory or local recovery distinction | Fixed: per-module visible behavior and independent capability/organization settings table | [Operator guide](operator-guide.md#what-people-see) |
| Domain inventory `team` / `client_portal` | Inventory names could be mistaken for supported toggles | Explicitly recorded as not writable native module settings | Do not invent environment variables, successful setters or endpoint gates |

## Web inventory — integration owner finalizes dispositions

The rows below are the provisional source audit supplied to the web change
owner. **Pending** means the owner must complete the corresponding source/test
review before this issue is accepted; it is not a claim that a fix has shipped.
The root shell's parameterized guard must exercise every operator module off,
all four off together, and the existing organization/capability gates. Native
network assertions must cover withdrawn endpoints, including cached-session
resume and remaining reports/dashboard screens.

| Surface | Assumption / off behavior found in baseline | Required disposition / status |
| --- | --- | --- |
| Sign-in provider buttons / SSO domain settings | Server flag removes providers and withdraws SSO settings | Pending final guard: password/magic-link fallback only if independently configured; no provider/domain request |
| Backup settings/status/history/download/off-site links | Server marker and settings section withdrawal exist | Pending final guard: no backup request, setup prompt or withdrawn settings link |
| Invoice navigation / command palette / dashboard links | Profile-based reveal can restore invoice navigation unless module gate wins | Pending: module gate must outrank profile and cached identity |
| Invoice list/detail/create/editor and empty states | Full invoice workflows assume the module exists | Pending: no invoice loads/controls when off; bookmarked pages recover to available navigation |
| Estimates/templates / recurring invoices | Located within invoice navigation; catalogs/forms can remain in markup | Pending: withdraw their routes/links/activation with invoice capability |
| Invoice generation wizard: expenses and uninvoiced work | Offers expense source/generation choices | Pending: expenses-off removes expense inputs; invoices-off never initializes generation |
| Invoice payments / payment methods / pay links | Provider and manual-payment choices may be rendered together | Pending: remove only unavailable provider controls; do not mistake accounting for all native/manual payments |
| Invoice QuickBooks status/actions and BILL prompts | Can name/connect a disabled accounting provider | Pending: accounting-off removes provider prompts/actions and suppresses provider loads |
| Company invoice/reminder/sender settings | Settings strip already associates invoice/reminder sections with invoices | Pending: dependent sender, receipt, payment-method and notification fields must follow effective gate |
| Company accounting settings | Settings integrations section associated with accounting | Pending: do not reopen withdrawn section from hash/bookmark/cached state |
| Reports catalog: invoiced, payments received, receivables, uninvoiced | Report catalog statically includes invoice-dependent entries | Pending: withdraw unavailable choices, select an available report, and avoid withdrawn invoice endpoint loads |
| Detailed-time and detailed-expense invoice-state filters / bulk mark actions | Static fields can imply invoice workflow while invoices off | Pending: remove unsupported filter/action affordances without discarding available time data |
| Expense reports / custom report templates / company CSV export | Static detailed-expense entry/template exists | Pending: expense-off removes entry/template/export and prevents load, not just nav |
| Dashboard/report financial totals with invoices off | Remaining screens may combine independent and invoice data | Pending: preserve available time/counts without fetching or implying unavailable invoice totals |
| First-run/onboarding / empty-state calls to action | Guidance can link to setup/generation even when destination withdrawn | Pending: gate each destination; retain useful neutral available next action |
| Global search / quick actions / settings links / keyboard navigation | Alternate navigation can bypass sidebar withdrawal | Pending: same availability predicate as visible navigation; no dead anchors or focus targets |
| Own-money personal payments/staff invoices | Native APIs return `own_money_disabled`; personal controller has unavailable state | Pending final guard: suppress setup/submission prompts and stop private loads on unavailable response |
| Expenses nav/list/forms | Week snapshot includes expensesAvailable; nav is hidden on refresh | Pending final guard across all entry routes/resume; no expense export/generation dependency remains |
| Team nav/directory/teammate picker | Uses team-status and profile capability; initially hidden | Pending final guard for unavailable team response; no invented team module-setting API |
| Client-portal links/prompts | `client_portal` appears in domain inventory, not implemented native setting | Pending: audit actual supplied portal capability/links; record unsupported toggle honestly |
| Staff payouts / Wise / native manual payment records | Separate from accounting integrations | Intentionally unchanged unless their own permission/capability refuses; accounting is not a blanket payout switch |
| Existing records and audit history | Module off withdraws operations, not historical deletion | Intentionally unchanged: do not erase or reprice financial records as part of UI withdrawal |

## Verification record

CLI focused coverage lives in `packages/cli/test/module-availability.test.ts`:
offline inventory performs no fetch; a native `module_disabled` response is
preserved without fallback, success output or a suggestion to authenticate again.
The integration owner records the final parameterized web test, native network
proof and completed dispositions here before issue closure. No live provider or
customer-data action is part of this audit.
