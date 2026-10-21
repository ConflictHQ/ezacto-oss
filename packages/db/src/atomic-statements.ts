import type { InvoiceStateDatabase } from './invoice-state.js'
/** Each statement returns rows. SQLite's immediate transaction and D1 batch
 * both roll back the complete command if any invariant rejects a statement. */
export const atomicStatements = async (
  database: InvoiceStateDatabase,
  statements: readonly { text: string; params: readonly unknown[] }[],
): Promise<Record<string, unknown>[][]> => {
  const client = database.$client
  if ('batch' in client) {
    const results = await client.batch(
      statements.map((statement) => client.prepare(statement.text).bind(...statement.params)),
    )
    return results.map((result) => result.results as Record<string, unknown>[])
  }
  return client
    .transaction(() =>
      statements.map(
        (statement) =>
          client.prepare(statement.text).all(...statement.params) as Record<string, unknown>[],
      ),
    )
    .immediate()
}
