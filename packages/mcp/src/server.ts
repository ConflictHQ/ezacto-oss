import { McpServer } from '@modelcontextprotocol/server'
import type { EzactoReadClient } from './tools.js'
import { installEzactoReadTools } from './tools.js'

export const createEzactoMcpServer = (client: EzactoReadClient): McpServer => {
  const server = new McpServer(
    { name: 'ezacto', version: '0.0.0' },
    {
      instructions:
        'Use these read-only tools to inspect ezacto. All access, scopes, and field redaction come from the configured token user. Client means the billable party. Exact client/project names, codes, and IDs are accepted; ambiguous names must be clarified. Omitted report dates mean all dates.',
    },
  )
  installEzactoReadTools(server, client)
  return server
}
