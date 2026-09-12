import { EzactoClient } from '@conflict-hq/ezacto-client'
import {
  assertOrganizationName,
  readConfig,
  resolveConfigPath,
  selectOrganization,
} from '@conflict-hq/ezacto-cli'

export interface McpCliOptions {
  configPath?: string
  organization?: string
  help: boolean
}

export const MCP_HELP = `Usage: ezacto-mcp [--config PATH] [--org NAME]

Runs the read-only ezacto MCP server over stdio using the token stored by ez login.

Options:
  --config PATH  Read a specific ezacto CLI config file
  --org NAME     Select a configured organization
  -h, --help     Show this help
`

export const parseMcpCliOptions = (args: readonly string[]): McpCliOptions => {
  let configPath: string | undefined
  let organization: string | undefined
  let help = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!
    if (argument === '-h' || argument === '--help') {
      help = true
      continue
    }
    if (argument !== '--config' && argument !== '--org') {
      throw new Error(`unknown option: ${argument}`)
    }
    const value = args[index + 1]
    if (value === undefined || value.startsWith('-')) {
      throw new Error(`${argument} requires a value`)
    }
    index += 1
    if (argument === '--config') {
      if (configPath !== undefined) throw new Error('--config may be specified only once')
      configPath = value
    } else {
      if (organization !== undefined) throw new Error('--org may be specified only once')
      organization = assertOrganizationName(value)
    }
  }
  return {
    ...(configPath === undefined ? {} : { configPath }),
    ...(organization === undefined ? {} : { organization }),
    help,
  }
}

export const loadEzactoMcpClient = async (
  options: Readonly<McpCliOptions>,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<EzactoClient> => {
  const configPath = resolveConfigPath(
    options.configPath === undefined
      ? environment
      : { ...environment, EZACTO_CONFIG: options.configPath },
  )
  const config = await readConfig(configPath)
  if (config === null) {
    throw new Error('ezacto is not configured; run ez login with a scoped API token')
  }
  const selected = selectOrganization(config, options.organization)
  return new EzactoClient({
    baseUrl: selected.organization.base_url,
    token: selected.organization.token,
  })
}
