// Provenance: issue 648, split out of 288.
//
// A recurring definition an import could not finish sits at
// `definition_status = 'incomplete'` with NULL terms. Three of them carry about
// ninety invoices between them, so they are live billing -- and until now the
// only way to give one its terms was the migrate CLI's worksheet.
//
// That path cannot run where the data lives. Migration 0024's
// `worksheet_recurring_completion_update` admits the incomplete -> complete flip
// only against `_ezacto_worksheet_import_authority`, whose rows are bound to a
// snapshot digest that `sync` invalidates; and the worksheet tool opens a local
// SQLite file, which a hosted D1 database is not. The guard is right about what
// it guards. It is simply the only door, and it opens onto a room nobody is
// standing in any more.
//
// So: a second door, with the same lock. An operator's completion is admitted
// the way every other privileged write here is admitted -- by a row that says
// what is about to happen, matched exactly against what happens. This is the
// shape `invoice_command_ledger` uses for invoices and
// `_ezacto_worksheet_import_authority` uses for the import.
//
// What this deliberately does not do is relax the original trigger. A migration
// completion still needs migration authority. The two doors stay separate
// because they record different things: one says "the source said so", the
// other says "a named person typed it in", and a table that blurred them would
// be unable to answer which.

const canonicalTimestamp = (column: string) => `unixepoch(${column}) IS NOT NULL
  AND substr(${column}, 1, 19) = strftime('%Y-%m-%dT%H:%M:%S', ${column})
  AND (
    ${column} GLOB '????-??-??T??:??:??Z'
    OR ${column} GLOB '????-??-??T??:??:??.[0-9][0-9][0-9]Z'
  )`

export const recurringDefinitionRepairMigration = [
  `CREATE TABLE recurring_definition_completions (
    -- One completion per definition. A definition is completed once; editing it
    -- afterwards is \`updateRecurring\`, which the original trigger already
    -- permits because it never touches definition_status.
    recurring_invoice_id INTEGER PRIMARY KEY
      REFERENCES recurring_invoices(id) ON DELETE RESTRICT,
    -- Who typed the terms in. The whole reason this door is separate from the
    -- worksheet's: that one records what a source said, this one records what a
    -- person claimed, and a payment schedule that appeared with no author is
    -- one nobody can be asked about.
    completed_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    completed_at TEXT NOT NULL CHECK (${canonicalTimestamp('completed_at')}),

    -- The terms, stated ahead of the write so the trigger can hold the write to
    -- them. Stored rather than derived: this is the record of what was entered,
    -- and re-reading the definition later answers a different question, because
    -- the definition may have been edited since.
    subject_template TEXT NOT NULL CHECK (length(trim(subject_template)) > 0),
    notes_template TEXT NOT NULL,
    every_n_months INTEGER NOT NULL CHECK (every_n_months >= 1),
    day_of_month INTEGER NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
    next_issue_on TEXT NOT NULL CHECK (date(next_issue_on, '+0 days') IS next_issue_on),
    amount_config TEXT NOT NULL CHECK (json_valid(amount_config)),
    can_draw_from_retainer_id INTEGER REFERENCES retainers(id) ON DELETE RESTRICT,
    -- Binds this row to one exact write, the way the import authority binds to
    -- one exact row version. Without it a completion could authorise a second,
    -- different flip later.
    target_updated_at TEXT NOT NULL CHECK (${canonicalTimestamp('target_updated_at')})
  ) STRICT`,

  `CREATE INDEX recurring_definition_completions_user
    ON recurring_definition_completions(completed_by_user_id, completed_at)`,

  // Immutable, for the same reason the email intents are: this is the record of
  // what somebody entered, and a record that can be edited afterwards answers a
  // different question than the one it was kept for.
  `CREATE TRIGGER recurring_definition_completions_no_update
    BEFORE UPDATE ON recurring_definition_completions
    BEGIN SELECT RAISE(ABORT, 'a definition completion is immutable'); END`,
  `CREATE TRIGGER recurring_definition_completions_no_delete
    BEFORE DELETE ON recurring_definition_completions
    BEGIN SELECT RAISE(ABORT, 'a definition completion is immutable'); END`,

  // A completion may only be claimed for a definition that is actually a stub.
  // Without this, a row could be written against an already-complete definition
  // and sit there asserting an authorship that never happened.
  `CREATE TRIGGER recurring_definition_completions_require_stub
    BEFORE INSERT ON recurring_definition_completions
    WHEN NOT EXISTS (
      SELECT 1 FROM recurring_invoices recurring
      WHERE recurring.id = NEW.recurring_invoice_id
        AND recurring.definition_status = 'incomplete'
    )
    BEGIN SELECT RAISE(ABORT, 'only an incomplete definition can be completed'); END`,

  // Replace the 0024 trigger with one that admits either door. The worksheet
  // branch is reproduced verbatim -- a migration completion still needs
  // migration authority -- and the operator branch is held to the same standard:
  // every field matched, and bound to the exact row version being written.
  `DROP TRIGGER worksheet_recurring_completion_update`,
  `CREATE TRIGGER worksheet_recurring_completion_update
    BEFORE UPDATE OF definition_status, subject_template, notes_template,
      every_n_months, day_of_month, next_issue_on, amount_config,
      can_draw_from_retainer_id, updated_at ON recurring_invoices
    WHEN OLD.definition_status = 'incomplete' AND NEW.definition_status = 'complete'
      AND NOT EXISTS (
        SELECT 1 FROM _ezacto_worksheet_import_authority authority
        WHERE authority.kind = 'recurring_invoice_definition'
          AND authority.harvest_id = OLD.harvest_id
          AND authority.resource_id = OLD.id
          AND authority.target_updated_at = NEW.updated_at
          AND json_extract(authority.input_json, '$.harvest_recurring_invoice_id')
            IS OLD.harvest_id
          AND json_extract(authority.input_json, '$.subject_template')
            IS NEW.subject_template
          AND json_extract(authority.input_json, '$.notes_template')
            IS NEW.notes_template
          AND json_extract(authority.input_json, '$.every_n_months')
            IS NEW.every_n_months
          AND json_extract(authority.input_json, '$.day_of_month')
            IS NEW.day_of_month
          AND json_extract(authority.input_json, '$.next_issue_on')
            IS NEW.next_issue_on
          AND json_extract(authority.input_json, '$.amount_config')
            IS NEW.amount_config
          AND json_extract(authority.input_json, '$.can_draw_from_retainer_id')
            IS NEW.can_draw_from_retainer_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM recurring_definition_completions completion
        WHERE completion.recurring_invoice_id = OLD.id
          AND completion.target_updated_at = NEW.updated_at
          AND completion.subject_template IS NEW.subject_template
          AND completion.notes_template IS NEW.notes_template
          AND completion.every_n_months IS NEW.every_n_months
          AND completion.day_of_month IS NEW.day_of_month
          AND completion.next_issue_on IS NEW.next_issue_on
          AND completion.amount_config IS NEW.amount_config
          AND completion.can_draw_from_retainer_id IS NEW.can_draw_from_retainer_id
      )
    BEGIN SELECT RAISE(ABORT, 'recurring completion requires worksheet or operator authority'); END`,
] as const
