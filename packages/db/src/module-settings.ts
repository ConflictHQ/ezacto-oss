import type BetterSqlite3 from 'better-sqlite3'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'

type ModuleSettingsDatabase =
  | BetterSQLite3Database<typeof schema>
  | DrizzleD1Database<typeof schema>
type NativeClient = BetterSqlite3.Database | D1Database

export type ModuleName = 'approval' | 'expenses' | 'own_money' | 'activity_log'

export interface ModuleState {
  module: ModuleName
  enabled: boolean
}

const knownModules: readonly ModuleName[] = ['approval', 'expenses', 'own_money', 'activity_log']

interface RawModulesRow {
  approval: number
  expenses: number
  own_money: number
  activity_log: number
}

const assertKnownModule = (module: string): void => {
  if (!(knownModules as readonly string[]).includes(module))
    throw new Error(`Unknown module: ${module}`)
}

const nativeClient = (database: ModuleSettingsDatabase): NativeClient =>
  (database as ModuleSettingsDatabase & { $client: NativeClient }).$client

const isD1Client = (client: NativeClient): client is D1Database => 'batch' in client

const first = async <Row>(
  client: NativeClient,
  sql: string,
  params: readonly unknown[] = [],
): Promise<Row | null> => {
  if (isD1Client(client)) return client.prepare(sql).bind(...params).first<Row>()
  return (client.prepare(sql).get(...params) as Row | undefined) ?? null
}

const modulesSelect = `SELECT
  COALESCE(json_extract(modules, '$.approval'), 0) AS approval,
  COALESCE(json_extract(modules, '$.expenses'), 0) AS expenses,
  COALESCE(json_extract(modules, '$.own_money'), 0) AS own_money,
  -- On when the key is absent: the log was always there, and an organization
  -- written before the switch existed must not lose it to an upgrade.
  COALESCE(json_extract(modules, '$.activity_log'), 1) AS activity_log
FROM organizations WHERE id = 1`

const toModuleStates = (row: RawModulesRow): readonly ModuleState[] =>
  knownModules.map((module) => ({
    module,
    enabled: row[module] === 1,
  }))

export class ModuleSettingsRepository {
  readonly #client: NativeClient

  constructor(database: ModuleSettingsDatabase) {
    this.#client = nativeClient(database)
  }

  async list(): Promise<readonly ModuleState[]> {
    const row = await first<RawModulesRow>(this.#client, modulesSelect)
    if (row === null) return knownModules.map((module) => ({ module, enabled: false }))
    return toModuleStates(row)
  }

  async get(module: ModuleName): Promise<boolean> {
    assertKnownModule(module)
    const row = await first<{ enabled: number }>(
      this.#client,
      `SELECT COALESCE(json_extract(modules, '$.${module}'), ${module === 'activity_log' ? 1 : 0}) AS enabled
       FROM organizations WHERE id = 1`,
    )
    return row?.enabled === 1
  }

  async setEnabled(
    module: ModuleName,
    enabled: boolean,
    updatedAt: string,
  ): Promise<readonly ModuleState[]> {
    assertKnownModule(module)
    const sqlValue = enabled ? 'json(\'true\')' : 'json(\'false\')'
    const updateSql = `UPDATE organizations
      SET modules = json_set(modules, '$.${module}', ${sqlValue}),
        updated_at = ?
      WHERE id = 1`
    const readSql = modulesSelect
    const client = this.#client

    if (isD1Client(client)) {
      const [, readResult] = await client.batch([
        client.prepare(updateSql).bind(updatedAt),
        client.prepare(readSql),
      ])
      const rows = (readResult?.results ?? []) as unknown as RawModulesRow[]
      if (rows[0]) return toModuleStates(rows[0])
      return knownModules.map((m) => ({ module: m, enabled: false }))
    }

    const execute = client.transaction(() => {
      client.prepare(updateSql).run(updatedAt)
      return client.prepare(readSql).get() as RawModulesRow | undefined
    })
    const row = execute.immediate()
    if (row) return toModuleStates(row)
    return knownModules.map((m) => ({ module: m, enabled: false }))
  }
}

export const createModuleSettingsRepository = (
  database: ModuleSettingsDatabase,
): ModuleSettingsRepository => new ModuleSettingsRepository(database)
