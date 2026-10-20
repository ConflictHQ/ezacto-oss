# CSV time import

`ezacto-migrate import-csv` reads a vendor-neutral CSV of time entries into an
ezacto database. It is part of issue 1012 (import tools). It is not
a Harvest path (see [migrating-from-harvest.md](migrating-from-harvest.md)) and
not a claim that any particular vendor's export is understood: a vendor adapter
only has to turn that vendor's columns into this contract.

It imports **people, clients, projects, tasks and time entries, and nothing
else.** No invoices, payments, expenses, attachments, rates or credentials. Time
goes in through the same path the API uses, so rounding, assignments, timesheet
locks, approvals and note rules apply exactly as to an entry typed by hand.

```
ezacto-migrate import-csv --database instance.db --file time.csv --dry-run
ezacto-migrate import-csv --database instance.db --file time.csv --mapping mapping.json
ezacto-migrate import-csv --database instance.db --file toggl.csv --format toggl --dry-run
```

Always dry-run first. `--dry-run` opens the database without migrating it,
reports, and rolls back everything it touched. Without it the file is applied,
and applying the same file again adds nothing.

## The file

UTF-8, comma separated, one header row, one row per entry, at most 5 MiB and
50,000 rows. Column names are snake_case (case and surrounding space ignored).

| Column | | Rule |
| --- | --- | --- |
| `date` | required | A real calendar date, `YYYY-MM-DD`. Used as written. |
| `person_email` | required | Who the time belongs to. |
| `client`, `project`, `task` | required | Names, at most 255 characters. |
| `hours` | one of | Decimal hours with a dot (`1.5`, up to 4 places) or `H:MM` (`1:30`). Above 0, at most 24. A comma is not a decimal point. |
| `start_time`, `end_time` | or both | 24-hour `HH:MM`, same date, end after start. Wall-clock time as written; an offset or `Z` is refused. |
| `notes` | optional | At most 10,000 characters. |
| `billable` | optional | `true`/`false`/`yes`/`no`/`1`/`0`. Decides a new task assignment only (see below). |
| `rate`, `currency` | optional | Validated, never written. `currency` is an ISO 4217 code and sets the currency of a client the import creates. |

Give `hours` **or** start and end, not both. An organization that records start
and end times does not accept hours-only rows.

**Time zones.** Nothing is converted. A date is the entry's spent date and a time
is the person's own wall clock, so nothing moves across a daylight-saving change.
Convert in the exporting system if its times are in UTC.

**Unsafe cells.** A client, project, task, person or notes cell that starts with
`=`, `+`, `-`, `@` or a tab or carriage return is rejected as a formula-injection
risk. Malformed quoting, non-UTF-8 bytes, NUL bytes, an oversize file or too many
rows stop the file with a file error and read nothing.

Columns outside the contract produce a warning and are ignored.

## Toggl Track

`--format toggl` reads a Toggl Track **detailed time entries** CSV export and maps it
onto the contract above; everything else on this page (mapping, dry run, source
identity, re-running) applies unchanged. It reads a file you exported: it never
calls Toggl and takes no credentials. `--source-id` defaults to `toggl`.

