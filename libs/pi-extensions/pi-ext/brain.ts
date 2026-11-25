import { validateBrainRequest, SEARCH_GUIDANCE } from '@phosphor/brain-client/validate'
import type { BrainQuery } from '@phosphor/shared/brain-recall'
import { Type } from 'typebox'
import type { BrainTidyProblem } from '@phosphor/shared/brain-tidy'
import { laneOpsEnabled, sendOp, type OpSender } from './op-channel'
import type { ToolDefinition } from './pi-api'

const name = Type.String({ minLength: 1, maxLength: 200 })
export const brainSearchParameters = Type.Object(
  {
    query: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
    from: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 200,
        description: 'A person or thing to expand: its relationships, then its memories.',
      }),
    ),
    to: Type.Optional(
      Type.String({ minLength: 1, maxLength: 200, description: 'With from: how the two connect.' }),
    ),
    context: Type.Optional(Type.Array(name, { maxItems: 5 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  },
  { additionalProperties: false },
)
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
  reason?: string,
) {
  const request = reason === undefined ? { op, args } : { op, args, reason }
  const response = await send(ctx, request, { signal, deadlineMs: 10_000 }).catch(() => null)
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
 * Explicit recall and flags for Brain Agent to check; neither tool can apply a knowledge change.
 * No context hooks or automatic injection before turns.
 */
export function registerBrain(pi: BrainPiApi, send: OpSender): void {
  pi.registerTool<BrainQuery, { status: string; memories: number }>({
    name: 'brain_search',
    label: 'Brain search',
    description:
      'Search saved memories with query, expand a name with from and optional context names, or trace a route with from and to. Choose one move. Notes may be out of date; another project’s memory is context, not a rule.',
    parameters: brainSearchParameters,
    execute: async (_id, params, signal, _update, ctx) => {
      const args = Object.fromEntries(
        (['query', 'from', 'to', 'context', 'limit'] as const)
          .filter((key) => params[key] !== undefined)
          .map((key) => [key, params[key]]),
      )
      try {
        validateBrainRequest('search', args)
      } catch {
        return {
          content: [{ type: 'text', text: SEARCH_GUIDANCE }],
          details: { status: 'invalid', memories: 0 },
        }
      }
      const result = await invoke(send, ctx, 'brain.search', args, signal)
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
      'Flag a numbered memory from the latest brain_search briefing in this lane for Brain Agent to check. Only when the user contradicts it, verified facts show it is wrong or outdated, or two recalled memories duplicate each other. Never on a guess. This does not change Brain knowledge.',
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
      const result = await invoke(send, ctx, 'brain.flag', { ref, problem, reason }, signal, reason)
      return reply(result.text, result.status)
    },
  })
}
