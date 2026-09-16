import type { Server } from 'node:http'
import {
  serve,
  type Http2Bindings,
  type HttpBindings,
} from '@hono/node-server'
import { createApp } from '../../worker/src/app.js'
import { readContainerConfig, type ContainerConfig } from './config.js'
import { createContainerRuntime } from './runtime.js'

const externalRequest = (
  request: Request,
  bindings: HttpBindings | Http2Bindings,
  config: ContainerConfig,
): Request => {
  const url = new URL(request.url)
  const publicOrigin = new URL(config.appBaseUrl)
  url.protocol = publicOrigin.protocol
  url.host = publicOrigin.host
  const external = new Request(url, request)
  external.headers.delete('cf-connecting-ip')
  external.headers.set(
    'cf-connecting-ip',
    bindings.incoming.socket.remoteAddress ?? 'unknown-client',
  )
  return external
}

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)))
    server.closeIdleConnections()
  })

const shutdownBudgetMs = 25_000
const requestDrainMs = 5_000

const main = async (): Promise<void> => {
  process.umask(0o077)
  const config = readContainerConfig(process.env)
  const runtime = await createContainerRuntime(config)
  const app = createApp(runtime.services, runtime.brandAssets, runtime.instanceTheme)
  const server = serve({
    fetch: (request, bindings) =>
      app.fetch(externalRequest(request, bindings, config), config.appEnv),
    hostname: config.host,
    port: config.port,
  }) as Server

  let shuttingDown: Promise<void> | undefined
  const shutdown = (signal: NodeJS.Signals): Promise<void> => {
    shuttingDown ??= (async () => {
      console.log(`received ${signal}; draining requests and email jobs`)
      const deadline = Date.now() + shutdownBudgetMs
      const force = setTimeout(() => {
        server.closeAllConnections()
        process.exitCode = 1
      }, shutdownBudgetMs)
      force.unref()
      const closeRequests = setTimeout(
        () => server.closeAllConnections(),
        requestDrainMs,
      )
      closeRequests.unref()
      try {
        await closeServer(server)
        await runtime.close(Math.max(1, deadline - Date.now()))
      } finally {
        clearTimeout(closeRequests)
        clearTimeout(force)
      }
    })()
    return shuttingDown
  }

  const handleSignal = (signal: NodeJS.Signals): void => {
    void shutdown(signal).catch((error: unknown) => {
      const name = error instanceof Error ? error.name : 'UnknownError'
      console.error(`ezacto container shutdown failed: ${name}`)
      server.closeAllConnections()
      process.exitCode = 1
    })
  }
  process.once('SIGINT', () => handleSignal('SIGINT'))
  process.once('SIGTERM', () => handleSignal('SIGTERM'))
  console.log(
    `ezacto container ${config.appEnv.RELEASE} listening on ${config.host}:${config.port}`,
  )
}

/**
 * What a startup failure is allowed to say.
 *
 * Name alone told an operator nothing -- `ezacto container startup failed:
 * Error` is the whole of it, and diagnosing that meant unpacking the image. But
 * printing the message blindly is not safe either: `SMTP_URL` carries a
 * password, and a library error that quotes the URL would write that password
 * into the logs.
 *
 * So: the configuration validators in `config.ts` raise `TypeError` with
 * value-free text -- they name the variable, never its contents -- and those
 * are surfaced whole, because misconfiguration is the overwhelmingly common
 * failure and the message is the fix. Anything else is surfaced with credential
 * material stripped.
 */
const startupDetail = (error: unknown): string => {
  if (!(error instanceof Error)) return 'UnknownError'
  if (error instanceof TypeError) return `TypeError: ${error.message}`
  // scheme://user:password@host -> scheme://***@host
  const scrubbed = error.message.replace(
    /([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi,
    '$1***@',
  )
  return `${error.name}: ${scrubbed}`
}

main().catch((error: unknown) => {
  console.error(`ezacto container startup failed: ${startupDetail(error)}`)
  process.exitCode = 1
})
