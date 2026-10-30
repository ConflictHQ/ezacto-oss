// Provenance: ezacto-pvt #899 (parent #891). An additive layer on the monthly
// staff payment register: an allocation links part of one payment (a recorded
// payment event, or a payment run item that reserves and later settles) to the
// earnings it pays: the whole work month, one project, or one reviewed time
// entry with an optional number of hours. Nothing here changes a monthly total,
// a payment or a run: existing payments stay unallocated until someone
// allocates them explicitly, and no hour split is ever inferred.
//
// Rows are append-only. An allocation is released, never deleted: by a
// reversal row (explicit, with a reason), by a void of its payment event, or by
// its run item failing or being cancelled. Hours and rates are snapshots of the
// confirmed actuals review, so later edits to the source time entry cannot
// rewrite what was allocated; the report flags the difference for review.
//
// The triggers are the invariants, so they hold for every writer on SQLite and
// D1 alike: one INSERT statement is atomic on both, and the capacity checks run
// inside it, so two concurrent allocations cannot spend the same funds or hours.
const live = `('queued','creating','funding','processing','attention','paid')`
const unreleased = `state IN ('applied','reserved')`
const sum = (where: string) =>
  `(SELECT COALESCE(SUM(amount_cents),0) FROM staff_payment_allocation_ledger WHERE ${unreleased} AND ${where})`
const review = `(SELECT entries_json FROM staff_payment_actuals a WHERE a.user_id=NEW.user_id AND a.month=NEW.month ORDER BY a.expected_version DESC LIMIT 1)`
const entry = `(SELECT j.value FROM json_each(${review}) j WHERE json_extract(j.value,'$.entry_id')=NEW.entry_id)`
const earned = (selected: string, rate: string) =>
  `(CASE WHEN ${selected}<0 THEN -((-${selected}*${rate}+1800)/3600) ELSE (${selected}*${rate}+1800)/3600 END)`
const fail = (condition: string, message: string) =>
  `SELECT CASE WHEN ${condition} THEN RAISE(ABORT,'${message}') END;`

