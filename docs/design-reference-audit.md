# eZacto supplied-reference audit

Issue #995. Audit date: 2026-10-24. The recovered supplied `ezacto` package contains
`dashboard.html`, `login.html` and `styles.css`, plus its
`.agents/skills/redesign-existing-projects/SKILL.md`. The audit used that skill's
scan/diagnose/targeted-fix workflow with the existing vanilla TypeScript/CSS stack.
The earlier current-app audit in #1152 did not have this package; this comparison
supersedes that evidence limitation without replacing its shipped improvements.

## Reference provenance and method

| Original file | Bytes | SHA-256 |
| --- | ---: | --- |
| `dashboard.html` | 97054 | `340b2fa1a53cf35708a080db3460c4cbe4d57b8dce1e27ca4dd9ba4342c591db` |
| `login.html` | 25237 | `24a02829ccb6f211865fb5d551cb4fc4bcf58b22ce296883e2e825e45e61b1cd` |
| `styles.css` | 46850 | `05caf8d11c41c28c20bcfb5dc451cba1797741a6cff9c070fbc491fa32296fa2` |

The dashboard's application CSS is inline; `styles.css` mainly supplies the
marketing/login design vocabulary. Reference captures at 390 and 1280 pixels
used local copies with scripts removed and external requests blocked. Font-family
and weight comparisons use the declarations; blocked Google Fonts and a missing
local Paysage face do not establish identical loaded glyph rasterization.

The mock's business panels are nested under hidden Calendar/Home ancestors.
Read-only inspection restored their intended visibility and moved those existing
panel nodes beside Home in an isolated browser DOM. No reference file was edited
or source script run. This exposes the intended layout; it does not demonstrate
that the prototype's navigation, timer, data or permissions work.

The native baseline was `6fcf09a0`, with follow-on fixes in this change and the
linked first-run header repair. Native captures use the actual local Worker,
D1, session cookies and generated SDK, rather than replacing the UI with mock
HTML. The final PR verification receipt identifies the exact integrated source.

## Comparison and disposition

| Surface | Supplied direction | Runtime result and targeted changes |
| --- | --- | --- |
| Shared shell | 248px pale sidebar, dark wordmark tile, blue active section, grouped navigation and a prominent timer | Precision already uses the same 248px sidebar, `Google Sans Flex`, action `#254FE8`, ink `#1A1A2E` and border `#E5E7EB`. Retain semantic theme tokens, clearer muted/live contrast, collapsible sidebar, topbar preference and actual role-scoped navigation. Raise the measured small toolbar/account/sidebar targets to 44px and center their contents. |
| Timer and week | Home offers a day-list timesheet and a distinct Calendar/Week surface; running time has a clear label, status and stop action | Preserve the working Week/Day/Calendar modes, persisted start/end behavior, timer and note controls. The weekly totals grid is not the mock's day list, and duration entries must not acquire invented start times to resemble appointments. Period arrows fixed by #1152 stay 44px; week actions/person selector now share that target size. #1171 supplies discoverable timer labels and role-aware no-task guidance. |
| Invoices | Heading/action, light bounded table, aligned amounts, status pills | Retain the actual list filters, invoice editor, currencies, states and authority checks. Native populated rows verify real invoice numbers and separate currency amounts; do not copy the prototype's static totals. Shared primary actions receive the consistent minimum target. Existing invoice-data-table and responsive editor improvements remain. |
| Expenses | List-first hierarchy, Add expense action, concise filters and aligned amounts/status | The previous always-open creation form pushed phone results far below the list. Use an accessible Add expense action and an initially closed inline panel. Opening focuses a field; Close preserves the draft and returns focus; errors stay in the open form; only confirmed creation resets/closes it and exposes the new record link. Pending/session/module fences remain. Align filter tracks to their 44px controls and cap explanatory prose at 64ch. |
| Reports | Clear page title, grouped summaries, data table and an export action | Preserve actual report selection, scope/date filters, per-currency values, missing-rate states, visible sorting and real exports. Current phone/dark layouts are deliberate improvements over the static desktop summary. Shared period controls retain their existing keyboard behavior and target-size repair. |
| Approvals | Heading/action, concise person/period/hours/status rows | Keep actual pending/recent-history sections, scoped filters, expandable review and lock policy. Requesting approval belongs to the working own-time submission flow, not an inert copied CTA on the reviewer screen. Raise all filter selects/Apply to 44px. The organization timezone form now uses the same single-column phone rule as the adjacent policy forms and an unbroken action label. |
| Login and help | Demo-specific marketing headline/ribbon, form, theme toggle and published demo-account cards | Runtime authentication is installation-specific. Keep the working sign-in/recovery/SSO/second-factor states, deployment branding and conditional public-demo accounts; never put a demo password or marketing subscription gate on an ordinary operator installation. Existing sign-in/recovery targets and bounded readable width remain. Help is the actual owner setup guide and contextual member guidance; the supplied package has no separate Help screen to reproduce. |
| Keyboard and motion | Prototype focus styles and visual transitions | Retain native semantics, visible keyboard outlines, dialog focus behavior and reduced-motion overrides. Measured controls have visible focus and contained layouts in the native matrix. The first-run Help repair preserves its accessible name with an icon at constrained widths and keeps collapsed-sidebar rules inside the desktop media block. |

