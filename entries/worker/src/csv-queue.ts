export interface CsvWorkerMessage {
  kind: 'csv-import'
  stage_id: string
}

interface Publication {
  id: string
  version: number
  status: string
  expires_at: string
  publish_pending: number
  next_attempt_at: string | null
}

const stageId = (value: unknown): value is string =>
  typeof value === 'string' && /^csv_[a-f0-9]{32}$/.test(value)
const messageBody = (value: unknown): value is CsvWorkerMessage => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const body = value as Record<string, unknown>
  return Object.keys(body).length === 2 && body.kind === 'csv-import' && stageId(body.stage_id)
}
const eligible = (row: Publication | null, now: number): row is Publication =>
  row !== null && ['queued', 'partial', 'running'].includes(row.status) && Date.parse(row.expires_at) > now

/** The queue carries only a private stage pointer. The executor owns all
 * source, mapping, native-session, lease and write fences. */
export const createWorkerCsvQueue = (options: {
  database: D1Database
  queue: Queue<CsvWorkerMessage>
  execute(stageId: string): Promise<void>
}) => {
  const read = (id: string) => options.database.prepare(
    'SELECT id,version,status,expires_at,publish_pending,next_attempt_at FROM csv_worker_stages WHERE id=?',
  ).bind(id).first<Publication>()
  const publish = async (id: string): Promise<void> => {
    if (!stageId(id)) throw new Error('Invalid CSV stage pointer')
    const row = await read(id), now = Date.now()
    if (!eligible(row, now) || row.publish_pending !== 1) return
    const retryAt = row.next_attempt_at === null ? now : Date.parse(row.next_attempt_at)
    if (!Number.isFinite(retryAt)) throw new Error('Invalid CSV continuation time')
    const delaySeconds = Math.min(43_200, Math.max(0, Math.ceil((retryAt - now) / 1000)))
    await options.queue.send({ kind: 'csv-import', stage_id: id }, { delaySeconds })
    // A send failure (including an unknown acknowledgement) retains the outbox.
    // A new version may already need its own continuation; never clear that flag.
    await options.database.prepare(`UPDATE csv_worker_stages SET publish_pending=0
      WHERE id=? AND version=? AND publish_pending=1 AND status IN ('queued','partial','running') AND expires_at>?`)
      .bind(id, row.version, new Date().toISOString()).run()
  }
  const repair = async (): Promise<void> => {
    const now = new Date().toISOString()
    const rows = await options.database.prepare(`SELECT id,version,status,publish_pending
      FROM csv_worker_stages WHERE status IN ('queued','partial','running') AND expires_at>?
      AND (next_attempt_at IS NULL OR next_attempt_at<=?)
      AND (publish_pending=1 OR (status='running' AND lease_expires_at IS NOT NULL AND lease_expires_at<=?))
      ORDER BY coalesce(next_attempt_at,''),id LIMIT 10`).bind(now, now, now)
      .all<{ id: string; version: number; status: string; publish_pending: number }>()
    for (const row of rows.results) {
      if (row.publish_pending !== 1) {
        const recovered = await options.database.prepare(`UPDATE csv_worker_stages SET publish_pending=1,version=version+1
          WHERE id=? AND version=? AND status='running' AND lease_expires_at<=? AND expires_at>? RETURNING id`)
          .bind(row.id, row.version, now, now).first<{ id: string }>()
        if (!recovered) continue
      }
      await publish(row.id)
    }
  }
  const consume = async (batch: MessageBatch<unknown>): Promise<void> => {
    for (const message of batch.messages) {
      if (!messageBody(message.body)) { message.ack(); continue }
      try {
        const row = await read(message.body.stage_id)
        if (eligible(row, Date.now())) {
          await options.execute(row.id)
          await publish(row.id)
        }
        message.ack()
      } catch {
        const attempts = Number.isSafeInteger(message.attempts) ? Math.max(1, message.attempts) : 1
        message.retry({ delaySeconds: Math.min(300, 5 * 2 ** Math.min(6, attempts - 1)) })
      }
    }
  }
  return { publish, repair, consume }
}
