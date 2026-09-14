import BetterSqlite3 from 'better-sqlite3'
import { inspectEmailTemplateVariables } from '@ezacto/core'
import { afterEach, describe, expect, it } from 'vitest'
import { migrateContainer, migrateContainerThrough } from '../src/migrate.js'
import { emailHtmlTemplatesMigration } from '../src/migrations/0072_email_html_templates.js'

const at = '2026-09-11T12:00:00.000Z'
let sqlite: BetterSqlite3.Database | null = null
afterEach(() => {
  sqlite?.close()
  sqlite = null
})

const KINDS = [
  'invoice',
  'reminder',
  'thank_you',
  'auth_email_verification',
  'auth_password_reset',
] as const

/**
 * The HTML part of the mail this instance sends (issue 666).
 *
 * The surface a client sees, which had no design at all while the web app had a
 * compiled token system and a contrast check.
 */
describe('the html templates', () => {
  const fresh = async () => {
    const database = new BetterSqlite3(':memory:')
    sqlite = database
    await migrateContainer(database)
    return database
  }

  it('[security] uses only variables its own kind allows', async () => {
    // The one that would break a real send rather than look wrong. Every
    // template is seeded with `unknown_variable_policy = 'error'`, so a
    // mistyped or out-of-kind variable does not degrade -- it refuses to
    // render, on the invoice mail, at the moment somebody sends it.
    const database = await fresh()
    const rows = database
      .prepare(
        `SELECT version.template_kind AS kind, version.html_template AS html
         FROM email_template_heads head
         JOIN email_template_versions version
           ON version.template_kind = head.template_kind
          AND version.version = head.current_version`,
      )
      .all() as { kind: string; html: string | null }[]
    expect(rows).toHaveLength(KINDS.length)
    for (const row of rows) {
      expect(row.html, `${row.kind} has no html part`).not.toBeNull()
      expect(
        inspectEmailTemplateVariables(row.kind as never, row.html!),
        `${row.kind} html uses a variable it may not`,
      ).toEqual([])
    }
  })

  it('[unit] carries the live subject and text forward untouched', async () => {
    // This adds an alternative part; it does not rewrite what a plain-text
    // reader already receives.
    const database = await fresh()
    const rows = database
      .prepare(
        `SELECT current.template_kind AS kind, current.subject_template AS subject,
           current.text_template AS text, previous.subject_template AS wasSubject,
           previous.text_template AS wasText
         FROM email_template_heads head
         JOIN email_template_versions current
           ON current.template_kind = head.template_kind
          AND current.version = head.current_version
         JOIN email_template_versions previous
           ON previous.template_kind = head.template_kind
          AND previous.version = head.current_version - 1`,
      )
      .all() as { kind: string; subject: string; text: string; wasSubject: string; wasText: string }[]
    expect(rows).toHaveLength(KINDS.length)
    for (const row of rows) {
      expect(row.subject, `${row.kind} subject changed`).toBe(row.wasSubject)
      expect(row.text, `${row.kind} text changed`).toBe(row.wasText)
    }
  })

  it('[security] never renders a dead payment link', async () => {
    // `invoice_payment_url` is an empty string wherever the deployment has no
    // Stripe or the invoice owes nothing, and this template system substitutes
    // without conditionals -- so a call to action would ship `href=""` on most
    // sends. A dead Pay button on a client-facing invoice is worse than none.
    const database = await fresh()
    const html = database
      .prepare(
        `SELECT version.html_template AS html FROM email_template_heads head
         JOIN email_template_versions version
           ON version.template_kind = head.template_kind
          AND version.version = head.current_version
         WHERE head.template_kind = 'invoice'`,
      )
      .get() as { html: string }
    expect(html.html).not.toContain('%invoice_payment_url%')
  })

  it('[money] leaves a template somebody edited exactly as they wrote it', async () => {
    // A person who rewrote their invoice wording meant it, and a colour change
    // is not a reason to discard it.
    const database = new BetterSqlite3(':memory:')
    sqlite = database
    migrateContainerThrough(database, '0071_source_lineage')
    database.exec(`
      INSERT INTO organizations (name, modules, created_at, updated_at)
        VALUES ('Fixture', '{}', '${at}', '${at}');
      INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
        VALUES (1, 'Operator', 'One', 'administrator', '[]', '${at}', '${at}');
    `)
    const head = database
      .prepare(`SELECT current_version AS v FROM email_template_heads WHERE template_kind = 'invoice'`)
      .get() as { v: number }
    // A person's own version, on top of whatever the system last wrote.
    database
      .prepare(
        `INSERT INTO email_template_versions
           (template_kind, version, subject_template, text_template,
            unknown_variable_policy, created_by_user_id, created_at)
         VALUES ('invoice', ?, 'Our invoice %invoice_number%',
           'Hand-written wording.', 'error', 1, ?)`,
      )
      .run(head.v + 1, at)
    database
      .prepare(`UPDATE email_template_heads SET current_version = ?, updated_at = ? WHERE template_kind = 'invoice'`)
      .run(head.v + 1, at)

    for (const statement of emailHtmlTemplatesMigration) database.exec(statement)

    const after = database
      .prepare(
        `SELECT head.current_version AS version, version.text_template AS text,
           version.html_template AS html
         FROM email_template_heads head
         JOIN email_template_versions version
           ON version.template_kind = head.template_kind
          AND version.version = head.current_version
         WHERE head.template_kind = 'invoice'`,
      )
      .get() as { version: number; text: string; html: string | null }
    expect(after.version, 'the edited head was moved').toBe(head.v + 1)
    expect(after.text).toBe('Hand-written wording.')
    expect(after.html, 'an edited template was given an html part').toBeNull()

    // And the kinds nobody touched still got theirs, in the same run.
    const reminder = database
      .prepare(
        `SELECT version.html_template AS html FROM email_template_heads head
         JOIN email_template_versions version
           ON version.template_kind = head.template_kind
          AND version.version = head.current_version
         WHERE head.template_kind = 'reminder'`,
      )
      .get() as { html: string | null }
    expect(reminder.html, 'an untouched kind was skipped too').not.toBeNull()
  })
})
