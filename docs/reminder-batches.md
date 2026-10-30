# Resumable reminder batches

The database reminder scheduler and the Worker/container `reminders.processDue`
service accept optional `limit` and `selection` settings. Existing callers that
omit them retain the current ordering, default batch size and result shape.

```ts
const result = await services.reminders.processDue(asOfTime, {
  limit: 3,
  selection: { afterId: cursor, throughId: highWaterId },
})
```

The caller captures the largest existing `scheduled_reminders.id` before the
first batch, retains that upper bound and the due-time cutoff for the whole pass,
and starts with `afterId: 0`. Bounds are inclusive above and exclusive below:
`afterId < id <= throughId`. Both must be nonnegative safe integers and the upper
bound cannot be smaller than the cursor. Batch size remains between 1 and 100.

Selection uses increasing ID order. `lastExaminedId` reports the last row examined,
including cancelled rows and unsuccessful sends, or retains `afterId` when no row
was eligible. This lets a caller progress past a failed reminder and revisit it
in a later pass without starving later IDs. A failed send still leaves the row
pending. No selection means no `lastExaminedId` property in the result.

The existing autoincrement ID prevents newly created follow-up reminders from
entering the captured ID range. Even when their dates are already overdue, they
belong to a later pass. Capturing a new upper bound after each batch would defeat
that boundary. Daily callers should retain one upper bound and due-time cutoff
for the entire day, finish any interrupted pass, and begin a new pass according
to their existing daily policy.

These options select work; they do not implement a distributed lock or make
external delivery atomic. The caller owns transaction/lease handling and must
commit its checkpoint with the local reminder changes and durable queued jobs.
In hosted, this is the encrypted tenant commit protocol. The hosted caller is a
separate integration tracked in ConflictHQ/ezacto-hosted#4; no hosted scheduling
or production enablement is included in this change.
