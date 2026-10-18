# Week-read measurement

Issue 599, slice A. The question: does a phone or the Chrome popup make enough
week-read round trips that a composed `GET /api/v1/weeks/:start` is worth
building, or is composing client-side fine?

**Status: no timings have been gathered.** Real numbers need a token for a real
instance and, for the mobile row, a device on a throttled link. Neither was
available when this was written. What is recorded below is the call inventory
read from the app sources (counted, not timed) and a repeatable harness. The
decision on slice B stays open until someone runs the harness and fills in the
results table.

## What each app sends when it opens

Read from `repos/mobile` and `repos/chrome` at the time of writing.

### Mobile, Week screen (focus)

`loadWeek` in `src/store/time/index.ts` calls `entriesInRange`
(`src/api/time.ts`):

| #   | Request                                         | Notes                                |
| --- | ----------------------------------------------- | ------------------------------------ |
| 1   | `GET /api/v1/time-entries?from&to&per_page=200` | One page only; no cursor is followed |

One round trip. Two things the harness cannot judge but a reader should know:

- A week with more than 200 entries is silently cut off at 200.
- The start of the week is hard-coded to Monday (`weekStart(todayIso(), 'monday')`)
  and ignores the instance's `week_start_day`.

The Home tab separately issues `running` and `today` reads (two parallel
requests) through `loadToday`; those are not week reads and are not measured.

### Chrome popup, open

`renderStatus` in `src/popup/popup.ts`. Two dependent phases, because the week
range needs the instance's week-start first. Without the active-tab lookup
(`trackedAgainst`), which only runs when the current page is a recognised work
item.

| Phase        | Request                                                                  | Paged |
| ------------ | ------------------------------------------------------------------------ | ----- |
| 1 (parallel) | `GET /time-entries?is_running=true&per_page=1`                           | no    |
| 1            | `GET /time-entry-options`                                                | no    |
| 1            | `GET /projects?is_active=true&per_page=200`                              | yes   |
| 1            | `GET /tasks?is_active=true&per_page=200`                                 | yes   |
| 1            | `GET /time-entry-settings`                                               | no    |
| 2 (parallel) | `GET /time-entries?from&to&per_page=200` (the week)                      | yes   |
| 2            | `GET /time-entries?from=<3 weeks earlier>&to&per_page=200` (recent work) | yes   |

Minimum 7 requests in 2 sequential round trips; each extra page of projects,
tasks or entries adds a request. The second week query returns the first one's
rows again, so the week is fetched twice.

Only part of this is "week read": the picker (options, projects, tasks) and
settings are needed whatever the week looks like. A composed week endpoint would
replace the two phase-2 reads, not the whole list.

## How to measure

```
EZACTO_TOKEN=ezacto_... node scripts/measure-week-read.mjs \
  --base-url https://<instance> --runs 20 --profile 3g --json
```

- Token from the environment only, scopes `time_entries:read` and
  `projects:read`. Use a dev instance or a person's own token; the script only
  sends GETs.
- Replays both scenarios against the instance, each twice: `as-the-app-does`
  (parallel inside a phase) and `sequential` (every request in one line).
- Reports requests, bytes, and p50/p95 wall time over `--runs`.
- `--profile` is `none`, `4g` (100 ms, 9 Mbit/s), `3g` (300 ms, 1.6 Mbit/s) or
  `slow3g` (400 ms, 400 kbit/s). It is simulated in the script by holding each
  response, so it compares shapes; it is not a device measurement. A figure for
  the mobile app should still be taken on a handset with the OS network
  conditioner, and the profile name written next to it.
- Bytes are the decoded body size, not wire size; compression is not counted.
- Run it against an account whose week looks like a real user's (about 5 to 25
  entries a week for most; include a heavy user). An empty dev account
  understates payloads.

## Results

| Date            | Instance | Profile | Scenario | Mode | Requests | Bytes | p50 | p95 |
| --------------- | -------- | ------- | -------- | ---- | -------- | ----- | --- | --- |
| _none recorded_ |          |         |          |      |          |       |     |     |

## Decision

Open. Suggested rule once numbers exist, to be confirmed by the owner on the
issue: build slice B if the Chrome week reads (phase 2) or the mobile read cost
more than about one second at p95 on the 3g profile for a typical week, or if
heavy weeks page; otherwise close as "composed client-side is fine" and fix the
two mobile defects above instead.
