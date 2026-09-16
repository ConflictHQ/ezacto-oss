import type { Hono } from 'hono'
import type {
  ActingUserAuthority,
  UserProfile as CoreUserProfile,
} from '@ezacto/core'
import type { ApiAuthentication } from './auth.js'

export type UserProfile = CoreUserProfile

export type UserPrincipal = ActingUserAuthority & {
  type: 'user'
  userId: number
  authentication:
    | { kind: 'session'; sessionId: string }
    | { kind: 'token'; tokenId: number; scopes: string[] }
}

export type ApiContext<Bindings extends object = object> = {
  Bindings: Bindings
  Variables: {
    requestId: string
    principal: UserPrincipal
  }
}

export type AppInstaller<Bindings extends object> = (app: Hono<ApiContext<Bindings>>) => void
export type ApiInstaller<Bindings extends object> = (api: Hono<ApiContext<Bindings>>) => void

export interface CreateApiAppOptions<Bindings extends object> {
  /** Fail-closed API authentication. Without resolvers every /api/v1 request is 401. */
  authentication?: ApiAuthentication
  /** Entry-owned routes such as health, identity, or static web mounting. */
  installApp?: AppInstaller<Bindings>
  /** Canonical resource routes mounted below `/api/v1`. */
  installApi?: ApiInstaller<Bindings>
  /**
   * Told about every error the app answers with a 5xx (issue 807). The app
   * handles the exception itself, so a crash reporter wrapped around the entry
   * never sees it; this is how the Worker hands it to Sentry. Never given the
   * request or response body, only the error and the request id the client got.
   */
  reportError?: (error: Error, requestId: string) => void
}
