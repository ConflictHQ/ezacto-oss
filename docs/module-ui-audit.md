# Module-dependent surface audit

Issue #1259. This inventory covers the native product only. It does not claim
that a provider is configured, connected or verified. A hidden control is not an
authorization boundary: native API authorization and module gates still apply.

The operator flags are `SSO_ENABLED`, `BACKUPS_ENABLED`, `INVOICES_ENABLED` and
`ACCOUNTING_ENABLED`. Organization settings and runtime capability responses are
separate. In particular, the current native module-settings API accepts only
`approval`, `expenses`, `own_money` and `activity_log`; `team` is also read from existing organization module state by the native runtime,
but is not writable through that API. `client_portal` is a domain-inventory name
without an implemented native toggle; do not invent a flag for it.

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

## Web surfaces

Operator availability is rendered before session resume. These flags require no
failed capability request to discover. Organization capabilities are different:
Team has a status read, while expense and own-money screens may first discover
a refusal through their native API. That initial discovery is not an outage or
a provider attempt. Once unavailable, the same session must not repeatedly call
the withdrawn operation or offer a setup action that can only fail. A new
session activation can rediscover a module that has been enabled again.

| Surface | Assumption / baseline behavior | Final disposition and reason |
| --- | --- | --- |
| Sign-in provider choices / SSO domain settings | Provider cards could reappear from method metadata despite operator withdrawal | Fixed: provider cards filtered by effective SSO state; password/magic link stay only under their own configuration. SSO domain section/read withdrawn. |
| Backup status/history/download/off-site settings | Backup settings depend on enabled runtime backup routes | Existing gate retained: server marker withdraws backup section and activation/read. Offline operator recovery remains independent. |
| Invoice sidebar / menu / command palette | Profile-based reveal could re-offer invoices after server withdrawal | Fixed: module availability outranks financial profile in navigation; palette shares visible navigation gates. |
| Invoice list/detail/create/estimates/recurring pages | Entire workspace depends on invoice routes | Existing server page withdrawal/redirect and hidden navigation retained; no substitute financial mutation or provider connection added. |
| Invoice generation expense source | Source selection could remain enabled after Expenses was off | Fixed: native expense availability controls source selection; unavailable source is cleared, disabled and explained neutrally. No expense data is silently generated. |
| Invoice payment methods / pay links / manual payment records | Could be mistaken for all belonging to accounting | Intentionally keep native/manual payments and separately configured Stripe when invoices are on; accounting controls QuickBooks/BILL, not every payment provider. Invoices-off withdraws the invoice workspace. |
| Invoice QuickBooks / client BILL controls | Client provider metadata and delivery prompts loaded independently of module state | Fixed: accounting-off suppresses provider prompts/reads; BILL additionally requires invoices. Native history is retained. |
| Company invoice/default/reminder settings | Settings strips, hashes and forms can bypass main navigation | Existing unavailable-section mechanism retained and tested: no defaults/reminder/SSO/backup/accounting reads when the owning operator flag is off. |
| Client sending/contact recipient/bill-to fields | Native client page remains available without invoicing | Fixed: withdraw invoice sending, recipient fields and billing links; omit hidden billing/recipient fields from unrelated saves so historical values are not cleared. |
| Client financial rollup | Required open-invoice collection even for independent budget/retainer data | Fixed: omit invoice read/section when off; preserve available budget, work and retainer reporting. |
| Dashboard invoice summary | Remaining dashboard fetched disabled invoice collection | Fixed: no invoice collection read; independent financial reports remain subject to their existing authorization. |
| Invoice-derived report choices and financial totals | Historical reports could be removed along with mutations | Intentionally retained: native report endpoints remain readable. Invoice numbers become text instead of dead links; invoice generation/mark-invoiced/mark-uninvoiced actions disappear, while time movement remains. Historical facts are not rewritten. |
| Detailed-time / detailed-expense invoice-state filters | Filters name historical invoice classification | Intentionally retained where native reporting accepts them: these filter existing records, not invoice commands. No unsupported provider capability is inferred. |
| Detailed-expense report / custom template | Expense refusal incorrectly named Activity log and left the refused kind selectable | Fixed: correct unavailable message; remove tab/template and hide refused form, with no retry/popstate repeat in the same session. Fresh session restores discovery and can load enabled expenses. Other reports/data remain available. |
| Company expense CSV export | Company tools need organization availability | Existing gate retained: module list controls expense export availability before download; native refusal is still authoritative. Time export remains available. |
| First-run / setup / empty states | Setup links must not assume invoice/accounting providers | Intentionally retain actual first-run steps: client, project, task, assignment and time entry. They do not require invoice, SSO, backup or accounting providers. Disabled expense/report states offer no creation/setup action. |
| Global search / quick actions / keyboard destinations | Alternate navigation could promise withdrawn sections | Existing destination gates retained; invoice navigation fix also feeds palette and record-link availability. |
| Own-money payments / personal contractor documents | A personal page discovers `own_money_disabled` | Existing refusal retained: hide figures/documents, show neutral unavailable message, and do not load personal documents after the refusal. No setup/submission prompt; administrative payment scope is separate. |
| Expense list/detail/category forms | Bookmark can discover `module_disabled` after navigation | Existing unavailable state retained: hide list/filter/create/edit actions rather than offer retry/setup. Independent week still loads from a single refused expense discovery. |
| Team navigation / bookmarked directory/person / teammate controls | Nav status alone did not prevent bookmark controller reads/setup | Fixed: authoritative Team status precedes controls and protected reads. False/failed status presents unavailable state; no people, week-settings, payout-default, person or catalog load; stale enabled response cannot revive ended session. Existing partial adapters without a status method retain compatibility. |
| Client-portal links / invoice documents | Domain inventory mentions `client_portal`, but no native toggle is implemented | Intentionally unchanged: no invented `CLIENT_PORTAL_ENABLED` variable or successful setter. Actual client invoice/estimate documents retain their own token/access checks and invoice module policy; no native setup CTA promises an absent portal capability. |
| Staff payouts / provider destination forms | Accounting-off could incorrectly suppress independent payout workflows | Intentionally unchanged under accounting: payouts use their own permissions/provider switches. Disabled Deel hides destination form; unavailable Wise API hides the tab, and Wise-off suppresses its form. Provider status/accounts reads are capability discovery, not provider execution. Administrators retain working provider-policy switches so they can enable/disable providers deliberately. |
| Stored records / audit history / valid historical expense aggregates | UI withdrawal could erase or misstate past work | Intentionally retained: no deletion, repricing, FX conversion or historical record mutation is part of this audit. |

## Verification record

CLI focused coverage lives in `packages/cli/test/module-availability.test.ts`:
offline inventory performs no fetch; a native `module_disabled` response is
preserved without fallback, success output or a suggestion to authenticate again.
Focused existing capability regressions: seven tests passed across expense,
own-money, Team permission and payout-provider controllers; nine shell/report
regressions passed for expense discovery and retained historical reporting.
The detailed-expense regression first failed with the incorrect Activity log
message, then passed for one refused discovery, blocked repeat/popstate requests,
independent Time navigation and disabled-to-enabled fresh-session recovery.
The complete report regression set passes 74 tests: 55 in
`report-browser.test.ts`, six in `report-entry-actions.test.ts`, eight in
`report-module-capabilities.test.ts`, and five in `activity-module-gating.test.ts`.
The cases use shared fixtures in `test/support/report-harness.ts`. Their test-name
multiset is unchanged by the split; separate browser Windows bound retained shell
parses under the existing CI memory and timeout settings. No assertions or cases
were removed to achieve that result.

The PR verification record includes the final parameterized shell/network
results and combined source checks. No live provider or customer-data action is
part of this audit.
