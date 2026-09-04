import { describe, expect, it } from 'vitest'
import { parseMcpCliOptions } from '../src/config.js'

describe('MCP CLI options', () => {
  it('accepts explicit config and organization selectors', () => {
    expect(
      parseMcpCliOptions([
        '--config',
        '/tmp/ezacto/config.json',
        '--org',
        'north-peak',
      ]),
    ).toEqual({
      configPath: '/tmp/ezacto/config.json',
      organization: 'north-peak',
      help: false,
    })
  })

  it.each([
    [['--unknown'], /unknown option/],
    [['--config'], /requires a value/],
    [['--org', '../escape'], /organization/],
    [['--org', 'one', '--org', 'two'], /only once/],
  ] as const)('rejects invalid arguments: %j', (args, message) => {
    expect(() => parseMcpCliOptions(args)).toThrow(message)
  })
})
