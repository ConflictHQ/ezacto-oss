import BetterSqlite3 from 'better-sqlite3'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { createContainerDatabase, createD1Database } from '../src/adapters.js'
import type { InvoiceStateDatabase } from '../src/invoice-state.js'
import { migrateContainer, migrateD1 } from '../src/migrate.js'
import { readUserNotifications, updateUserNotifications } from '../src/profile-notifications.js'

/**
 * Issue 935. A person edits their own reminder preferences, and only theirs:
 * the user id is the caller's to supply (the route takes it off the session),
 * so the one thing worth proving here is that it scopes the write.
 */

interface Harness {
  orm: InvoiceStateDatabase
  run(statement: string, ...bindings: unknown[]): Promise<void>
  close(): Promise<void>
}

const at = '2026-10-14T12:00:00.000Z'
const later = '2026-10-14T13:00:00.000Z'

const container = async (): Promise<Harness> => {
  const sqlite = new BetterSqlite3(':memory:')
  migrateContainer(sqlite)
  return {
    orm: createContainerDatabase(sqlite),
    run: async (statement, ...bindings) => void sqlite.prepare(statement).run(...bindings),
    close: async () => void sqlite.close(),
  }
}

const d1 = async (): Promise<Harness> => {
  const miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  })
  const database = await miniflare.getD1Database('DB')
  await migrateD1(database)
  return {
    orm: createD1Database(database),
    run: async (statement, ...bindings) =>
      void (await database.prepare(statement).bind(...bindings).run()),
    close: async () => miniflare.dispose(),
  }
}

const patch = {
  dailyReminderEnabled: true,
  reminderTime: '17:00',
  reminderDays: ['monday', 'friday'] as const,
  emailEnabled: true,
  desktopEnabled: false,
  slackEnabled: false,
  includeInTeamReminders: false,
  weeklyDigest: true,
  notifyProjectDeleted: false,
}

for (const [name, factory] of [
  ['SQLite', container],
  ['real D1', d1],
] as const) {
  describe(`own notification preferences (${name})`, () => {
    let db: Harness | undefined
    afterEach(async () => db?.close())

    it('[unit] reads a new person as opted in to team reminders and off for the rest, then saves their own', async () => {
      db = await factory()
      await db.run(
        `INSERT INTO organizations (name, modules, created_at, updated_at) VALUES ('CONFLICT', '{}', ?, ?)`,
        at,
        at,
      )
      await db.run(
        `INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at) VALUES
           (1, 'Ada', 'Admin', 'administrator', '[]', ?, ?), (2, 'Mo', 'Member', 'member', '[]', ?, ?)`,
        at,
        at,
        at,
        at,
      )

      expect(await readUserNotifications(db.orm, 2)).toMatchObject({
        deliveryActive: true,
        dailyReminderEnabled: false,
        emailEnabled: false,
        includeInTeamReminders: true,
        weeklyDigest: false,
      })

      const saved = await updateUserNotifications(db.orm, 2, patch, later)
      expect(saved).toMatchObject({
        dailyReminderEnabled: true,
        reminderTime: '17:00',
        reminderDays: ['monday', 'friday'],
        emailEnabled: true,
        includeInTeamReminders: false,
        weeklyDigest: true,
        updatedAt: later,
      })
      // Ada's row is not Mo's.
      expect(await readUserNotifications(db.orm, 1)).toMatchObject({
        dailyReminderEnabled: false,
        includeInTeamReminders: true,
      })
      expect(await readUserNotifications(db.orm, 99)).toBeNull()
      expect(await updateUserNotifications(db.orm, 99, patch, later)).toBeNull()
    })

    it('[unit] leaves the schema to refuse a daily reminder with nothing to say when or where', async () => {
      db = await factory()
      await db.run(
        `INSERT INTO organizations (name, modules, created_at, updated_at) VALUES ('CONFLICT', '{}', ?, ?)`,
        at,
        at,
      )
      await db.run(
        `INSERT INTO users (id, first_name, last_name, profile, manager_grants, created_at, updated_at)
         VALUES (1, 'Ada', 'Admin', 'administrator', '[]', ?, ?)`,
        at,
        at,
      )
      await expect(
        updateUserNotifications(db.orm, 1, { ...patch, reminderTime: null }, later),
      ).rejects.toThrow()
      expect((await readUserNotifications(db.orm, 1))?.dailyReminderEnabled).toBe(false)
    })
  })
}
