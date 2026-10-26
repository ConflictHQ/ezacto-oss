import {
  GithubReadClient,
  GithubReadError,
  GithubHttpError,
  GithubReaderCommandError,
  GithubStoreFencedError,
  receiveGithubWebhook,
  reconcileGithubPage,
  verifyGithubDelivery,
} from '@ezacto/integrations'
import { createGithubAppSetup } from './github-app-setup.js'
import { NativeGithubReadStore } from './github-read.js'
import { NativeGithubReaderAdmin, type GithubReaderAuthority } from './github-reader-admin.js'
import { NativeGithubReaderWork } from './github-reader-work.js'
import type { InvoiceStateDatabase } from './invoice-state.js'

export interface GithubAppCredentials {
  appId: string
  privateKey: string
  webhookSecret: string
}
export interface GithubReaderServiceOptions {
  credentials(): Promise<GithubAppCredentials | null>
  fetch(request: Request): Promise<Response>
  now(): Date
  setup?: { key: string | undefined; origin: string }
}

/** Per-instance App credentials and repository bindings only; no sign-in tokens. */
export const createGithubReaderService = (
  database: InvoiceStateDatabase,
  options: GithubReaderServiceOptions,
) => {
  const admin = new NativeGithubReaderAdmin(database)
  const work = new NativeGithubReaderWork(database)
  const setup = options.setup
    ? createGithubAppSetup(database, { ...options.setup, now: options.now, fetch: options.fetch })
    : undefined
  const credentialsFor = async () =>
    (await options.credentials()) ?? (await setup?.credentials()) ?? null
  const clock = () => options.now().toISOString()
  const client = (credentials: GithubAppCredentials) =>
    new GithubReadClient({
      appId: credentials.appId,
      privateKey: credentials.privateKey,
      fetch: options.fetch,
      now: () => options.now().getTime(),
    })
  const requireCredentials = async () => {
    const value = await credentialsFor()
    if (!value) throw new GithubReaderCommandError('unavailable')
    return value
  }
  return {
    async installations(authority: GithubReaderAuthority, page: number) {
      await admin.status(authority, clock())
      try {
        return await client(await requireCredentials()).installations(page)
      } catch (error) {
        if (error instanceof GithubReadError || error instanceof GithubHttpError)
          throw new GithubReaderCommandError('unavailable')
        throw error
      }
    },
    async repositories(authority: GithubReaderAuthority, installationId: string, page: number) {
      await admin.status(authority, clock())
      try {
        return await client(await requireCredentials()).repositories(installationId, page)
      } catch (error) {
        if (error instanceof GithubReadError || error instanceof GithubHttpError)
          throw new GithubReaderCommandError('unavailable')
        throw error
      }
    },
    async beginSetup(authority: GithubReaderAuthority, organization?: string) {
      if (!setup || (await options.credentials())) throw new GithubReaderCommandError('unavailable')
      return setup.begin(authority, organization)
    },
    async completeSetup(authority: GithubReaderAuthority, state: string, code: string) {
      if (!setup || (await options.credentials())) throw new GithubReaderCommandError('unavailable')
      return setup.complete(authority, state, code)
    },
    isConfigured: async () => (await credentialsFor()) !== null,
    async status(authority: GithubReaderAuthority) {
      const connections = await admin.status(authority, clock())
      const configured = (await credentialsFor()) !== null
      return {
        configured,
        setup_supported: (await setup?.supported()) ?? false,
        app: (await setup?.info()) ?? null,
        available: configured,
        owned_acceptance_required: true as const,
        connections,
      }
    },
    async map(
      authority: GithubReaderAuthority,
      input: {
        command_id: string
        expected_generation: number
        installation_id: string
        repository_id: string
        project_id: number
        task_id: number
      },
    ) {
      // Authenticate before even minting an installation token.
      await admin.status(authority, clock())
      const credentials = await requireCredentials()
      try {
        const api = client(credentials)
        const installation = await api.installation(input.installation_id)
        const repository = await api.repository(input.installation_id, input.repository_id)
        if (installation.accountId !== repository.accountId)
          throw new GithubReaderCommandError('invalid')
        const result = await admin.map(
          authority,
          {
            commandId: input.command_id,
            expectedGeneration: input.expected_generation,
            verified: {
              appId: credentials.appId,
              installationId: input.installation_id,
              accountId: installation.accountId,
              repositoryId: repository.repositoryId,
              fullName: repository.fullName,
              projectId: input.project_id,
              taskId: input.task_id,
            },
          },
          clock(),
        )
        return { connection_id: result.connectionId, generation: result.generation }
      } catch (error) {
        if (error instanceof GithubReadError || error instanceof GithubHttpError)
          throw new GithubReaderCommandError('unavailable')
        throw error
      }
    },
    async disconnect(
      authority: GithubReaderAuthority,
      input: { command_id: string; expected_generation: number; connection_id: string },
    ) {
      return admin.disconnect(
        authority,
        {
          commandId: input.command_id,
          expectedGeneration: input.expected_generation,
          connectionId: input.connection_id,
        },
        clock(),
      )
    },
    async reconcile(authority: GithubReaderAuthority) {
      await admin.requestReconcile(authority, clock())
    },
    linkedItem: (actor: { userId: number; profile: string }, linkId: number) =>
      admin.linkedItem(actor, linkId),
    async tick(): Promise<void> {
      const credentials = await credentialsFor()
      if (!credentials) return
      const lease = await work.claim(options.now().getTime())
      if (!lease) return
      const binding = await admin.binding(lease.connectionId)
      if (
        !binding ||
        binding.generation !== lease.generation ||
        binding.appId !== credentials.appId
      )
        return
      const repository = binding.repositories.find(
        (item) => item.repositoryId === lease.repositoryId,
      )
      if (!repository) return
      try {
        const outcome = await reconcileGithubPage({
          binding,
          repository,
          store: new NativeGithubReadStore(database, binding),
          client: client(credentials),
          now: options.now().getTime(),
          attempt: lease.attempt,
        })
        await work.finish(
          lease,
          options.now().getTime(),
          outcome,
          outcome === 'deferred'
            ? 'rate_limited'
            : outcome === 'revoked'
              ? 'invalid_credentials'
              : outcome === 'unavailable'
                ? 'lost_scope'
                : null,
        )
      } catch (error) {
        if (error instanceof GithubStoreFencedError) return
        const code = error instanceof GithubReadError ? error.code : 'transport_unavailable'
        await work.finish(
          lease,
          options.now().getTime(),
          'unavailable',
          code === 'response_too_large' || code === 'invalid_configuration'
            ? 'invalid_response'
            : code,
        )
      }
    },
    async receive(
      body: Uint8Array<ArrayBuffer>,
      headers: { signature: string | null; event: string; deliveryId: string },
    ) {
      const credentials = await credentialsFor()
      if (!credentials) return 'ignored' as const
      const verdict = await verifyGithubDelivery(credentials.webhookSecret, {
        body,
        headers: {
          'x-hub-signature-256': headers.signature ?? undefined,
          'x-github-event': headers.event,
          'x-github-delivery': headers.deliveryId,
        },
      })
      if (!verdict.verified)
        return verdict.reason === 'too_large'
          ? ('body_too_large' as const)
          : ('invalid_signature' as const)
      let payload: unknown
      try {
        payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
      } catch {
        return 'invalid_payload' as const
      }
      const installation = (payload as { installation?: { id?: unknown } } | null)?.installation?.id
      if (!Number.isSafeInteger(installation) || Number(installation) < 1)
        return 'invalid_payload' as const
      const binding = await admin.installationBinding(credentials.appId, String(installation))
      if (!binding) return 'foreign_installation' as const
      try {
        return await receiveGithubWebhook({
          binding,
          store: new NativeGithubReadStore(database, binding),
          secret: credentials.webhookSecret,
          body,
          signature: headers.signature,
          event: headers.event,
          deliveryId: headers.deliveryId,
        })
      } catch (error) {
        if (error instanceof GithubStoreFencedError) return 'ignored' as const
        throw error
      }
    },
  }
}
