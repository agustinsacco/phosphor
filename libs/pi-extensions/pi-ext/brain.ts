import { Type } from 'typebox'
import { createBrainClient, brainBriefing, type BrainClient } from '@phosphor/brain-client/client'
import {
  createNodeBrainTransport,
  takeBrainConnection,
} from '@phosphor/brain-client/node-transport'
import type { BrainTidyProblem } from '@phosphor/shared/brain-tidy'
import type { ToolDefinition } from './pi-api'

interface BrainContext {
  cwd: string
  sessionManager: { getSessionId(): string; getSessionName?(): string | undefined }
}
export interface BrainPiApi {
  registerTool<P, D>(definition: ToolDefinition<P, BrainContext, D>): void
}

/**
 * Explicit recall and flags for owner review; neither tool can apply a knowledge change.
 * No context hooks or automatic injection before turns.
 */
export function registerBrain(pi: BrainPiApi, client: BrainClient): void {
  const refs = new Map<string, Map<number, string>>()
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
      const sessionId = ctx.sessionManager.getSessionId()
      refs.delete(sessionId)
      const result = await client.search({ ...params, sessionId, cwd: ctx.cwd }, signal)
      const briefing = brainBriefing(result, ctx.cwd)
      refs.set(sessionId, briefing.refs)
      return {
        content: [{ type: 'text', text: briefing.text }],
        details: { status: result.status, memories: result.hits.length },
      }
    },
  })
  registerFlag(pi, client, refs)
}

export default function brainExtension(pi: BrainPiApi): void {
  const connection = takeBrainConnection()
  if (connection) registerBrain(pi, createBrainClient(createNodeBrainTransport(connection)))
}

function registerFlag(
  pi: BrainPiApi,
  client: BrainClient,
  refs: Map<string, Map<number, string>>,
): void {
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
      const sessionId = ctx.sessionManager.getSessionId()
      const memoryId = Number.isInteger(params.ref)
        ? refs.get(sessionId)?.get(params.ref)
        : undefined
      if (!memoryId)
        return reply(
          'That number is not in the latest Brain briefing for this lane; search again first.',
        )
      const result = await client.flag(
        {
          memoryId,
          problem: params.problem,
          reason: params.reason,
          sessionId,
          title: (ctx.sessionManager.getSessionName?.()?.trim() || 'Lane').slice(0, 120),
        },
        signal,
      )
      return reply(result.message, result.status)
    },
  })
}
