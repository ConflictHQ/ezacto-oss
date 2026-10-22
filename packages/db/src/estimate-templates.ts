import { sql } from 'drizzle-orm'
import {
  canProfileUseApiScope,
  EstimateContentError,
  estimateTemplateName,
  parseEstimateContent,
  estimateContentTotals,
  type EstimateTemplate,
  type UserProfile,
} from '@ezacto/core'
import { runAtomic, type InvoiceStateDatabase } from './invoice-state.js'
interface Actor {
  userId: number
  profile: UserProfile
}
interface Stored {
  id: string
  name: string
  version: number
  archived: number
  content_json: string
  created_at: string
  updated_at: string
}
const serialize = (row: Stored): EstimateTemplate => ({
  id: row.id,
  name: row.name,
  version: row.version,
  archived: row.archived === 1,
  content: parseEstimateContent(JSON.parse(row.content_json)),
  created_at: row.created_at,
  updated_at: row.updated_at,
})
const conflict = (message: string): never => {
  throw new EstimateContentError('estimate_template_conflict', message)
}
const authorize = (actor: Actor) => {
  if (!canProfileUseApiScope(actor.profile, 'invoices:write'))
    conflict('Estimate write authority is required.')
}
export const createEstimateTemplateRepository = (db: InvoiceStateDatabase) => {
  const get = async (id: string) => {
    const row = (await db.all<Stored>(sql`SELECT * FROM estimate_templates WHERE id=${id}`))[0]
    if (!row)
      throw new EstimateContentError(
        'estimate_template_not_found',
        'Estimate template does not exist.',
      )
    return serialize(row)
  }
  return {
    async list() {
      return (
        await db.all<Stored>(
          sql`SELECT * FROM estimate_templates ORDER BY archived,name,id LIMIT 1001`,
        )
      ).map(serialize)
    },
    get,
    async save(
      actor: Actor,
      input: {
        id?: string
        expected_version?: number
        name: unknown
        content: unknown
        archived?: boolean
      },
      now: string,
    ) {
      authorize(actor)
      const name = estimateTemplateName(input.name),
        content = JSON.stringify(parseEstimateContent(input.content))
      if (input.id === undefined) {
        const id = crypto.randomUUID()
        await db.run(
          sql`INSERT INTO estimate_templates(id,name,content_json,actor_user_id,created_at,updated_at) VALUES(${id},${name},${content},${actor.userId},${now},${now})`,
        )
        return get(id)
      }
      const rows = await db.all<Stored>(
        sql`UPDATE estimate_templates SET name=${name},content_json=${content},archived=${input.archived ? 1 : 0},actor_user_id=${actor.userId},updated_at=${now},version=version+1 WHERE id=${input.id} AND version=${input.expected_version ?? -1} AND archived=0 RETURNING *`,
      )
      if (!rows[0]) conflict('The template changed or was archived. Reload before editing.')
      return serialize(rows[0]!)
    },
    async createDraft(
      actor: Actor,
      input: {
        client_id: number
        number: string
        issue_date: string
        content: unknown
        template_id: string | null
        template_version: number | null
      },
      key: string,
      now: string,
    ) {
      authorize(actor)
      if (
        !Number.isSafeInteger(input.client_id) ||
        input.client_id < 1 ||
        typeof input.number !== 'string' ||
        !input.number.trim() ||
        input.number.length > 100 ||
        !/^\d{4}-\d{2}-\d{2}$/.test(input.issue_date) ||
        !Number.isFinite(Date.parse(input.issue_date + 'T00:00:00Z')) ||
        new Date(input.issue_date + 'T00:00:00Z').toISOString().slice(0, 10) !== input.issue_date
      )
        throw new EstimateContentError(
          'invalid_estimate_content',
          'Choose a client, a new estimate number and a real issue date.',
        )
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key))
        throw new EstimateContentError(
          'invalid_estimate_content',
          'An idempotency key is required.',
        )
      if (
        input.template_id !== null &&
        (typeof input.template_id !== 'string' || !/^[0-9a-f-]{36}$/.test(input.template_id))
      )
        conflict('Choose a valid template identity.')
      if (
        (input.template_id === null) !== (input.template_version === null) ||
        (input.template_version !== null &&
          (!Number.isSafeInteger(input.template_version) || input.template_version < 0))
      )
        conflict('Choose a current template version.')
      const content = parseEstimateContent(input.content),
        totals = estimateContentTotals(content),
        request = JSON.stringify({ ...input, content }),
        command = `${actor.userId}:${key}`
      const prior = (
        await db.all<{ request_json: string; estimate_id: number }>(
          sql`SELECT request_json,estimate_id FROM estimate_draft_commands WHERE command_id=${command}`,
        )
      )[0]
      if (prior) {
        if (prior.request_json !== request)
          throw new EstimateContentError(
            'estimate_draft_conflict',
            'The idempotency key was used for different content.',
          )
        return { id: prior.estimate_id }
      }
      if (input.template_id !== null) {
        const template = await get(input.template_id)
        if (template.archived || template.version !== input.template_version)
          conflict('The template changed or was archived. Reload it before creating a draft.')
      }
      const exists = (
        await db.all<{ id: number }>(
          sql`SELECT id FROM clients WHERE id=${input.client_id} AND is_active=1`,
        )
      )[0]
      if (!exists)
        throw new EstimateContentError('invalid_estimate_content', 'Choose an active client.')
      try {
        await runAtomic(db, [
          {
            text: `INSERT INTO estimate_draft_commands(command_id,actor_user_id,request_json,template_id,template_version,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(command_id) DO UPDATE SET request_json=excluded.request_json`,
            params: [
              command,
              actor.userId,
              request,
              input.template_id,
              input.template_version,
              now,
            ],
          },
          {
            text: `INSERT INTO estimates(client_id,created_by_user_id,number,subject,notes,currency,issue_date,tax_rate_ppm,tax2_rate_ppm,discount_rate_ppm,amount_cents,tax_amount_cents,tax2_amount_cents,discount_amount_cents,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT estimate_id FROM estimate_draft_commands WHERE command_id=?) IS NULL`,
            params: [
              input.client_id,
              actor.userId,
              input.number.trim(),
              content.subject,
              content.notes,
              content.currency,
              input.issue_date,
              content.tax_rate_ppm,
              content.tax2_rate_ppm,
              content.discount_rate_ppm,
              totals.amount_cents,
              totals.tax_amount_cents,
              totals.tax2_amount_cents,
              totals.discount_amount_cents,
              now,
              now,
              command,
            ],
          },
          ...content.lines.map((line, position) => ({
            text: `INSERT INTO estimate_line_items(estimate_id,position,kind,description,quantity,unit_price_cents,amount_cents,taxed,taxed2,created_at,updated_at) SELECT id,?,?,?,?,?,?,?,?,?,? FROM estimates WHERE number=? AND (SELECT estimate_id FROM estimate_draft_commands WHERE command_id=?) IS NULL`,
            params: [
              position,
              line.kind,
              line.description,
              line.quantity,
              line.unit_price_cents,
              totals.amounts[position]!,
              line.taxed ? 1 : 0,
              line.taxed2 ? 1 : 0,
              now,
              now,
              input.number.trim(),
              command,
            ],
          })),
          {
            text: `UPDATE estimate_draft_commands SET estimate_id=(SELECT id FROM estimates WHERE number=?) WHERE command_id=? AND estimate_id IS NULL`,
            params: [input.number.trim(), command],
          },
        ])
      } catch (error) {
        const message = error instanceof Error ? error.message : ''
        if (/estimate_template_conflict/.test(message))
          conflict('The template changed or was archived. Reload before creating a draft.')
        if (/UNIQUE constraint failed: estimates.number|estimate identity already exists|estimate_draft_conflict/.test(message))
          throw new EstimateContentError(
            'estimate_draft_conflict',
            'Choose a new estimate number and idempotency key.',
          )
        throw error
      }
      const result = (
        await db.all<{ id: number }>(
          sql`SELECT estimate_id AS id FROM estimate_draft_commands WHERE command_id=${command}`,
        )
      )[0]!
      return result
    },
  }
}
