#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { MCP_HELP, loadEzactoMcpClient, parseMcpCliOptions } from './config.js'
import { createEzactoMcpServer } from './server.js'

const main = async (): Promise<void> => {
  const options = parseMcpCliOptions(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(MCP_HELP)
    return
  }
  const client = await loadEzactoMcpClient(options)
  const handle = serveStdio(() => createEzactoMcpServer(client))
  const close = (): void => {
    void handle.close()
  }
  process.once('SIGINT', close)
  process.once('SIGTERM', close)
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown startup error'
  process.stderr.write(`ezacto-mcp: ${message}\n`)
  process.exitCode = 1
})
