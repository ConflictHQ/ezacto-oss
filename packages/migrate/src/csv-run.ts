import { readFile } from 'node:fs/promises'
import { applyCsvImport, dryRunCsvImport, type CsvImportReport } from './csv-import.js'
import { togglAdapter } from './csv-toggl.js'
import { parseMapping, type CsvMapping } from './csv-mapping.js'

export interface RunCsvImportOptions {
  databasePath: string
  filePath: string
  mappingPath?: string
  sourceId: string
  /** The vendor whose export the file is; omitted for the generic contract. */
  format?: 'toggl'
  dryRun: boolean
  skipRejected: boolean
  signal?: AbortSignal
}

const MAX_LISTED = 50

export const formatCsvReport = (report: CsvImportReport): string => {
  const lines: string[] = []
  const tally = (label: string, t: { matched: number; new: number; rejected: number }) =>
    lines.push(`${label.padEnd(9)} ${t.matched} matched, ${t.new} new, ${t.rejected} rejected`)
  lines.push(
    `source ${report.sourceId}; file sha256 ${report.file.sha256 || '(not read)'}; ${report.file.bytes} byte(s)`,
  )
  for (const error of report.fileErrors) {
    lines.push(
      `file error ${error.code}${error.line > 0 ? ` (line ${error.line})` : ''}: ${error.message}`,
    )
  }
  if (report.fileErrors.length === 0) {
    lines.push(
      `entries: ${report.entries.total} row(s): ${report.entries.new} to write, ` +
        `${report.entries.alreadyImported} already imported, ${report.entries.rejected} rejected`,
    )
    tally('people', report.people)
    tally('clients', report.clients)
    tally('projects', report.projects)
    tally('tasks', report.tasks)
    lines.push(
      `assignments to create: ${report.assignments.userProject} person-project, ` +
        `${report.assignments.projectTask} project-task`,
    )
    for (const issue of report.rejected.slice(0, MAX_LISTED)) {
      lines.push(`line ${issue.line}: ${issue.category} ${issue.code}: ${issue.message}`)
    }
    if (report.rejected.length > MAX_LISTED) {
      lines.push(`... and ${report.rejected.length - MAX_LISTED} more rejection(s)`)
    }
    for (const issue of report.warnings.slice(0, MAX_LISTED)) {
      lines.push(`line ${issue.line}: warning ${issue.code}: ${issue.message}`)
    }
    if (report.warnings.length > MAX_LISTED) {
      lines.push(`... and ${report.warnings.length - MAX_LISTED} more warning(s)`)
    }
  }
  return lines.join('\n')
}

/**
 * `ezacto-migrate import-csv`. A dry run opens the database without migrating
 * it and rolls back whatever planning touched, so it changes nothing; an apply
 * migrates first, like `load`, then writes.
 */
export const runCsvImport = async (
  options: RunCsvImportOptions,
): Promise<{ text: string; exitCode: number }> => {
  const [{ default: BetterSqlite3 }, db] = await Promise.all([
    import('better-sqlite3'),
    import('@ezacto/db'),
  ])
  const bytes = await readFile(options.filePath)
  const mapping: CsvMapping | undefined =
    options.mappingPath === undefined
      ? undefined
      : parseMapping(await readFile(options.mappingPath, 'utf8'))
  const sqlite = new BetterSqlite3(options.databasePath, { fileMustExist: true })
  try {
    const input = {
      sourceId: options.sourceId,
      ...(mapping !== undefined ? { mapping } : {}),
      ...(options.format === 'toggl' ? { adapter: togglAdapter } : {}),
    }
    if (options.dryRun) {
      const report = await dryRunCsvImport(sqlite, bytes, input)
      const clean = report.fileErrors.length === 0 && report.rejected.length === 0
      return {
        text: `${formatCsvReport(report)}\ndry run: nothing written`,
        exitCode: clean ? 0 : 1,
      }
    }
    db.migrateContainer(sqlite)
    const result = await applyCsvImport(sqlite, bytes, {
      ...input,
      skipRejected: options.skipRejected,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    })
    const lines = [formatCsvReport(result.report)]
    if (result.status === 'refused') lines.push(`refused, nothing written: ${result.reason ?? ''}`)
    else {
      lines.push(
        `${result.status}: ${result.created} entr${result.created === 1 ? 'y' : 'ies'} written, ` +
          `${result.alreadyImported} already imported, ${result.rejected} rejected`,
      )
      if (result.error !== undefined)
        lines.push(`stopped on error: ${result.error}; run again to finish the rest`)
      if (result.status === 'aborted') {
        lines.push(
          'aborted: further rows were not read; entries already written stay (this is not a rollback)',
        )
      }
    }
    return { text: lines.join('\n'), exitCode: result.status === 'complete' ? 0 : 1 }
  } finally {
    sqlite.close()
  }
}
