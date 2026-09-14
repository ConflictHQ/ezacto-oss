import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { migrateContainer } from '../src/migrate.js'

/**
 * The client-facing subjects named the wrong number.
 *
 * Three seeded templates built their subject from `%invoice_id%`, which the
 * delivery path fills with the primary key, while their bodies used
 * `%invoice_number%`. One message, two different answers about one invoice.
 *
 * Every existing template test asserts that substitution happens, not which
 * variable was chosen -- and both are real variables that substitute correctly,
 * so none of them could see this. It took sending a real invoice and reading
 * what arrived. These assertions are about the choice.
 */
const heads = async () => {
  const db = new Database(':memory:')
  await migrateContainer(db)
  return db
    .prepare(
      `SELECT h.template_kind AS kind, h.current_version AS version,
              t.subject_template AS subject, t.text_template AS body
         FROM email_template_heads h
         JOIN email_template_versions t
           ON t.template_kind = h.template_kind AND t.version = h.current_version`,
    )
    .all() as { kind: string; version: number; subject: string; body: string }[]
}

describe('invoice subject names the invoice number', () => {
  it('[unit] puts the number a client recognises in every client-facing subject', async () => {
    const live = await heads()
    const client = live.filter((t) =>
      ['invoice', 'reminder', 'thank_you'].includes(t.kind),
    )
    expect(client).toHaveLength(3)
    for (const template of client) {
      expect(template.subject, template.kind).toContain('%invoice_number%')
      // The primary key is not a number any client has ever seen.
      expect(template.subject, template.kind).not.toContain('%invoice_id%')
    }
  }, 30_000)

  it('[unit] keeps each subject agreeing with its own body', async () => {
    // The defect was the disagreement, not the variable: a subject saying
    // 852537948661725 over a body saying 249 is worse than either alone.
    for (const template of await heads()) {
      if (!template.body.includes('%invoice_number%')) continue
      expect(template.subject, template.kind).not.toContain('%invoice_id%')
    }
  }, 30_000)

  it('[unit] leaves the account templates alone', async () => {
    // Verification and password-reset mail names no invoice, so the migration
    // must not have touched them -- a migration that rewrites more than it
    // claims is the one nobody reviews closely enough.
    //
    // Asserted on what those templates say rather than on their version
    // number. The version was a proxy for "0046 did not touch this", and it
    // stopped meaning that the moment another migration touched them for an
    // unrelated reason -- 0072 gives every kind an HTML part. The claim here is
    // about invoice wording, so that is what it reads.
    const auth = (await heads()).filter((t) => t.kind.startsWith('auth_'))
    expect(auth).toHaveLength(2)
    for (const template of auth) {
      for (const field of [template.subject, template.body]) {
        expect(field, template.kind).not.toContain('%invoice_number%')
        expect(field, template.kind).not.toContain('%invoice_id%')
      }
    }
  }, 30_000)
})
