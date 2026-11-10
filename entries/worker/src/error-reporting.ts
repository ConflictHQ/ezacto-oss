import type { WorkerManagedQuickBooks, WorkerManagedWise, WorkerManagedBill } from './managed-providers.js'
import * as Sentry from '@sentry/cloudflare'
import { ApiError } from '@ezacto/api'
import { BillApiError, BillAuthError } from '@ezacto/integrations'
import type { ErrorEvent, Event, EventHint, StackFrame } from '@sentry/cloudflare'

/** Static application operations only: never a URL, provider response or input. */
export const workerScheduledOperations = [
  'scheduled tick', 'webhook sweep', 'webhook purge', 'payment run sweep',
  'budget alert evaluation', 'time reminders', 'automatic approval sweep',
  'off-site backup checkpoint', 'scheduled job proposal sweep',
  'Stripe alert notice', 'scheduled manifest notice', 'scheduled run dispatch', 'scheduled run expiry',
  'nightly export', 'temporary backup cleanup', 'recurring invoice generation', 'payment reminders',
  'calendar sync', 'GitHub issue reconciliation', 'BILL reconciliation', 'QuickBooks catch-up', 'QuickBooks accounting write recovery', 'Deel time sync', 'Deel payment status',
  'demo maintenance', 'demo sender seed', 'outbox drain',
] as const
export type WorkerScheduledOperation = (typeof workerScheduledOperations)[number]
type WorkerFailureCode = 'd1_network_lost' | 'd1_overloaded' | 'd1_timeout' | 'd1_resource_limit' | 'worker_request_limit' | 'database_query_failed' | 'bill_http_401' | 'bill_http_403' | 'bill_http_429' | 'bill_http_4xx' | 'bill_http_5xx' | 'unknown'
const operations = new Set<unknown>(workerScheduledOperations)
const isScheduledOperation = (value: unknown): value is WorkerScheduledOperation => operations.has(value)

export type WorkerErrorPhase = 'api' | 'bootstrap' | 'readiness' | 'idempotency' | 'scheduled' | 'queue' | 'payment'
export interface WorkerErrorContext {
  readonly phase: WorkerErrorPhase
  readonly operation?: WorkerScheduledOperation
  readonly requestId?: string
  readonly traceId?: string
  readonly status?: number
}
/** Trusted, process-local integration port. Never serialize the original error. */
export type WorkerErrorReporter = (error: Error, context: WorkerErrorContext) => void | Promise<void>
export interface WorkerOptions {
  readonly reportError?: WorkerErrorReporter
  readonly managedQuickBooks?: WorkerManagedQuickBooks
  readonly managedWise?: WorkerManagedWise
  readonly managedBill?: WorkerManagedBill
}

const phases = new Set<unknown>(['api', 'bootstrap', 'readiness', 'idempotency', 'scheduled', 'queue', 'payment'])
const classes = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'AggregateError', 'ApiError'])
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
const hex = (value: unknown, length: number): value is string => typeof value === 'string' && value.length === length && /^[a-f0-9]+$/i.test(value)
const trusted = new WeakMap<object, { context: WorkerErrorContext; hasOriginalStack: boolean; failureCode: WorkerFailureCode }>()
const ownedFiles = ['entries/worker/src/index.ts', 'entries/worker/src/app.ts', 'entries/worker/src/runtime.ts', 'entries/worker/src/error-reporting.ts', 'packages/api/src/app.ts', 'packages/api/src/errors.ts', 'workflow-main.js', 'index.js', 'worker.js', 'script-0']

export const runtimeTraceId = (): string => crypto.randomUUID().replaceAll('-', '')
export const apiFailureStatus = (error: Error): number => error instanceof ApiError ? error.status : 500

const errorClass = (error: unknown): string => {
  try {
    if (!(error instanceof Error)) return 'Error'
    const name = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(error), 'constructor')?.value?.name
    return typeof name === 'string' && classes.has(name) ? name : 'Error'
  } catch { return 'Error' }
}
const ownValue = (value: object, key: PropertyKey): unknown => {
  try { return Object.getOwnPropertyDescriptor(value, key)?.value } catch { return undefined }
}
const isAggregate = (value: unknown): boolean => {
  try { return value instanceof AggregateError } catch { return false }
}
const isError = (value: unknown): value is Error => {
  try { return value instanceof Error } catch { return false }
}
const isArray = (value: unknown): value is unknown[] => {
  try { return Array.isArray(value) } catch { return false }
}
/** Inspect at most eight distinct objects; never iterate caller-owned arrays. */
const errorObjects = (error: unknown): readonly object[] => {
  const objects: object[] = []
  const visit = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || objects.includes(value) || objects.length >= 8) return
    objects.push(value)
    // Follow the initiating branch before cleanup siblings, including nested
    // aggregates. A cleanup stack must not replace the original failure site.
    visit(ownValue(value, 'cause'))
    if (isAggregate(value)) {
      const children = ownValue(value, 'errors')
      if (isArray(children)) {
        const length = ownValue(children, 'length')
        if (typeof length === 'number' && Number.isSafeInteger(length) && length >= 0) {
          for (let index = 0; index < Math.min(length, 8); index++) visit(ownValue(children, String(index)))
        }
      }
    }
  }
  visit(error)
  return objects
}

