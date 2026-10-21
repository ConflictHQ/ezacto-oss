# Table sorting (#852)

Column-heading buttons sort ascending, then descending. The selected heading
carries `aria-sort`; its visual arrow is hidden from assistive technology.
Enter and Space activate the button and focus returns to the same heading.

`apps/web/src/components/table-sort.ts` owns stable natural comparison, empty
values last in both directions, and per-person/per-table memory. Numeric invoice
identifiers sort 9 before 10 before 1315. Dates use their source values rather
than formatted labels; amounts use exact cents and currency where supplied.
`data-table.ts` uses the same comparison for ordinary lists;
`report-table-sort.ts` moves existing report rows within bands, preserving row
selection and multi-currency row units.

Each ordinary list declares its initial order. Remembered choices take precedence;
a missing or permission-hidden column falls back to that table's default. The
shell sets the signed-in preference owner and clears it on sign-out. Storage
failure affects persistence only; sorting still works.

## Inventory and initial orders

| Surface | Initial order and boundary | Source under `apps/web/src/` |
| --- | --- | --- |
| Invoices | Issue date newest first, across the whole result; signed keyset cursors are bound to the chosen sort | `invoices/browser.ts` |
| Email and event delivery logs | Newest first, server order retained in each log's URL | `deliveries/browser.ts` |
| Standard reports | Per-report declared default; selected sort travels in the report address, saved views and per-person memory; existing bands/row units stay intact | `reports/browser.ts`, `components/report-table-sort.ts` |
| Custom report definition results | Natural result label; each metric compares its finite numeric value and keeps missing-value/exception payloads and drill links | `reports/definition-results.ts` |
| Saved report library | Updated newest first | `reports/saved-screen.ts` |
| Clients | Natural client name among siblings and roots; a child never leaves its parent, and corrupt-cycle handling stays bounded | `clients/browser.ts`, `clients/model.ts` |
| Projects and client-detail projects/contacts | Natural project/contact name; project client bands retain their order | `projects/browser.ts`, `clients/browser.ts` |
| People | Natural name within the existing cohort bands | `team/browser.ts` |
| Capacity | Natural person name; weekly headings sort rows by planned seconds, never move chronological week columns | `capacity/browser.ts` |
| Planning allocations/time off | Start/end dates, earliest first; forms live outside the sorted rows, so unfinished input survives | `capacity/planning-browser.ts` |
| Activity | Newest first; loaded rows only while another page remains | `activity/browser.ts` |
| Estimates | Natural number; loaded rows only while another page remains | `estimates/browser.ts` |
| Expenses | Newest date first within week bands; loaded rows only while another page remains | `expenses/browser.ts` |
| Recurring invoices and retainers | Natural subject/scope within client bands; loaded rows only while another page remains | `recurring/browser.ts`, `retainers/browser.ts` |
| Tasks and expense categories | Natural name; loaded rows only while another page remains | `tasks/browser.ts`, `expense-categories/browser.ts` |
| Monthly staff register | Natural name; history and provider history newest first | `staff-payments/browser.ts` |
| Run-item history | Natural person name, remembered separately per run; status checks remain attached to their item | `staff-payments/runs-browser.ts` |
| Payment reports | Balances/allocation reconciliation by person, transfers by scheduled start earliest first, receipts newest first | `staff-payments/runs-browser.ts` |
| Contractor invoice reconciliation and advance credit summary | Natural person name; currencies and exact values stay separate | `staff-payments/invoices-browser.ts`, `staff-payments/advances-browser.ts` |
| My payments | Recorded payments/applied credit newest first; upcoming payments earliest first | `my-payments/browser.ts` |
| Sender identities, templates and SSO domains | Default sender first, then available/archived; natural template kind or domain | `email-config/browser.ts`, `module-settings/browser.ts` |
| API tokens | Natural name | `shell/browser.ts` |
| Backup history | Started newest first | `module-settings/browser.ts` |
| QuickBooks comparison | Natural invoice number; absent comparison amounts stay last and headings invoke no repair action | `module-settings/browser.ts` |

The loaded-page notice is explicit: “Sorting covers only the rows loaded so far;
load more to include the rest.” Invoice and delivery-log sorting is server-side;
it must not be replaced by sorting a single loaded page. Choosing a different
server sort resets its pagination.

## Content whose order carries meaning

These retain their structural order, per the issue's recorded exceptions:

- Invoice/estimate/recurring document lines and contractor invoice line evidence.
  Their initial order is the document's, not an alphabetic default.
- Running-balance ledgers, effective-dated rate history and template revision or
  variable reference tables.
- Chronological week/calendar grids and profitability trends.
- One-row-per-currency or denomination/currency breakdowns, including the client
  financial rollups; these are not lists of individual invoices or payments.
- Payment selection/confirmation rows and configuration/document forms containing
  unfinished input. Sorting read-only history/report rows does not submit them.

The client hierarchy and capacity screen are ordinary sortable views with the
structural restrictions above, not blanket exceptions for whole screens.
