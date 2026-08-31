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
  const app = createApp(runtime.services)
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

main().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : 'UnknownError'
  console.error(`ezacto container startup failed: ${name}`)
  process.exitCode = 1
})
