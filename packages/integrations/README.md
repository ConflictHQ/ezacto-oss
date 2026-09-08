# @ezacto/integrations

Outbound adapters for the platforms people are paid through. Today that is Deel:
an HTTP client, the matcher that decides which Deel contract a person's hours
belong to, and the transfer log that stops the same hours reaching Deel twice.

Everything here is pure or transport-injected. No module reads an environment
variable, and no test touches the network.

## The three pieces

| Module | What it does |
|---|---|
| `src/deel/client.ts` | `DeelClient` over `/rest`: list people, create a timesheet. The `fetch` is supplied by the caller. |
| `src/deel/matching.ts` | Person to contract, matched on the **payroll-kind** address, refusing to guess when Deel is ambiguous. |
| `src/deel/time-sync.ts` | `planTimeTransfer` (dedupe against the log, group per person-day) and `submitTransferPlan` (post, and write log records only for what Deel took). |

A run is: `listPeople` → `matchPayrollContracts` → `planTimeTransfer` →
`submitTransferPlan` → persist `result.records` as transfer-log rows. The plan's
`conflicts`, `unsyncable` and the result's `failed` are the run's visible gaps
and belong in whatever the schedule reports; they are not decoration.

## What it depends on and does not own

- **`user_emails.kind`** (personal / work / payroll) — the matcher takes a
  payroll-kind address. The column and its backfill belong to the payroll report
  story, not to this package.
- **Transfer-log storage** — `TransferLogRecord` is the row shape; the table,
  the query for a period's entries, and the schedule that runs the sync are all
  outside this package.

## Bill.com

`docs/billcom-spike.md` — the written spike D13 asks for before Bill.com is
estimated. No code, deliberately.