The prototype's 390px login measures a 446px document, and its business panels
retain a fixed desktop sidebar with clipped content. Those are not patterns to
copy. The runtime's phone containment, scrollable data regions, dark palette,
stronger contrast and real empty/loading/error states are retained improvements.
No sample organization, staff, invoices, monetary values, contact links or
subscription restrictions from the static package are shipped as application data.

## Native state and interaction evidence

The native layout matrix covers login, week, dashboard, invoice, expense, report
and approval pages at 390/1280, light/dark, with reduced motion and keyboard focus.
It records document/control geometry, focused-element state, transition duration,
page errors and a screenshot per screen. New assertions pin the measured 44px
toolbar, approval, week and account controls. The original stylesheet fails those
assertions, including 36px approval filters; #1152's recovery/period regressions
remain covered.

A second native audit uses the existing owned synthetic D1 fixture: baseline
0.75h plus 1.75h across three linked projects, multiple-currency expenses and four
invoices. It exercises real week submission into the approval queue, populated
week/invoice/expense/report/approval rendering, held expense loading, a simulated
redacted 500 response, visible retry and successful native recovery. It also
verifies anonymous time access is still 401, then un-submits and cleans up only
its owned fixture records. The simulated failure is a UI-state check, not a claim
that the server failed in production.

The expense interaction case separately proves keyboard opening/focus, preserved
unsaved fields after Close/reopen, validation remaining visible, disabled pending
controls, real 201 creation, reset/close/focus return and deletion of the owned
synthetic expense. The existing category/receipt flow explicitly opens the new
panel and continues through the same native routes.

Reference and runtime are not pixel-identical products: the prototype has static
content and incomplete interaction/accessibility behavior, whereas the runtime
must retain actual data, permissions, configured themes and installation identity.
The comparison above records each substantive adaptation instead of silently
copying the mock or claiming parity from a screenshot alone.

## Reproduction and acceptance artifacts

Generate/build the local workspaces needed by the native harness, then run:

```sh
npm run generated
npm exec -w @ezacto/web -- playwright test --config playwright.config.ts current-layout-audit.browser.ts reference-states-audit.browser.ts expense-list-first.browser.ts
```

Use `EZACTO_BROWSER_PORT` for an isolated local port. For local iterative work,
pass a dedicated `--output` directory before starting another Playwright command;
its default test-results cleanup otherwise removes earlier screenshots. CI's full
native invocation retains all three specs' artifacts together.

Inspect `current-app-observations.json`, the seven-screen screenshots, populated
and loading/error screenshots, and the expense interaction captures in the native
artifact. Follow-on verification includes the existing narrow invoice/recurring
editor and header-band tests, renderer/controller checks, web typecheck/lint/build
and generated asset checks. The final PR body records the commands/results and
source receipt; deployment read-back is separate from local fixture evidence.
