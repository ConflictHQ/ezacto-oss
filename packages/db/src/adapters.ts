import type BetterSqlite3 from 'better-sqlite3'
import { drizzle as drizzleD1 } from 'drizzle-orm/d1'
import { drizzle as drizzleBetterSqlite } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema.js'

export const createContainerDatabase = (database: BetterSqlite3.Database) => {
  database.pragma('foreign_keys = ON')
  return drizzleBetterSqlite(database, { schema })
}

export const createD1Database = (database: D1Database) => drizzleD1(database, { schema })
