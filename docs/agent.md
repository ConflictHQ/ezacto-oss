# In-app agent contract

Status: contract only (issue 105, slice 1). No endpoint, UI, provider adapter or
migration exists yet. The executable contract is `packages/core/src/agent.ts`
with `packages/core/test/agent.test.ts`.

## Interfaces

- `AgentModel`: the provider seam. `next({messages, tools, signal})` returns
  either an answer or tool calls. Adapters own the provider key; the contract
  never receives it.
- `AgentToolExecutor`: the registered tools plus `call(name, args, signal)`.
- `runAgentTurn`: one question to one answer, bounded by `AgentLimits`
  (`maxToolCalls`, `maxSteps`, `callTimeoutMs`, `maxResultChars`).

## Invariants any real implementation must keep

1. **Acting user only.** The executor calls `/api/v1` with the acting user's own
   session or principal, never a service token. Redaction is then inherited from
   the serializers (`docs/domain-model.md` section 5). The profile-inheritance
   test for member, accounting and administrator belongs with the real executor
   and must reuse the fixtures in `packages/mcp/test/server.test.ts`.
2. **Read-only.** Every registered tool has `readOnly: true`; `runAgentTurn`
   throws `AgentToolRegistryError` otherwise. Write tools wait on D12.
3. **Bounded.** Exceeding a cap returns a stop reason (`max_tool_calls`,
   `max_steps`, `model_error`), never a hang. Tool and model calls time out.
4. **No leakage.** A 403 or 404 from a tool reaches the model as the same text,
   "not available to you". Other failures, thrown errors and provider errors are
   reduced to fixed strings or `model_error`.
5. **Audit-safe result.** `AgentTurnResult` carries tool names and counts only,
   never prompt or answer text, so slice 4 can write one activity row per turn.

## Not decided here

Provider and key ownership, who may use the agent, transcript persistence, entry
point and the `agent:use` token scope are owner decisions on issue 105; slice 2
(`POST /api/v1/agent/messages`) is blocked on them.
