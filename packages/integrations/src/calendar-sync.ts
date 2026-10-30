import {
  CalendarAuthorizationError,
  CalendarConnectionError,
  CalendarSyncLimitError,
  calendarEventKey,
  calendarSyncWindow,
  createCalendarGrantVault,
  runCalendarSync,
  type CalendarConnectionAuthority,
  type CalendarConnectionStore,
  type CalendarCredentialIdentity,
  type CalendarOAuthGrant,
  type CalendarProvider,
  type CalendarSourceFactory,
  type CalendarSyncLease,
} from '@ezacto/core'

/** OAuth adapters are registered by the runtime only after provider acceptance.
 * No fake or token-paste source is included in this service. */
export const createCalendarSyncService = async (options: {
  store: CalendarConnectionStore
  deploymentKey: Uint8Array
  sources?: Readonly<Partial<Record<CalendarProvider, CalendarSourceFactory>>>
  retainRejectedGrant?: (
    grant: CalendarOAuthGrant,
    identity: CalendarCredentialIdentity,
  ) => Promise<void>
  now?: () => Date
}) => {
  const { store } = options,
    vault = await createCalendarGrantVault(options.deploymentKey)
  const now = () => (options.now?.() ?? new Date()).toISOString()
  const sources = options.sources ?? {}
  const available = () => Object.keys(sources) as CalendarProvider[]
  const refresh = async (
    userId: number,
    provider: CalendarProvider,
    signal?: AbortSignal,
    days?: { past?: number; future?: number },
  ) => {
    signal?.throwIfAborted()
    const factory = sources[provider]
    if (!factory) throw new CalendarConnectionError('not_configured')
    const held = await store.read(userId, provider)
    if (!held || held.state !== 'connected' || !held.sealedGrant)
      throw new CalendarConnectionError('not_connected')
    let lease: CalendarSyncLease | null = await store.claim(
      held,
      crypto.randomUUID(),
      now(),
      new Date(Date.parse(now()) + 60_000).toISOString(),
    )
    if (!lease) throw new CalendarConnectionError('busy')
    let opened = false,
      active = true
    const timeout = new AbortController()
    const abort = () => timeout.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const timer = setTimeout(abort, 30_000)
    const bounded = async <T>(work: () => Promise<T>): Promise<T> => {
      timeout.signal.throwIfAborted()
      return new Promise<T>((resolve, reject) => {
        const aborted = () => reject(new CalendarConnectionError('unavailable'))
        timeout.signal.addEventListener('abort', aborted, { once: true })
        Promise.resolve()
          .then(() => {
            timeout.signal.throwIfAborted()
            return work()
          })
          .then(resolve, reject)
          .finally(() => timeout.signal.removeEventListener('abort', aborted))
      })
    }
    try {
      const grant = await vault.openGrant(lease.sealedGrant!, lease)
      const cursor = lease.sealedCursor ? await vault.openCursor(lease.sealedCursor, lease) : null
      opened = true
      const at = now(),
        window = calendarSyncWindow(at, days)
      const existing = await store.snapshots(userId, provider, window)
      const source = await bounded(() =>
        factory({
          grant,
          ...(options.retainRejectedGrant
            ? {
                retainRejectedGrant: async (nextGrant: CalendarOAuthGrant) => {
                  if (!lease) throw new CalendarConnectionError('changed')
                  const random = crypto.getRandomValues(new Uint32Array(2))
                  await options.retainRejectedGrant!(nextGrant, {
                    ...lease,
                    credentialRevision: 4294967296 + (random[0]! % 65535) * 4294967296 + random[1]!,
                  })
                },
              }
            : {}),
          rotateGrant: async (nextGrant) => {
            const original = lease
            let attempted: { identity: CalendarCredentialIdentity; sealedGrant: string } | undefined
            try {
              if (!lease || !active || timeout.signal.aborted)
                throw new CalendarConnectionError('changed')
              const prior = lease
              const identity = { ...prior, credentialRevision: prior.credentialRevision + 1 }
              const [sealedGrant, sealedCursor] = await Promise.all([
                vault.sealGrant(nextGrant, identity),
                cursor ? vault.sealCursor(cursor, identity) : Promise.resolve(null),
              ])
              attempted = { identity, sealedGrant }
              if (!active || timeout.signal.aborted) throw new CalendarConnectionError('changed')
              lease = await store.rotate(
                prior,
                { keyId: vault.keyId, sealedGrant, sealedCursor },
                now(),
              )
            } catch (error) {
              // A write can commit even when its response is lost. Never revoke
              // the exact envelope that a fresh read proves is now installed.
              if (attempted) {
                let accepted = false
                try {
                  const held = await store.read(
                    attempted.identity.userId,
                    attempted.identity.provider,
                  )
                  accepted =
                    held?.state === 'connected' &&
                    held.instance === attempted.identity.instance &&
                    held.generation === attempted.identity.generation &&
                    held.credentialRevision === attempted.identity.credentialRevision &&
                    held.keyId === vault.keyId &&
                    held.sealedGrant === attempted.sealedGrant
                } catch {
                  /* Unproven custody remains a cleanup obligation. */
                }
                if (accepted) throw error
              }
              if (original && options.retainRejectedGrant) {
                const random = crypto.getRandomValues(new Uint32Array(2))
                await options.retainRejectedGrant(nextGrant, {
                  ...original,
                  credentialRevision: 4294967296 + (random[0]! % 65535) * 4294967296 + random[1]!,
                })
              }
              throw error
            }
          },
        }),
      )
      if (source.provider !== provider) throw new CalendarConnectionError('invalid')
      // Validate before the planner or any SQL: neither a malformed provider
      // response nor a repeated conflicting identity may advance the cursor.
      const seen = new Map<string, string>()
      const boundedSource = {
        provider,
        listEvents: async (request: Parameters<typeof source.listEvents>[0]) => {
          const page = await bounded(() =>
            source.listEvents({ ...request, signal: timeout.signal }),
          )
          if (
            !page ||
            !Array.isArray(page.events) ||
            page.events.length > 90 ||
            (page.nextPage !== null && typeof page.nextPage !== 'string') ||
            (page.nextCursor !== null && typeof page.nextCursor !== 'string') ||
            (page.nextPage?.length ?? 0) > 16384 ||
            (page.nextCursor?.length ?? 0) > 16384
          )
            throw new CalendarConnectionError('invalid')
          const unique = []
          for (const received of page.events) {
            const event = { ...received }
            if (
              !event ||
              typeof event.calendarId !== 'string' ||
              !event.calendarId ||
              event.calendarId.length > 1024 ||
              typeof event.eventId !== 'string' ||
              !event.eventId ||
              event.eventId.length > 1024 ||
              typeof event.occurrence !== 'string' ||
              event.occurrence.length > 64 ||
              typeof event.version !== 'string' ||
              !event.version ||
              event.version.length > 256 ||
              (event.summary !== null && typeof event.summary !== 'string') ||
              typeof event.cancelled !== 'boolean' ||
              typeof event.allDay !== 'boolean' ||
              !['accepted', 'tentative', 'declined', 'none', 'organizer'].includes(
                event.response,
              ) ||
              !['busy', 'free', 'oof'].includes(event.showAs)
            )
              throw new CalendarConnectionError('invalid')
            if (
              !event.cancelled &&
              !event.allDay &&
              (!Number.isFinite(Date.parse(event.startsAt)) ||
                !Number.isFinite(Date.parse(event.endsAt)))
            )
              throw new CalendarConnectionError('invalid')
            const key = calendarEventKey(event),
              serialized = JSON.stringify(event),
              prior = seen.get(key)
            if (prior && prior !== serialized) throw new CalendarConnectionError('invalid')
            if (!prior) unique.push(event)
            seen.set(key, serialized)
          }
          return {
            ...page,
            events: unique.flatMap((event) => {
              if (
                event.cancelled ||
                event.allDay ||
                (Date.parse(event.startsAt) >= Date.parse(window.from) &&
                  Date.parse(event.startsAt) < Date.parse(window.to))
              )
                return [event]
              return existing.has(calendarEventKey(event))
                ? [{ ...event, showAs: 'free' as const }]
                : []
            }),
          }
        },
      }
      const outcome = await runCalendarSync({
        source: boundedSource,
        now: at,
        // Provider cursors can be scoped to exact query bounds. Never reuse a
        // custom or rolling-window cursor for a different requested window.
        cursor: lease.window?.from === window.from && lease.window.to === window.to ? cursor : null,
        ...(days ? { days } : {}),
        existing,
        ...(signal ? { signal } : {}),
      })
      if (outcome.status === 'needs_reauth') {
        await store.fail(lease, 'authorization', now())
        return { state: 'needs_reauth' as const, applied: 0 }
      }
      signal?.throwIfAborted()
      const sealedCursor = outcome.cursor ? await vault.sealCursor(outcome.cursor, lease) : null
      timeout.signal.throwIfAborted()
      await store.commit(lease, { actions: outcome.actions, sealedCursor, window }, now())
      return { state: 'connected' as const, applied: outcome.actions.length }
    } catch (error) {
      const failure = !opened
        ? 'credential_unavailable'
        : error instanceof CalendarAuthorizationError
          ? 'authorization'
          : error instanceof CalendarSyncLimitError
            ? 'limit'
            : error instanceof CalendarConnectionError
              ? error.code === 'invalid'
                ? 'invalid_source'
                : error.code === 'changed'
                  ? 'changed'
                  : 'unavailable'
              : 'unavailable'
      try {
        await store.fail(lease, failure, now())
      } catch {
        /* A newer connection or erased owner always wins. */
      }
      if (!opened) throw new CalendarConnectionError('unavailable')
      if (error instanceof CalendarConnectionError || error instanceof CalendarSyncLimitError)
        throw error
      throw new CalendarConnectionError('unavailable')
    } finally {
      active = false
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }
  return {
    available,
    cleanupStatus: (authority: CalendarConnectionAuthority) =>
      store.cleanupStatus(authority, now()),
    async connections(authority: CalendarConnectionAuthority) {
      const values = await store.list(authority, now())
      const connected = await Promise.all(
        values.map(async (value) => {
          const held = await store.read(authority.userId, value.provider)
          return {
            ...value,
            state:
              value.state === 'connected' && held?.keyId !== vault.keyId
                ? ('needs_reauth' as const)
                : value.state,
            available: !!sources[value.provider],
          }
        }),
      )
      return [
        ...connected,
        ...available()
          .filter((provider) => !values.some((value) => value.provider === provider))
          .map((provider) => ({
            provider,
            state: 'disconnected' as const,
            generation: 0,
            lastSyncedAt: null,
            lastError: null,
            cleanupPending: false,
            syncing: false,
            available: true,
          })),
      ]
    },
    /** Called only by a verified, native-session-bound OAuth callback. */
    async completeOAuth(
      authority: CalendarConnectionAuthority,
      provider: CalendarProvider,
      expectedGeneration: number,
      grant: CalendarOAuthGrant,
    ) {
      await store.authorize(authority, now())
      const instance = await store.instance(),
        identity = {
          instance,
          userId: authority.userId,
          provider,
          generation: expectedGeneration + 1,
          credentialRevision: 1,
        }
      const sealedGrant = await vault.sealGrant(grant, identity)
      try {
        await store.connect(
          authority,
          provider,
          expectedGeneration,
          { instance, keyId: vault.keyId, sealedGrant },
          now(),
        )
      } catch (error) {
        let accepted = false
        try {
          const held = await store.read(authority.userId, provider)
          accepted =
            held?.state === 'connected' &&
            held.instance === instance &&
            held.generation === identity.generation &&
            held.credentialRevision === 1 &&
            held.keyId === vault.keyId &&
            held.sealedGrant === sealedGrant
        } catch {
          /* Unproven custody is retained by the authorization caller. */
        }
        if (!accepted) throw error
      }
    },
    async disconnect(
      authority: CalendarConnectionAuthority,
      provider: CalendarProvider,
      expectedGeneration: number,
    ) {
      const held = await store.read(authority.userId, provider)
      await store.disconnect(
        authority,
        provider,
        expectedGeneration,
        now(),
        !!held && (held.keyId !== vault.keyId || held.instance !== (await store.instance())),
      )
    },
    async refresh(
      authority: CalendarConnectionAuthority,
      provider: CalendarProvider,
      signal?: AbortSignal,
      days?: { past?: number; future?: number },
    ) {
      if (
        days &&
        [days.past ?? 14, days.future ?? 0].some(
          (value) => !Number.isInteger(value) || value < 0 || value > 90,
        )
      )
        throw new CalendarConnectionError('invalid')
      signal?.throwIfAborted()
      await store.authorize(authority, now())
      // The session admits this operation; the persistent OAuth connection
      // authorizes its execution. Logout denies subsequent refresh requests,
      // while disconnect, closure, and connection/lease fences cancel this one.
      return refresh(authority.userId, provider, signal, days)
    },
    /** Runtime-only admission through a previously consented, fenced connection. */
    refreshConnected: (userId: number, provider: CalendarProvider, signal?: AbortSignal) =>
      refresh(userId, provider, signal),
  }
}
export type CalendarSyncService = Awaited<ReturnType<typeof createCalendarSyncService>>
