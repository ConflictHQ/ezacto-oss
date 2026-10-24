// Contract for the in-app agent (issue 105, slice 1). Pure: the model and the
// tool executor are injected, so this file holds the invariants that any real
// provider adapter (slice 2) and tool binding must satisfy. See docs/agent.md.

export interface AgentToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  /** Literal `true`: write-shaped tools are not registered (waits on D12). */
  readOnly: true
}

export interface AgentToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export type AgentMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: AgentToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string }

export type AgentModelStep =
  | { kind: 'answer'; text: string }
  | { kind: 'tool_calls'; calls: AgentToolCall[] }

/** The provider seam. Adapters hold the key; this contract never sees it. */
export interface AgentModel {
  next(input: {
    messages: readonly AgentMessage[]
    tools: readonly AgentToolSpec[]
    signal: AbortSignal
  }): Promise<AgentModelStep>
}

/** `status` is the HTTP status the acting user's own API call returned. */
export type AgentToolResult =
  | { ok: true; content: string }
  | { ok: false; status: number }

/**
 * Executes tools as the acting user. Implementations must call `/api/v1` with
 * that user's own session or principal, never a service token, so serializer
 * redaction is inherited by construction.
 */
export interface AgentToolExecutor {
  readonly tools: readonly AgentToolSpec[]
  call(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<AgentToolResult>
}

export interface AgentLimits {
  maxToolCalls: number
  maxSteps: number
  callTimeoutMs: number
  maxResultChars: number
}

export const DEFAULT_AGENT_LIMITS: AgentLimits = {
  maxToolCalls: 8,
  maxSteps: 6,
  callTimeoutMs: 10_000,
  maxResultChars: 20_000,
}

export type AgentStopReason =
  | 'answered'
  | 'max_tool_calls'
  | 'max_steps'
  | 'model_error'

/** Audit shape (slice 4): tool names and counts only, never prompt or answer text. */
export interface AgentTurnResult {
  stop: AgentStopReason
  answer: string | null
  toolsUsed: string[]
  toolCallCount: number
}

export const AGENT_NOT_AVAILABLE = 'not available to you'
export const AGENT_TOOL_FAILED = 'tool failed'
export const AGENT_TOOL_TIMED_OUT = 'tool timed out'
export const AGENT_RESULT_TRUNCATED = '\n[truncated]'

export class AgentToolRegistryError extends Error {}

export const assertReadOnlyAgentTools = (tools: readonly AgentToolSpec[]): void => {
  const seen = new Set<string>()
  for (const tool of tools) {
    if ((tool.readOnly as unknown) !== true) {
      throw new AgentToolRegistryError(`agent tool ${tool.name} is not read-only`)
    }
    if (seen.has(tool.name)) {
      throw new AgentToolRegistryError(`duplicate agent tool ${tool.name}`)
    }
    seen.add(tool.name)
  }
}

const withTimeout = async <T>(
  ms: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T | 'timeout'> => {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve('timeout')
    }, ms)
  })
  try {
    return await Promise.race([run(controller.signal), timeout])
  } finally {
    clearTimeout(timer)
  }
}

const runTool = async (
  executor: AgentToolExecutor,
  call: AgentToolCall,
  limits: AgentLimits,
): Promise<string> => {
  if (!executor.tools.some((tool) => tool.name === call.name)) {
    return AGENT_NOT_AVAILABLE
  }
  let result: AgentToolResult | 'timeout'
  try {
    result = await withTimeout(limits.callTimeoutMs, (signal) =>
      executor.call(call.name, call.arguments, signal),
    )
  } catch {
    return AGENT_TOOL_FAILED
  }
  if (result === 'timeout') return AGENT_TOOL_TIMED_OUT
  if (!result.ok) {
    // 403 and 404 look identical: no hint why, so existence is not leaked.
    return result.status === 403 || result.status === 404
      ? AGENT_NOT_AVAILABLE
      : AGENT_TOOL_FAILED
  }
  return result.content.length > limits.maxResultChars
    ? result.content.slice(0, limits.maxResultChars) + AGENT_RESULT_TRUNCATED
    : result.content
}

/**
 * One user question to one answer. Bounded: exceeding a limit returns a clear
 * stop reason instead of hanging. Provider failures are reported as
 * `model_error` with no detail, so provider text and keys cannot leak.
 */
export const runAgentTurn = async (input: {
  model: AgentModel
  executor: AgentToolExecutor
  messages: readonly AgentMessage[]
  limits?: Partial<AgentLimits>
}): Promise<AgentTurnResult> => {
  const limits = { ...DEFAULT_AGENT_LIMITS, ...input.limits }
  assertReadOnlyAgentTools(input.executor.tools)
  const messages: AgentMessage[] = [...input.messages]
  const toolsUsed: string[] = []
  let toolCallCount = 0
  const done = (stop: AgentStopReason, answer: string | null): AgentTurnResult => ({
    stop,
    answer,
    toolsUsed: [...new Set(toolsUsed)].sort(),
    toolCallCount,
  })

  for (let step = 0; step < limits.maxSteps; step += 1) {
    const modelStep = await withTimeout(limits.callTimeoutMs, (signal) =>
      input.model.next({ messages, tools: input.executor.tools, signal }),
    ).catch(() => 'timeout' as const)
    if (modelStep === 'timeout') return done('model_error', null)
    if (modelStep.kind === 'answer') return done('answered', modelStep.text)

    if (toolCallCount + modelStep.calls.length > limits.maxToolCalls) {
      return done('max_tool_calls', null)
    }
    messages.push({ role: 'assistant', content: '', toolCalls: modelStep.calls })
    for (const call of modelStep.calls) {
      toolCallCount += 1
      toolsUsed.push(call.name)
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        content: await runTool(input.executor, call, limits),
      })
    }
  }
  return done('max_steps', null)
}
