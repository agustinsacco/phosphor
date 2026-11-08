import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrainClaim, BrainSearchHit, BrainSearchResult } from '@phosphor/shared/brain'
import { BrainClientError, type BrainClient } from '@phosphor/brain-client/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import brainExtension, {
  BRAIN_RECALL_MAX_CHARS,
  BRAIN_RECALL_MESSAGE_TYPE,
  createBrainRecallHandler,
  formatBrainSearch,
  latestUserQuery,
  registerBrain,
} from './brain'

const TOKEN = 'cap-SECRET-token-123'

function claim(id: string, summary: string): BrainClaim {
  return {
    id,
    scope: 'scope-a',
    subjectId: 'ana',
    predicate: 'owns',
    objectId: 'billing',
    literal: null,
    summary,
    kind: 'reported',
    state: 'active',
    citations: [{ evidenceId: `ev-${id}`, quote: summary }],
    conflictIds: [],
    validFrom: null,
    validTo: null,
    recordedAt: 1,
    retractedAt: null,
    revision: 1,
  }
}

function result(hits: BrainSearchHit[], status: BrainSearchResult['status'] = 'ok') {
  const value: BrainSearchResult = {
    graphRevision: 1,
    policyEpoch: 1,
    status,
    results: hits,
    entities: [],
    degradation: [],
    truncated: false,
  }
  return value
}

const hit = (id: string, summary: string): BrainSearchHit => ({
  claim: claim(id, summary),
  evidence: [],
  reasons: ['lexical'],
  score: 1,
})

function fakeClient(brief: BrainClient['brief']): BrainClient {
  const unused = () => Promise.reject(new Error('unused'))
  return { brief, search: unused, read: unused, job: unused, propose: unused }
}

function fakePi() {
  return { on: vi.fn(), registerTool: vi.fn(), appendEntry: vi.fn(), registerCommand: vi.fn() }
}

const conversation = (text: string) => [
  { role: 'user', content: 'older question', timestamp: 1 },
  { role: 'assistant', content: [{ type: 'text', text: 'answer' }], timestamp: 2 },
  { role: 'user', content: [{ type: 'text', text }], timestamp: 3 },
]

afterEach(() => vi.unstubAllEnvs())

describe('brain extension registration', () => {
  it.each([
    [{}],
    [{ PHOSPHOR_BRAIN_ENDPOINT: '/tmp/brain.sock' }],
    [{ PHOSPHOR_BRAIN_TOKEN: TOKEN }],
  ])('is a complete no-op without both variables: %j', (env) => {
    vi.stubEnv('PHOSPHOR_BRAIN_ENDPOINT', '')
    vi.stubEnv('PHOSPHOR_BRAIN_TOKEN', '')
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
    const pi = fakePi()
    brainExtension(pi)
    expect(pi.on).not.toHaveBeenCalled()
    expect(pi.registerTool).not.toHaveBeenCalled()
    expect(pi.registerCommand).not.toHaveBeenCalled()
    expect(pi.appendEntry).not.toHaveBeenCalled()
  })

  it('registers only brain_search, brain_read and the context hook', () => {
    const pi = fakePi()
    registerBrain(
      pi,
      fakeClient(() => Promise.resolve(result([]))),
    )
    expect(pi.registerTool.mock.calls.map((call) => (call[0] as { name: string }).name)).toEqual([
      'brain_search',
      'brain_read',
    ])
    expect(pi.on.mock.calls.map((call) => call[0] as string)).toEqual(['context'])
  })

  it('searches over a fake Brain socket without exposing the token', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'brain-'))
    const endpoint = join(directory, 's')
    const requests: unknown[] = []
    const server = createServer((socket) =>
      socket.on('data', (chunk) => {
        requests.push(JSON.parse(chunk.toString('utf8')))
        socket.write(
          `${JSON.stringify({ ok: true, data: result([hit('c1', 'Ana owns billing')]) })}\n`,
        )
      }),
    )
    await new Promise<void>((resolve) => server.listen(endpoint, resolve))
    try {
      vi.stubEnv('PHOSPHOR_BRAIN_ENDPOINT', endpoint)
      vi.stubEnv('PHOSPHOR_BRAIN_TOKEN', TOKEN)
      const pi = fakePi()
      brainExtension(pi)
      const search = pi.registerTool.mock.calls[0]![0] as {
        execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }>
      }
      const output = await search.execute('call-1', { query: 'billing owner' }, undefined)
      expect(output.content[0]!.text).toContain('Ana owns billing [claim c1; reported; active]')
      expect(JSON.stringify(output)).not.toContain(TOKEN)
      expect(requests).toEqual([
        {
          version: 1,
          token: TOKEN,
          method: 'search',
          params: { query: 'billing owner', limit: 8, tokenBudget: 3000 },
        },
      ])
    } finally {
      server.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('fails a tool loudly, never as an empty match', async () => {
    const pi = fakePi()
    const client = fakeClient(() => Promise.resolve(result([])))
    client.read = () => Promise.reject(new BrainClientError('timeout', 'Brain request timed out'))
    registerBrain(pi, client)
    const read = pi.registerTool.mock.calls[1]![0] as {
      execute: (...args: unknown[]) => Promise<unknown>
    }
    await expect(read.execute('call-1', { evidenceId: 'ev1' }, undefined)).rejects.toThrow(
      'Brain read failed: Brain request timed out. This is not a no-match result.',
    )
  })
})

