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

/**
 * The session identity resolved while rendering the app shell, in the shape
 * `GET /api/v1/whoami` returns. Set by the entry's shell middleware so the
 * document can carry it, letting the browser skip the whoami round-trip.
 */
export interface ShellIdentity {
  user_id: number
  profile: string
  manager_grants: string[]
  authentication: { kind: 'session' }
}

export type ApiContext<Bindings extends object = object> = {
  Bindings: Bindings
  Variables: {
    requestId: string
    principal: UserPrincipal
    shellIdentity: ShellIdentity
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
}
