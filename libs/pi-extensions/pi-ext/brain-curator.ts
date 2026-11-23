/**
 * Brain Agent's tools, loaded only into lanes in Brain's own folder (the Brain lane), never
 * beside brain.ts. Read tools here; write tools in brain-curator-writes.ts. Every result is short
 * text that shows the ids the next call needs and wraps stored text as data.
 *
 * It also keeps the lane's rules current: Brain Agent follows `<cwd>/AGENTS.md`, which the owner
 * (or Brain Agent, when asked) edits while the lane runs. Before every request the block pi
 * rendered for that file is swapped for the file as it is now, as global-context.ts does for the
 * global file: replaced when it changed, added when it appeared, removed while it is gone.
 */
import { resolve } from 'node:path'
import { Type } from 'typebox'
import {
  BRAIN_CURATOR_REFRESH_TIMEOUT_MS,
  createBrainCuratorClient,
  type BrainCuratorClient,
} from '@phosphor/brain-client/curator-client'
import {
  formatEntity,
  formatMemory,
  formatSearch,
  formatSuggestion,
  formatWaiting,
} from '@phosphor/brain-client/curator-format'
import {
  createNodeBrainTransport,
  takeBrainConnection,
} from '@phosphor/brain-client/node-transport'
import { applyGlobalContext, contextFilesDisabled, globalContextReader } from './global-context'
import { curatorId, registerCuratorWrites, reply, type CuratorPiApi } from './brain-curator-writes'
import type { EventApi } from './pi-api'

/** Brain Agent's rules file, kept current in every request of the Brain lane. */
export function registerRulesReload(
  pi: EventApi,
  cwd: string = process.cwd(),
  argv: readonly string[] = process.argv,
): void {
  if (contextFilesDisabled(argv)) return
  const folder = resolve(cwd)
  const read = globalContextReader(folder)
  pi.on('context_with_system', (event) => {
    const messages = (event as { messages?: unknown[] }).messages
    if (!Array.isArray(messages) || !applyGlobalContext(messages, read(), folder, 'last'))
      return undefined
    return { messages }
  })
}

function registerRead<P>(
  pi: CuratorPiApi,
  name: string,
  label: string,
  description: string,
  parameters: unknown,
  run: (params: P, signal: AbortSignal | undefined) => Promise<string>,
): void {
  pi.registerTool<P, { status: string }>({
    name,
    label,
    description,
    parameters,
    execute: async (_id, params, signal) => reply(await run(params, signal)),
  })
}

export function registerCuratorReads(pi: CuratorPiApi, client: BrainCuratorClient): void {
  const object = (properties: Parameters<typeof Type.Object>[0]) =>
    Type.Object(properties, { additionalProperties: false })
  // Every tool needs a required parameter: a call with no arguments fails validation.
  registerRead<{ limit: number }>(
    pi,
    'brain_waiting',
    'Brain: what is waiting',
    'List what waits for Brain Agent, in the order to decide it: reads, then people and things, repeats, disagreements and flags, then up to 40 unchecked possible repeats. Shows the ids the other brain_ tools take. Start every Defrag here with limit 60, and call it again to see what is left.',
    object({
      limit: Type.Integer({
        minimum: 1,
        maximum: 200,
        description: 'Items to list. Use 60; up to 200.',
      }),
    }),
    async (params, signal) => formatWaiting(await client.call('waiting', params, signal)),
  )
  registerRead<{ jobId: string; offset?: number }>(
    pi,
    'brain_read_review',
    'Brain: open a read',
    'Open one waiting read (a lane Brain read): its identity questions, group questions and proposed memories with their indexes, and the revision to decide on. A long read comes in pages: each page ends with "Call again with offset N" until the last. If Brain changed since the read, this refreshes it first, which can take a few minutes.',
    object({
      jobId: curatorId('The read id from brain_waiting, such as job-…'),
      offset: Type.Optional(
        Type.Integer({
          minimum: 0,
          description:
            'Where to go on, from the last page’s "Call again with offset N". Leave out at first.',
        }),
      ),
    }),
    async (params, signal) => (await client.call('readReview', params, signal)).text,
  )
  registerRead<{ suggestionId: string }>(
    pi,
    'brain_suggestion',
    'Brain: open a suggestion',
    'Open one suggestion from brain_waiting (same person or thing, said twice, disagreement, flag or possible repeat): its people, things or memories with quotes, its reason and the actions allowed for brain_resolve.',
    object({ suggestionId: curatorId('The suggestion id from brain_waiting.') }),
    async (params, signal) => formatSuggestion(await client.call('suggestion', params, signal)),
  )
  registerRead<{ query: string; limit?: number }>(
    pi,
    'brain_search',
    'Brain: search memories',
    'Search Brain’s memories by a name (person, team, system, ticket) or a short topic, across every project. Lists memory ids for brain_memory, brain_correct and brain_erase, and entity ids for brain_entity.',
    object({
      query: Type.String({ minLength: 1, maxLength: 2000, description: 'A name or short topic.' }),
      limit: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 20, description: 'Memories to list. Default 8.' }),
      ),
    }),
    async (params, signal) => formatSearch(await client.call('search', params, signal)),
  )
  registerRead<{ entityId: string }>(
    pi,
    'brain_entity',
    'Brain: open a person or thing',
    'Show one person or thing: its names, description, connections and the lanes its memories came from.',
    object({ entityId: curatorId('The entity id, such as one listed by brain_suggestion.') }),
    async (params, signal) => formatEntity(await client.call('entity', params, signal)),
  )
  registerRead<{ memoryId: string }>(
    pi,
    'brain_memory',
    'Brain: open a memory',
    'Show one memory with its quotes, the memories it replaced and the ones it disagrees with.',
    object({ memoryId: curatorId('The memory id.') }),
    async (params, signal) => formatMemory(await client.call('memory', params, signal)),
  )
}

export default function brainCuratorExtension(pi: CuratorPiApi): void {
  registerRulesReload(pi)
  const connection = takeBrainConnection()
  if (!connection) return
  const client = createBrainCuratorClient(
    createNodeBrainTransport(connection, { timeoutMs: BRAIN_CURATOR_REFRESH_TIMEOUT_MS }),
  )
  registerCuratorReads(pi, client)
  registerCuratorWrites(pi, client)
}
