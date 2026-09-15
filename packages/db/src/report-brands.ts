/** Nearest-ancestor report brand resolution (#55). Deployment branding is never consulted here. */
import { sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from './schema.js'

type Database = BetterSQLite3Database<typeof schema> | DrizzleD1Database<typeof schema>

export interface ResolvedReportBrand {
  readonly id: number
  readonly name: string
  readonly logoUrl: string | null
  readonly primaryColor: string | null
  readonly accentColor: string | null
  readonly sourceClientId: number
  readonly inheritedDepth: number
}

export const resolveReportBrand = async (
  database: Database,
  clientId: number,
): Promise<ResolvedReportBrand | null> => {
  if (!Number.isSafeInteger(clientId) || clientId < 1) throw new RangeError('client id must be positive')
  const rows = await database.all<{
    id: number
    name: string
    logoUrl: string | null
    primaryColor: string | null
    accentColor: string | null
    sourceClientId: number
    inheritedDepth: number
  }>(sql`
    WITH RECURSIVE lineage(id, parent_id, brand_id, depth, visited) AS (
      SELECT id, parent_client_id, report_brand_id, 0, printf(',%d,', id)
      FROM clients WHERE id = ${clientId}
      UNION ALL
      SELECT parent.id, parent.parent_client_id, parent.report_brand_id, lineage.depth + 1,
        lineage.visited || parent.id || ','
      FROM lineage
      JOIN clients parent ON parent.id = lineage.parent_id
      WHERE instr(lineage.visited, printf(',%d,', parent.id)) = 0
    )
    SELECT brand.id, brand.name, brand.logo_url AS "logoUrl",
      brand.primary_color AS "primaryColor", brand.accent_color AS "accentColor",
      lineage.id AS "sourceClientId", lineage.depth AS "inheritedDepth"
    FROM lineage
    JOIN report_brands brand ON brand.id = lineage.brand_id
    ORDER BY lineage.depth
    LIMIT 1`)
  return rows[0] ?? null
}