/** A fixed status class only; provider messages, codes and bodies stay private. */
export const billFailureCode = (error: unknown): WorkerFailureCode => {
  for (const current of errorObjects(error)) {
    let isBill = false
    try { isBill = current instanceof BillApiError || current instanceof BillAuthError } catch { continue }
    if (!isBill) continue
    const status = ownValue(current, 'status')
    if (status === 401) return 'bill_http_401'
    if (status === 403) return 'bill_http_403'
    if (status === 429) return 'bill_http_429'
    if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 499) return 'bill_http_4xx'
    if (typeof status === 'number' && Number.isInteger(status) && status >= 500 && status <= 599) return 'bill_http_5xx'
  }
  return 'unknown'
}

const failureCode = (error: unknown, context?: WorkerErrorContext): WorkerFailureCode => {
  if (context?.phase === 'scheduled' && context.operation === 'BILL reconciliation') {
    const bill = billFailureCode(error)
    if (bill !== 'unknown') return bill
  }
  let databaseQuery = false
  for (const current of errorObjects(error)) {
    const message = ownValue(current, 'message')
    if (typeof message === 'string') {
      if (message.startsWith('D1_ERROR: Network connection lost')) return 'd1_network_lost'
      // Match platform prefixes only, never text embedded in SQL/parameters.
      // Static categories distinguish capacity failures from transport loss
      // without sending SQL, identifiers or provider messages to telemetry.
      // exec() embeds its statement in the wrapper/cause. Recognize only the
      // fixed readiness PRAGMA, never a platform phrase inside arbitrary SQL.
      if (/^D1_EXEC_ERROR: Error in line 1: PRAGMA foreign_keys ?= ?ON: D1 DB is overloaded\./u.test(message)) return 'd1_overloaded'
      if (message.startsWith('D1_ERROR: D1 DB is overloaded.')) return 'd1_overloaded'
      if (message.startsWith('D1_ERROR: D1 DB storage operation exceeded timeout')) return 'd1_timeout'
      if (message.startsWith("D1_ERROR: D1 DB's isolate exceeded its memory limit") ||
          message.startsWith('D1_ERROR: D1 DB exceeded its CPU time limit') ||
          message.startsWith('D1_ERROR: D1 query result exceeded the maximum response size limit')) return 'd1_resource_limit'
      if (message.startsWith('Too many API requests by single Worker invocation')) return 'worker_request_limit'
      if (message.startsWith('Failed query:')) databaseQuery = true
    }
  }
  return databaseQuery ? 'database_query_failed' : 'unknown'
}
const safeContext = (context: WorkerErrorContext): WorkerErrorContext => ({
  phase: phases.has(context.phase) ? context.phase : 'bootstrap',
  ...(isScheduledOperation(context.operation) ? { operation: context.operation } : {}),
  ...(uuid(context.requestId) ? { requestId: context.requestId } : {}),
  ...(hex(context.traceId, 32) ? { traceId: context.traceId } : {}),
  ...(Number.isInteger(context.status) && context.status! >= 500 && context.status! <= 599 ? { status: context.status } : {}),
})

/** Each capture owns its metadata; reusing an Error across concurrent requests cannot mix traces. */
export const captureWorkerError: WorkerErrorReporter = (error, context) => {
  if (error instanceof ApiError && error.status < 500) return
  const safe = new Error('eZacto runtime failure')
  safe.name = errorClass(error)
  safe.stack = ''
  let hasOriginalStack = false
  // Multiple failures retain the initiating error before cleanup errors. Use
  // its positions, rather than the AggregateError constructor's catch site.
  const sources = isAggregate(error) ? errorObjects(error).filter(value => isError(value) && !isAggregate(value)) : [error]
  for (const source of sources) {
    // V8 may expose Error.stack through a lazy accessor. Preserve the existing
    // one guarded read, while never invoking cause/children accessors above.
    try {
      const stack: unknown = (source as Error).stack
      if (typeof stack === 'string' && stack.length > 0) { safe.stack = stack; hasOriginalStack = true; break }
    } catch { /* Optional positions only. */ }
  }
  trusted.set(safe, { context: safeContext(context), hasOriginalStack, failureCode: failureCode(error, context) })
  Sentry.captureException(safe)
}