export const paymentAllocationsMigration = [
  `CREATE TABLE staff_payment_allocations (
    id TEXT PRIMARY KEY,
    payment_kind TEXT NOT NULL CHECK(payment_kind IN ('event','run_item')),
    payment_id TEXT NOT NULL,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    month TEXT NOT NULL CHECK(month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
    currency TEXT NOT NULL CHECK(currency GLOB '[A-Z][A-Z][A-Z]'),
    scope TEXT NOT NULL CHECK(scope IN ('month','project','entry')),
    project_id INTEGER,
    project_name TEXT,
    entry_id INTEGER,
    seconds INTEGER CHECK(seconds IS NULL OR seconds>0),
    rate_cents INTEGER CHECK(rate_cents IS NULL OR rate_cents>=0),
    amount_cents INTEGER NOT NULL CHECK(amount_cents>0 AND amount_cents<=9000000000000),
    snapshot_json TEXT CHECK(snapshot_json IS NULL OR json_valid(snapshot_json)),
    command_json TEXT NOT NULL CHECK(json_valid(command_json)),
    reason TEXT NOT NULL CHECK(length(trim(reason))>0 AND length(reason)<=2000),
    actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    recorded_at TEXT NOT NULL,
    request_id TEXT NOT NULL,
    CHECK(
      (scope='month' AND project_id IS NULL AND entry_id IS NULL AND seconds IS NULL AND rate_cents IS NULL)
      OR (scope='project' AND project_id IS NOT NULL AND entry_id IS NULL AND seconds IS NULL AND rate_cents IS NULL)
      OR (scope='entry' AND project_id IS NOT NULL AND entry_id IS NOT NULL AND rate_cents IS NOT NULL)
    )
  ) STRICT`,
  `CREATE INDEX staff_payment_allocations_payment ON staff_payment_allocations(payment_kind,payment_id)`,
  `CREATE INDEX staff_payment_allocations_earning ON staff_payment_allocations(user_id,month,scope,project_id,entry_id)`,
  `CREATE TABLE staff_payment_allocation_reversals (
    id TEXT PRIMARY KEY,
    allocation_id TEXT NOT NULL UNIQUE REFERENCES staff_payment_allocations(id) ON DELETE RESTRICT,
    reason TEXT NOT NULL CHECK(length(trim(reason))>0 AND length(reason)<=2000),
    actor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    recorded_at TEXT NOT NULL,
    request_id TEXT NOT NULL
  ) STRICT`,
  // applied: the payment settled; reserved: it is scheduled or processing;
  // released: its payment was voided, failed or cancelled; reversed: explicit.
  `CREATE VIEW staff_payment_allocation_ledger AS
    SELECT a.id,a.payment_kind,a.payment_id,a.user_id,a.month,a.currency,a.scope,a.project_id,a.project_name,a.entry_id,
      a.seconds,a.rate_cents,a.amount_cents,a.snapshot_json,a.reason,a.actor_id,a.recorded_at,a.request_id,
      CASE
        WHEN r.id IS NOT NULL THEN 'reversed'
        WHEN a.payment_kind='event' THEN CASE WHEN EXISTS(SELECT 1 FROM staff_payment_events v WHERE v.kind='void'
          AND json_extract(v.command_json,'$.payment_id')=a.payment_id) THEN 'released' ELSE 'applied' END
        ELSE COALESCE((SELECT CASE WHEN i.state='paid' THEN 'applied' WHEN i.state IN ('queued','creating','funding','processing','attention')
          THEN 'reserved' ELSE 'released' END FROM payment_run_items i WHERE i.id=a.payment_id),'released')
      END AS state
    FROM staff_payment_allocations a LEFT JOIN staff_payment_allocation_reversals r ON r.allocation_id=a.id`,
  `CREATE TRIGGER staff_payment_allocations_guard BEFORE INSERT ON staff_payment_allocations BEGIN
    ${fail(
      `NOT EXISTS(SELECT 1 FROM staff_payment_effective_events e WHERE NEW.payment_kind='event' AND e.id=NEW.payment_id AND e.kind='payment'
        AND e.id NOT LIKE 'run-payment:%' AND e.user_id=NEW.user_id AND e.month=NEW.month AND json_extract(e.command_json,'$.currency')=NEW.currency
        AND NOT EXISTS(SELECT 1 FROM staff_payment_events v WHERE v.kind='void' AND json_extract(v.command_json,'$.payment_id')=e.id))
      AND NOT EXISTS(SELECT 1 FROM payment_run_items i WHERE NEW.payment_kind='run_item' AND i.id=NEW.payment_id AND i.user_id=NEW.user_id
        AND i.month=NEW.month AND i.currency=NEW.currency AND i.state IN ${live})`,
      'allocation payment is not a live payment for this person, month and currency',
    )}
    ${fail(
      `COALESCE((SELECT json_extract(command_json,'$.amount_cents') FROM staff_payment_effective_events WHERE NEW.payment_kind='event' AND id=NEW.payment_id),
        (SELECT amount_cents FROM payment_run_items WHERE NEW.payment_kind='run_item' AND id=NEW.payment_id),0)
        < NEW.amount_cents + ${sum(`payment_kind=NEW.payment_kind AND payment_id=NEW.payment_id`)}`,
      'allocation exceeds the payment',
    )}
    ${fail(
      `COALESCE((SELECT amount_cents FROM staff_payment_balances WHERE user_id=NEW.user_id AND month=NEW.month AND currency=NEW.currency),-1)
        < NEW.amount_cents + ${sum(`user_id=NEW.user_id AND month=NEW.month AND currency=NEW.currency`)}`,
      'allocation exceeds the earnings for the month',
    )}
    ${fail(
      `NEW.scope<>'month' AND ${review} IS NULL`,
      'allocation to a project or entry requires a confirmed actuals review',
    )}
    ${fail(
      `NEW.scope<>'month' AND COALESCE((SELECT SUM(${earned(`json_extract(j.value,'$.selected_seconds')`, `COALESCE(json_extract(j.value,'$.cost_rate_cents'),0)`)})
        FROM json_each(${review}) j WHERE json_extract(j.value,'$.project_id')=NEW.project_id),0)
        < NEW.amount_cents + ${sum(`user_id=NEW.user_id AND month=NEW.month AND currency=NEW.currency AND project_id=NEW.project_id`)}`,
      'allocation exceeds the earnings of the project',
    )}
    ${fail(
      `NEW.scope='entry' AND (${entry} IS NULL OR json_extract(${entry},'$.project_id') IS NOT NEW.project_id
        OR json_extract(${entry},'$.selected_seconds')<=0 OR json_extract(${entry},'$.cost_rate_cents') IS NOT NEW.rate_cents)`,
      'allocation entry is not in the confirmed review at the captured rate',
    )}
    ${fail(
      `NEW.scope='entry' AND NEW.amount_cents + ${sum(`user_id=NEW.user_id AND month=NEW.month AND entry_id=NEW.entry_id`)}
        > ${earned(`json_extract(${entry},'$.selected_seconds')`, 'NEW.rate_cents')}`,
      'allocation exceeds the earnings of the entry',
    )}
    ${fail(
      `NEW.scope='entry' AND NEW.seconds IS NOT NULL AND NEW.seconds + (SELECT COALESCE(SUM(seconds),0) FROM staff_payment_allocation_ledger
        WHERE ${unreleased} AND user_id=NEW.user_id AND month=NEW.month AND entry_id=NEW.entry_id) > json_extract(${entry},'$.selected_seconds')`,
      'allocation exceeds the hours of the entry',
    )}
    ${fail(
      `NEW.seconds IS NOT NULL AND NEW.amount_cents > ${earned('NEW.seconds', 'NEW.rate_cents')}`,
      'allocation amount exceeds the value of its hours',
    )}
  END`,
  // A work-month correction re-files a register under another month; an
  // allocation names its month, so allocations must be reversed first.
  `CREATE TRIGGER staff_payment_period_move_allocations BEFORE INSERT ON staff_payment_period_moves BEGIN
    ${fail(
      `EXISTS(SELECT 1 FROM staff_payment_allocation_ledger WHERE ${unreleased} AND user_id=NEW.user_id AND month IN (NEW.from_month,NEW.to_month))`,
      'reverse the payment allocations before correcting the work month',
    )}
  END`,
  ...['staff_payment_allocations', 'staff_payment_allocation_reversals'].flatMap((table) => [
    `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT,'payment allocation history is immutable'); END`,
    `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'payment allocation history is immutable'); END`,
  ]),
] as const