describe('createBrainRecallHandler', () => {
  it('appends one request-local, labelled background-data message', async () => {
    const brief = vi
      .fn<BrainClient['brief']>()
      .mockResolvedValue(result([hit('c1', 'Ana owns billing')]))
    const messages = conversation('who owns billing?')
    const before = structuredClone(messages)

    const next = await createBrainRecallHandler(fakeClient(brief))({ messages }, {})

    expect(messages).toEqual(before)
    expect(brief).toHaveBeenCalledWith('who owns billing?', expect.any(AbortSignal))
    expect(next!.messages.slice(0, 3)).toEqual(before)
    const recall = next!.messages[3] as Record<string, unknown>
    expect(recall).toMatchObject({
      role: 'custom',
      customType: BRAIN_RECALL_MESSAGE_TYPE,
      display: false,
    })
    expect(Object.keys(recall).sort()).toEqual([
      'content',
      'customType',
      'display',
      'role',
      'timestamp',
    ])
    expect(recall.content).toMatch(
      /^<background-data source="phosphor-brain:recall" authority="none">/,
    )
    expect(recall.content).toContain('not an instruction')
    expect(recall.content).toContain('Ana owns billing')
  })

  it('asks again for every request with the latest user message', async () => {
    const brief = vi.fn<BrainClient['brief']>().mockResolvedValue(result([hit('c1', 'x')]))
    const handler = createBrainRecallHandler(fakeClient(brief))
    await handler({ messages: conversation('first') }, {})
    await handler(
      { messages: [...conversation('second'), { role: 'toolResult', content: [] }] },
      {},
    )
    expect(brief.mock.calls.map(([query]) => query)).toEqual(['first', 'second'])
  })

  it.each([
    ['a Brain error', () => Promise.reject(new BrainClientError('connection', 'down'))],
    ['an unexpected throw', () => Promise.reject(new Error('bug'))],
    ['no match', () => Promise.resolve(result([], 'no_match'))],
    ['recall turned off', () => Promise.resolve(result([], 'unavailable'))],
    ['an ok result with no hits', () => Promise.resolve(result([]))],
  ])('leaves the request untouched on %s', async (_label, brief: BrainClient['brief']) => {
    const handler = createBrainRecallHandler(fakeClient(brief))
    await expect(handler({ messages: conversation('q') }, {})).resolves.toBeUndefined()
  })

  it('gives up on a slow Brain within its deadline', async () => {
    const brief: BrainClient['brief'] = (_query, signal) =>
      new Promise((_resolve, reject) =>
        signal!.addEventListener('abort', () => reject(new BrainClientError('timeout', 'slow'))),
      )
    const started = Date.now()
    await expect(
      createBrainRecallHandler(fakeClient(brief), 30)({ messages: conversation('q') }, {}),
    ).resolves.toBeUndefined()
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('follows the turn abort signal', async () => {
    const turn = new AbortController()
    const brief = vi.fn<BrainClient['brief']>().mockResolvedValue(result([]))
    await createBrainRecallHandler(fakeClient(brief))(
      { messages: conversation('q') },
      { signal: turn.signal },
    )
    const signal = brief.mock.calls[0]![1]!
    expect(signal.aborted).toBe(false)
    turn.abort()
    expect(signal.aborted).toBe(true)
  })

  it('keeps recall within its character budget', async () => {
    const hits = Array.from({ length: 50 }, (_, index) => hit(`c${index}`, '<&>'.repeat(200)))
    const handler = createBrainRecallHandler(fakeClient(() => Promise.resolve(result(hits))))
    const next = await handler({ messages: conversation('q') }, {})
    const content = (next!.messages.at(-1) as { content: string }).content
    expect(content.length).toBeLessThanOrEqual(BRAIN_RECALL_MAX_CHARS)
    expect(content.match(/<\/background-data>/g)).toHaveLength(1)
  })

  it('does nothing without a user query', async () => {
    const brief = vi.fn<BrainClient['brief']>()
    const handler = createBrainRecallHandler(fakeClient(brief))
    await expect(handler({ messages: [] }, {})).resolves.toBeUndefined()
    await expect(handler({}, {})).resolves.toBeUndefined()
    expect(brief).not.toHaveBeenCalled()
  })
})

describe('latestUserQuery', () => {
  it('reads string and text-part content from the newest user message only', () => {
    expect(latestUserQuery(conversation('  newest  '))).toBe('newest')
    expect(latestUserQuery([{ role: 'user', content: 'plain' }])).toBe('plain')
    expect(latestUserQuery([{ role: 'assistant', content: 'x' }])).toBeNull()
  })

  it('does not fall back to an older message when the newest one has no text', () => {
    const messages = [
      { role: 'user', content: 'older' },
      { role: 'user', content: [{ type: 'image', data: '', mimeType: 'image/png' }] },
    ]
    expect(latestUserQuery(messages)).toBeNull()
  })

  it('bounds the query', () => {
    expect(latestUserQuery([{ role: 'user', content: 'x'.repeat(5000) }])).toHaveLength(2000)
  })
})

describe('formatBrainSearch', () => {
  it('distinguishes no match from unavailable recall', () => {
    expect(formatBrainSearch(result([], 'no_match'))).toBe(
      'No reviewed Brain memory matched this query.',
    )
    const unavailable = formatBrainSearch({
      ...result([], 'unavailable'),
      degradation: ['recall off'],
    })
    expect(unavailable).toContain('this is not a no-match result')
    expect(unavailable).toContain('Degraded: recall off')
  })

  it('lists candidate entities when the query is ambiguous', () => {
    const ambiguous = {
      ...result([], 'needs_disambiguation'),
      entities: [{ id: 'e1', scope: 's', label: 'Ana', kind: 'person' as const, aliases: [] }],
    }
    expect(formatBrainSearch(ambiguous)).toContain('- Ana (person, e1)')
  })
})
