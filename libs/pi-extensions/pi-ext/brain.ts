import { Type } from 'typebox'
import type { BrainTidyProblem } from '@phosphor/shared/brain-tidy'
import { laneOpsEnabled, sendOp, type OpSender } from './op-channel'
import type { ToolDefinition } from './pi-api'

export interface BrainPiApi {
  registerTool<P, D>(definition: ToolDefinition<P, unknown, D>): void
}

/** sendOp owns the deadline and abort race. A service op never starts a confirmation dialog. */
async function invoke(
  send: OpSender,
  ctx: unknown,
  op: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) {
  const response = await send(ctx, { op, args }, { signal, deadlineMs: 10_000 }).catch(() => null)
  if (
    response?.status !== 'ok' ||
    !response.data ||
    typeof response.data !== 'object' ||
    !('status' in response.data) ||
    typeof response.data.status !== 'string'
  )
    return { text: 'Brain is unavailable right now.', status: 'unavailable', memories: 0 }
  const memories =
    'memories' in response.data && typeof response.data.memories === 'number'
      ? response.data.memories
      : 0
  return { text: response.text, status: response.data.status, memories }
}

/**
 * Explicit recall and flags for owner review; neither tool can apply a knowledge change.
 * No context hooks or automatic injection before turns.
 */
export function registerBrain(pi: BrainPiApi, send: OpSender): void {
  pi.registerTool<{ query: string; limit?: number }, { status: string; memories: number }>({
    name: 'brain_search',
    label: 'Brain search',
    description:
      'Search approved notes from earlier lanes by topic, or by the name of a person, team, system or ticket. Returns a briefing: what the query names, how it connects (owners, parts, customers) with each step cited, then disputed items, risks, open items, decisions and facts with their dates, and names to search next. Notes may be out of date; another project’s memory is context, not a rule.',
    parameters: Type.Object(
      {
        query: Type.String({
          minLength: 1,
          maxLength: 2000,
          description: 'A topic or question, or a name such as a person, team, system or ticket.',
        }),
        limit: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 20, description: 'Memories to return. Default 8.' }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (_id, params, signal, _update, ctx) => {
      const result = await invoke(
        send,
        ctx,
        'brain.search',
        { query: params.query, ...(params.limit !== undefined && { limit: params.limit }) },
        signal,
      )
      return {
        content: [{ type: 'text', text: result.text }],
        details: { status: result.status, memories: result.memories },
      }
    },
  })
  registerFlag(pi, send)
}

export default function brainExtension(pi: BrainPiApi, send: OpSender = sendOp): void {
  if (laneOpsEnabled()) registerBrain(pi, send)
}

function registerFlag(pi: BrainPiApi, send: OpSender): void {
  pi.registerTool<{ ref: number; problem: BrainTidyProblem; reason: string }, { status: string }>({
    name: 'brain_flag',
    label: 'Flag Brain memory',
    description:
      'Flag a numbered memory from the latest brain_search briefing in this lane for the owner to review. Only when the user contradicts it, verified facts show it is wrong or outdated, or two recalled memories duplicate each other. Never on a guess. This does not change Brain knowledge.',
    parameters: Type.Object(
      {
        ref: Type.Integer({
          minimum: 1,
          maximum: 20,
          description: 'Bracket number from the latest briefing in this lane.',
        }),
        problem: Type.Union([
          Type.Literal('wrong'),
          Type.Literal('outdated'),
          Type.Literal('duplicate'),
        ]),
        reason: Type.String({ minLength: 1, maxLength: 300 }),
      },
      { additionalProperties: false },
    ),
    execute: async (_id, params, signal, _update, ctx) => {
      const reply = (text: string, status = 'unavailable') => ({
        content: [{ type: 'text' as const, text }],
        details: { status },
      })
      if (
        !params ||
        Object.keys(params).some((key) => !['ref', 'problem', 'reason'].includes(key)) ||
        typeof params.reason !== 'string' ||
        !params.reason.trim() ||
        params.reason.length > 300 ||
        params.reason.includes('\0') ||
        !['wrong', 'outdated', 'duplicate'].includes(params.problem)
      )
        return reply(
          'Use a problem (wrong, outdated or duplicate) and a reason of 1 to 300 characters.',
        )
      const { ref, problem, reason } = params
      const result = await invoke(send, ctx, 'brain.flag', { ref, problem, reason }, signal)
      return reply(result.text, result.status)
    },
  })
}