/** Reporter faults, including rejected promises, never alter an HTTP response or retry decision. */
export const reportWorkerError = (
  reporter: WorkerErrorReporter | undefined,
  error: unknown,
  context: WorkerErrorContext,
  waitUntil?: (promise: Promise<unknown>) => void,
): void => {
  try {
    const failure = error instanceof Error ? error : new Error('eZacto runtime failure')
    if (!(error instanceof Error)) failure.stack = ''
    if (failure instanceof ApiError && failure.status < 500) return
    const result = (reporter ?? captureWorkerError)(failure, safeContext(context))
    if (result !== undefined) {
      const pending = Promise.resolve(result).catch(() => undefined)
      try { waitUntil?.(pending) } catch { /* The rejection is already observed. */ }
    }
  } catch { /* Reporting is never the application's failure. */ }
}

const frame = (source: StackFrame): StackFrame | undefined => {
  const path = typeof source.filename === 'string' ? source.filename.split(/[?#]/, 1)[0] : ''
  const filename = ownedFiles.find(file => path === file || path.endsWith('/' + file))
  if (!filename || !Number.isSafeInteger(source.lineno) || source.lineno! <= 0 || source.lineno! > 20_000_000) return undefined
  // The leading slash is required for Sentry's ~/artifact.js release lookup.
  return { filename, abs_path: '/' + filename, lineno: source.lineno,
    ...(Number.isSafeInteger(source.colno) && source.colno! > 0 && source.colno! <= 20_000_000 ? { colno: source.colno } : {}), in_app: true }
}

/** Rebuild rather than delete: SDK integrations and arbitrary scopes cannot add private data. */
export const scrubWorkerEvent = (event: Event, hint: EventHint): ErrorEvent | null => {
  try {
    const original = hint.originalException
    if (original instanceof ApiError && original.status < 500) return null
    const capture = typeof original === 'object' && original !== null ? trusted.get(original) : undefined
    const metadata = capture?.context
    const traceId = metadata?.traceId ?? runtimeTraceId()
    const tags: Record<string, string> = { surface: 'ezacto-core', phase: metadata?.phase ?? 'uncaught', runtime_trace_id: traceId, failure_code: capture?.failureCode ?? failureCode(original) }
    if (metadata?.operation) tags.operation = metadata.operation
    if (metadata?.requestId) tags.request_id = metadata.requestId
    if (metadata?.status) tags.http_status = String(metadata.status)
    const values = (event.exception?.values ?? []).slice(-5).map(value => {
      const frames = ((capture ? capture.hasOriginalStack : original instanceof Error) ? value.stacktrace?.frames ?? [] : []).map(frame).filter((value): value is StackFrame => value !== undefined).slice(-30)
      return { type: typeof value.type === 'string' && classes.has(value.type) ? value.type : 'Error', value: 'eZacto runtime failure',
        ...(frames.length ? { stacktrace: { frames } } : {}), mechanism: { type: 'generic', handled: value.mechanism?.handled !== false } }
    })
    return {
      ...(hex(event.event_id, 32) ? { event_id: event.event_id } : {}),
      ...(typeof event.timestamp === 'number' && Number.isFinite(event.timestamp) ? { timestamp: event.timestamp } : {}),
      type: undefined, platform: 'javascript', level: event.level && ['fatal', 'error', 'warning', 'log', 'info', 'debug'].includes(event.level) ? event.level : 'error',
      ...(typeof event.release === 'string' && /^[a-f0-9]{40}$/i.test(event.release) ? { release: event.release } : {}),
      ...(typeof event.environment === 'string' ? { environment: ['dev', 'prod', 'test', 'synthetic-verification'].includes(event.environment) ? event.environment : 'custom' } : {}),
      tags, contexts: { trace: { trace_id: traceId, span_id: runtimeTraceId().slice(0, 16), op: 'ezacto.runtime' } },
      exception: { values: values.length ? values : [{ type: 'Error', value: 'eZacto runtime failure' }] },
    }
  } catch { return null }
}
