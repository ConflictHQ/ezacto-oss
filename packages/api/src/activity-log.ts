import type { Context } from 'hono'
import type { ApiContext } from './context.js'

/**
 * The API half of activity capture. Routes that do something the log has to
 * remember — granting a token, taking an export, restoring a bundle — call
 * `captureRequestActivity`, and the entry hands them a recorder backed by the
 * database writer. The port is here rather than an import of `@ezacto/db`
 * because this package does not depend on the database package, the same way
 * backup status and the outbox monitor are ports.
 *
 * The actor is taken from the request rather than passed in by the caller. A
 * handler that names its own actor can name the wrong one, and an audit row
 * that credits the wrong person is worse than no row: the export still left the
 * instance, and now the log says someone else took it.
 */

export type ActivityEventType =
  | 'auth.signed_in'
  | 'auth.signed_out'
  | 'api_token.created'
  | 'api_token.revoked'
  | 'backup.exported'
  | 'backup.restored'

export type ActivityActor =
  | { readonly type: 'user'; readonly id: number }
  | { readonly type: 'contact'; readonly id: number }
  | { readonly type: 'system' }

export interface ActivityCaptureRequest {
  readonly eventType: ActivityEventType
  readonly subjectId: number
  readonly actor: ActivityActor
  readonly occurredAt: string
  readonly captureId: string
  readonly detail?: Readonly<Record<string, unknown>>
}

export interface ActivityRecorder {
  capture(request: ActivityCaptureRequest): Promise<void>
}

export interface RequestActivityEvent {
  readonly eventType: ActivityEventType
  readonly subjectId: number
  readonly occurredAt: string
  readonly detail?: Readonly<Record<string, unknown>>
}

/**
 * Records an event against the acting user, keyed by the request id so that a
 * client retry — or a Worker retrying the same request after a transient
 * failure downstream — records the event once rather than once per attempt.
 *
 * Failures propagate. The log is the only record that the thing happened, so a
 * route that could not write it has not finished, and a 5xx that makes the
 * caller retry is the honest outcome.
 */
export const captureRequestActivity = async <Bindings extends object>(
  context: Context<ApiContext<Bindings>>,
  recorder: ActivityRecorder,
  event: RequestActivityEvent,
): Promise<void> => {
  const principal = context.get('principal')
  await recorder.capture({
    ...event,
    actor: { type: 'user', id: principal.userId },
    captureId: context.get('requestId'),
  })
}
