import { Type } from 'typebox'
import {
  createBrainClient,
  formatBrainRecall,
  type BrainClient,
} from '@phosphor/brain-client/client'
import {
  brainConnectionFromEnv,
  createNodeBrainTransport,
} from '@phosphor/brain-client/node-transport'
import type { ToolDefinition } from './pi-api'

interface BrainContext {
  cwd: string
  sessionManager: { getSessionId(): string }
}
export interface BrainPiApi {
  registerTool<P, D>(definition: ToolDefinition<P, BrainContext, D>): void
}

/**
 * Explicit, read-only recall: one tool, so an agent asks once and gets a briefing back.
 * No context hooks or automatic injection before turns.
 */
export function registerBrain(pi: BrainPiApi, client: BrainClient): void {
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
      const result = await client.search(
        { ...params, sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd },
        signal,
      )
      return {
        content: [{ type: 'text', text: formatBrainRecall(result, ctx.cwd) }],
        details: { status: result.status, memories: result.hits.length },
      }
    },
  })
}

export default function brainExtension(pi: BrainPiApi): void {
  const connection = brainConnectionFromEnv(process.env)
  if (connection) registerBrain(pi, createBrainClient(createNodeBrainTransport(connection)))
}
