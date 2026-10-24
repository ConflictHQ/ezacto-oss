import { describe, expect, it } from 'vitest'
import {
  AGENT_NOT_AVAILABLE,
  AGENT_RESULT_TRUNCATED,
  AGENT_TOOL_FAILED,
  AGENT_TOOL_TIMED_OUT,
  AgentToolRegistryError,
  assertReadOnlyAgentTools,
  runAgentTurn,
  type AgentModel,
  type AgentModelStep,
  type AgentToolExecutor,
  type AgentToolResult,
  type AgentToolSpec,
} from '../src/agent.js'

const spec = (name: string): AgentToolSpec => ({
  name,
  description: name,
  inputSchema: {},
  readOnly: true,
})

const scriptedModel = (steps: AgentModelStep[]): AgentModel & { seen: string[][] } => {
  const seen: string[][] = []
  let index = 0
  return {
    seen,
    next: async ({ messages }) => {
      seen.push(messages.filter((m) => m.role === 'tool').map((m) => m.content))
      const step = steps[Math.min(index, steps.length - 1)]
      index += 1
      return step as AgentModelStep
    },
  }
}

const executor = (
  respond: (name: string) => Promise<AgentToolResult> | AgentToolResult,
  names = ['list_projects'],
): AgentToolExecutor & { calls: string[] } => {
  const calls: string[] = []
  return {
    calls,
    tools: names.map(spec),
    call: async (name) => {
      calls.push(name)
      return respond(name)
    },
  }
}

const ask = [{ role: 'user' as const, content: 'q' }]
const callStep = (name: string, id = 'c1'): AgentModelStep => ({
  kind: 'tool_calls',
  calls: [{ id, name, arguments: {} }],
})

describe('runAgentTurn', () => {
  it('runs a question, tool call, answer round trip and reports audit-safe metadata', async () => {
    const model = scriptedModel([callStep('list_projects'), { kind: 'answer', text: 'done' }])
    const tools = executor(() => ({ ok: true, content: '[]' }))
    const result = await runAgentTurn({ model, executor: tools, messages: ask })
    expect(result).toEqual({
      stop: 'answered',
      answer: 'done',
      toolsUsed: ['list_projects'],
      toolCallCount: 1,
    })
    expect(model.seen[1]).toEqual(['[]'])
  })

  it('shows 403 and 404 identically as not available, with no reason', async () => {
    const out: string[] = []
    for (const status of [403, 404]) {
      const model = scriptedModel([callStep('list_projects'), { kind: 'answer', text: 'x' }])
      await runAgentTurn({
        model,
        executor: executor(() => ({ ok: false, status })),
        messages: ask,
      })
      out.push(...(model.seen[1] as string[]))
    }
    expect(out).toEqual([AGENT_NOT_AVAILABLE, AGENT_NOT_AVAILABLE])
  })

  it('hides other failures, thrown errors and their text from the model', async () => {
    const model = scriptedModel([callStep('a', '1'), callStep('b', '2'), { kind: 'answer', text: 'x' }])
    const tools = executor(
      (name) => {
        if (name === 'b') throw new Error('secret db detail')
        return { ok: false, status: 500 }
      },
      ['a', 'b'],
    )
    await runAgentTurn({ model, executor: tools, messages: ask })
    expect(model.seen[2]).toEqual([AGENT_TOOL_FAILED, AGENT_TOOL_FAILED])
  })

  it('treats a tool the registry lacks as not available without calling out', async () => {
    const model = scriptedModel([callStep('delete_everything'), { kind: 'answer', text: 'x' }])
    const tools = executor(() => ({ ok: true, content: 'no' }))
    await runAgentTurn({ model, executor: tools, messages: ask })
    expect(tools.calls).toEqual([])
    expect(model.seen[1]).toEqual([AGENT_NOT_AVAILABLE])
  })

  it('times out a slow tool instead of hanging', async () => {
    const model = scriptedModel([callStep('list_projects'), { kind: 'answer', text: 'x' }])
    const tools = executor(() => new Promise(() => {}))
    await runAgentTurn({ model, executor: tools, messages: ask, limits: { callTimeoutMs: 5 } })
    expect(model.seen[1]).toEqual([AGENT_TOOL_TIMED_OUT])
  })

  it('caps result size', async () => {
    const model = scriptedModel([callStep('list_projects'), { kind: 'answer', text: 'x' }])
    const tools = executor(() => ({ ok: true, content: 'a'.repeat(50) }))
    await runAgentTurn({ model, executor: tools, messages: ask, limits: { maxResultChars: 10 } })
    expect(model.seen[1]).toEqual(['a'.repeat(10) + AGENT_RESULT_TRUNCATED])
  })

  it('stops at the tool-call cap before running the excess call', async () => {
    const model = scriptedModel([callStep('list_projects')])
    const tools = executor(() => ({ ok: true, content: '[]' }))
    const result = await runAgentTurn({
      model,
      executor: tools,
      messages: ask,
      limits: { maxToolCalls: 2, maxSteps: 10 },
    })
    expect(result.stop).toBe('max_tool_calls')
    expect(result.answer).toBeNull()
    expect(tools.calls).toHaveLength(2)
  })

  it('stops at the step cap when the model never answers', async () => {
    const model = scriptedModel([callStep('list_projects')])
    const result = await runAgentTurn({
      model,
      executor: executor(() => ({ ok: true, content: '[]' })),
      messages: ask,
      limits: { maxToolCalls: 100, maxSteps: 3 },
    })
    expect(result.stop).toBe('max_steps')
    expect(result.toolCallCount).toBe(3)
  })

  it('reports provider failure and hang as model_error with no detail', async () => {
    const failing: AgentModel = {
      next: async () => {
        throw new Error('sk-secret')
      },
    }
    const hanging: AgentModel = { next: () => new Promise(() => {}) }
    const tools = executor(() => ({ ok: true, content: '' }))
    for (const model of [failing, hanging]) {
      const result = await runAgentTurn({
        model,
        executor: tools,
        messages: ask,
        limits: { callTimeoutMs: 5 },
      })
      expect(result).toEqual({ stop: 'model_error', answer: null, toolsUsed: [], toolCallCount: 0 })
    }
  })
})

describe('assertReadOnlyAgentTools', () => {
  it('accepts read-only tools', () => {
    expect(() => assertReadOnlyAgentTools([spec('a'), spec('b')])).not.toThrow()
  })

  it('rejects a write-shaped tool and duplicates, and runAgentTurn enforces it', async () => {
    const writer = { ...spec('create_time_entry'), readOnly: false } as unknown as AgentToolSpec
    expect(() => assertReadOnlyAgentTools([writer])).toThrow(AgentToolRegistryError)
    expect(() => assertReadOnlyAgentTools([spec('a'), spec('a')])).toThrow(AgentToolRegistryError)
    const tools: AgentToolExecutor = { tools: [writer], call: async () => ({ ok: true, content: '' }) }
    await expect(
      runAgentTurn({ model: scriptedModel([{ kind: 'answer', text: 'x' }]), executor: tools, messages: ask }),
    ).rejects.toThrow(AgentToolRegistryError)
  })
})