| Toggl column | Becomes |
| --- | --- |
| `Start date` | `date` (the entry's spent date, also when it runs past midnight) |
| `Email` | `person_email` |
| `Client`, `Project`, `Task` | `client`, `project`, `task` |
| `Description` | `notes` |
| `Billable` (`Yes`/`No`) | `billable` |
| `Start time`, `End time`, `Duration` | `start_time`/`end_time` when the entry starts and ends on one date, on whole minutes, and the duration agrees; otherwise `hours`, exact to the second |

The export must have all of those columns (the summary and weekly reports do not),
or the file is refused with `toggl_missing_column`. Other columns (`User`, `Tags`,
the `Amount` columns) are ignored and named in a warning: **no amount or rate is
read.** Times are the exporting account's wall clock, not converted.

Limits that follow from the contract, reported per line rather than patched over:
a Toggl entry with no client, project or task is rejected (`missing_value`), since
the contract requires all three; a description that starts with `=`, `+`, `-` or
`@` is rejected as a formula-injection risk; a person not in this instance is
`person_unmapped` until the mapping names them (keyed by their Toggl email); an
organization that records start and end times rejects the entries that went in as
hours (`hours_not_accepted`). A running timer (no valid duration) is rejected as
`invalid_duration`.

## Clockify

`--format clockify` reads a Clockify **detailed** time report CSV export onto the
same contract, with the same rules as Toggl above (mapping, dry run, source
identity, re-running). It never calls Clockify and takes no credentials.
`--source-id` defaults to `clockify`.

| Clockify column | Becomes |
| --- | --- |
| `Start Date` | `date` (YYYY-MM-DD or MM/DD/YYYY) |
| `Email` | `person_email` |
| `Client`, `Project`, `Task` | `client`, `project`, `task` |
| `Description` | `notes` |
| `Billable` (`Yes`/`No`) | `billable` |
| `Start Time`, `End Time`, `Duration (h)` | `start_time`/`end_time` when the entry starts and ends on one date, on whole minutes, and the duration agrees; otherwise `hours`, exact to the second |

A file missing any of those columns is refused with `clockify_missing_column`.
Other columns (`User`, `Group`, `Tags`, `Duration (decimal)`, the `Billable Rate`
and `Billable Amount` columns) are ignored and named in a warning: **no rate or
amount is read.** Times may be 24-hour or 12-hour with AM/PM and are the exporting
account's wall clock, not converted. A file whose dates are DD/MM/YYYY is refused
with `clockify_date_format`; export again with the date format set to MM/DD/YYYY
or YYYY-MM-DD.

## The mapping

Optional JSON. A name the mapping does not mention is looked up as written.

```json
{
  "people":   { "ann@old.example": "ann@here.example",
                "bo@old.example":  { "create": { "firstName": "Bo", "lastName": "Lee" } } },
  "clients":  { "Acme Inc": "Acme" },
  "projects": { "Acme Inc": { "Web": "Website" } },
  "tasks":    { "Development": "Dev" }
}
```

- **People are never created unless the mapping says so**, and one that is
  created is **inactive**: importing someone does not let them sign in. An
  administrator turns them on deliberately. An unknown, unmapped person rejects
  their rows.
- Clients, projects and tasks that do not exist are created as plain organization
  data. The dry run lists them. A client created by the import takes the
  organization's currency, or the row's `currency`.
- Names match without case or surplus space. A name that matches an archived
  record, or more than one record, rejects the row rather than guessing.
- A person-project and a project-task assignment are created where missing. A
  task assignment's billable flag comes from the first row's `billable`, else the
  task's default; later rows that disagree get a warning, since the assignment
  decides.

## What the dry run reports

Counts of new, matched and rejected people, clients, projects and tasks; the
assignments it would create; how many rows are new, already imported or rejected;
and every rejected row with its **line number**, a code, and whether it breaks
the contract (`invalid`) or is a good row this instance cannot take
(`unsupported`): `person_unmapped`, `person_not_found`, `*_archived`,
`*_ambiguous`, `period_locked`, `period_submitted`, `period_approved`,
`assignment_archived`, `hours_not_accepted`. Exit status is 1 if anything is
rejected.

## Re-running, resuming, aborting

- **Source identity.** A row's key is the sha-256 of what it says about time
  (date, person, client, project, task, duration or times, notes, billable;
  not its line, not rate or currency) plus how many identical rows came before it
  in the file. Reordering a file changes nothing; two genuinely identical rows
  stay two. The key is recorded, unique per `--source-id`, in the same batch as
  the entry. Use one stable `--source-id` per source system.
- **Updated exports.** Exporting the same source again and applying it adds only
  rows whose keys it has not seen. A row that was *edited* in the source has a
  new key and is added as a new entry; the original is left alone. The importer
  never edits or deletes an entry, so time that has since been invoiced is never
  touched. An entry deleted after import is not brought back by the next run.
- **The mapping belongs to the run.** A run is a source id plus the file's
  sha-256, and stores the mapping it started with. A retry without `--mapping`
  uses the stored one; a different one is refused.
- **Partial failure.** An unexpected error stops the run with its status left at
  `partial` and the error recorded. Running the same command again finishes the
  remainder only.
- **Rejected rows.** Apply refuses a file with rejected rows. `--skip-rejected`
  applies the rest and leaves the rejected rows listed; once the cause is fixed
  (a lock lifted) running the file again brings them in.
- **Abort.** Ctrl-C stops further rows. It is **not a rollback**: entries already
  written stay, and the run is left resumable.

## Not covered yet

A Clockify adapter, the upload wizard, running on D1 or the
Worker, and a mapping preview UI are later slices of the same issue. This slice
is CLI and container (SQLite) only.
