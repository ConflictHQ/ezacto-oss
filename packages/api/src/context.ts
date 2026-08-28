import type { Hono } from 'hono'

export type ApiContext<Bindings extends object = object> = {
  Bindings: Bindings
  Variables: {
    requestId: string
  }
}

export type AppInstaller<Bindings extends object> = (app: Hono<ApiContext<Bindings>>) => void
export type ApiInstaller<Bindings extends object> = (api: Hono<ApiContext<Bindings>>) => void

export interface CreateApiAppOptions<Bindings extends object> {
  /** Entry-owned routes such as health, identity, or static web mounting. */
  installApp?: AppInstaller<Bindings>
  /** Canonical resource routes mounted below `/api/v1`. */
  installApi?: ApiInstaller<Bindings>
}
