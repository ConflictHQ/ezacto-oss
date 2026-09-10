#!/usr/bin/env node
/**
 * Add a second verified address to people who arrived from Harvest with a
 * personal one.
 *
 * Harvest stores whatever address a person signed up with, which for half this
 * account is a gmail. OIDC resolves an identity by matching the asserted email
 * against `user_emails` -- any verified, non-invalidated row, primary or not
 * (`emailQuery`, packages/db/src/identity.ts) -- so a person whose Google
 * account is their work address matches nothing, falls through to provisioning,
 * and is refused:
 *
 *   provisioning_not_permitted — this identity provider account is not on a
 *   domain this instance provisions from
 *
 * Adding the work address as a second verified row makes that sign-in LINK to
 * the person who already owns thirteen years of their timesheets, instead of
 * provisioning a second account beside it. Which is the whole point: allowing
 * the domain would let them in, but into an empty account.
 *
 * The mapping is not in this repository and must not be: it is one firm's
 * staff directory. Pass it with --input.
 *
 * Idempotent. An address that is already present is left alone rather than
 * re-inserted, so this is safe to re-run -- and it has to be re-run against any
 * freshly loaded database, because a load carries only what Harvest holds.
 */

import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const usage = `usage: link-work-emails.mjs --input <mapping.json> (--sqlite <path> | --d1 <name>) [--apply]

  --input   JSON array of { "id": <user id>, "address": "<work address>" }
  --sqlite  a local SQLite database (the cutover artefact)
  --d1      a remote D1 database name, applied with wrangler
  --apply   actually write. Without it, prints the plan and changes nothing.
`

const args = process.argv.slice(2)
const flag = (name) => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}
const input = flag('--input')
const sqlitePath = flag('--sqlite')
const d1Name = flag('--d1')
const apply = args.includes('--apply')

if (input === undefined || (sqlitePath === undefined) === (d1Name === undefined)) {
  process.stderr.write(usage)
  process.exit(2)
}

const mapping = JSON.parse(await readFile(input, 'utf8'))
if (!Array.isArray(mapping) || mapping.length === 0) {
  process.stderr.write('mapping must be a non-empty array\n')
  process.exit(2)
}
for (const row of mapping) {
  if (!Number.isSafeInteger(row.id) || row.id < 1 || typeof row.address !== 'string') {
    process.stderr.write(`bad mapping row: ${JSON.stringify(row)}\n`)
    process.exit(2)
  }
  // A malformed address here becomes a verified credential that matches an OIDC
  // assertion, so it is checked before it is trusted rather than after.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(row.address)) {
    process.stderr.write(`not an email address: ${row.address}\n`)
    process.exit(2)
  }
}

const now = new Date().toISOString().replace(/\.\d+Z$/u, '.000Z')

/**
 * `is_primary` stays 0. The primary address is the one the person has been
 * receiving mail at, and quietly moving it is a change nobody asked for --
 * linking does not need it, because the match ignores primary.
 *
 * The id is taken from the table's own maximum rather than passed in, so two
 * runs against two databases do not have to agree on ids they cannot both know.
 */
const statements = (startId) =>
  mapping.map((row, index) => ({
    address: row.address,
    userId: row.id,
    sql:
      `INSERT INTO user_emails (id, user_id, address, verified_at, is_primary, created_at, updated_at) ` +
      `SELECT ${startId + index}, ${row.id}, '${row.address.replace(/'/gu, "''")}', '${now}', 0, '${now}', '${now}' ` +
      `WHERE EXISTS (SELECT 1 FROM users WHERE id = ${row.id}) ` +
      `AND NOT EXISTS (SELECT 1 FROM user_emails WHERE lower(address) = lower('${row.address.replace(/'/gu, "''")}'))`,
  }))

const sqlite = async () => {
  const { stdout } = await run('sqlite3', [sqlitePath, 'SELECT coalesce(max(id),0)+1 FROM user_emails;'])
  const start = Number(stdout.trim())
  const plan = statements(start)
  if (!apply) return plan
  for (const item of plan) await run('sqlite3', [sqlitePath, item.sql])
  return plan
}

const d1 = async () => {
  const exec = async (sql) => {
    const { stdout } = await run(
      'npx',
      ['wrangler', 'd1', 'execute', d1Name, '--remote', '--json', '--command', sql],
      { env: { ...process.env, CLOUDFLARE_API_TOKEN: undefined } },
    )
    const text = stdout.slice(stdout.indexOf('['))
    return JSON.parse(text.slice(0, text.lastIndexOf(']') + 1))
  }
  const [{ results }] = await exec('SELECT coalesce(max(id),0)+1 AS next FROM user_emails')
  const plan = statements(Number(results[0].next))
  if (!apply) return plan
  for (const item of plan) await exec(item.sql)
  return plan
}

const plan = sqlitePath === undefined ? await d1() : await sqlite()
for (const item of plan) {
  process.stdout.write(`${apply ? 'linked' : 'would link'}  user ${item.userId}  ${item.address}\n`)
}
process.stdout.write(`${plan.length} address(es); ${apply ? 'applied' : 'dry run — pass --apply to write'}\n`)
