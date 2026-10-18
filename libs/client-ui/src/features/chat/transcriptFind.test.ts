import { describe, expect, it } from 'vitest'
import { compileQuery, DEFAULT_SEARCH_OPTIONS } from '@shared/text-search'
import { buildTranscriptRows } from './items/transcriptRows'
import type { AssistantBlock, AssistantItem, ChatItem, ToolState } from './reducer'
import {
  createFindCache,
  findTranscriptHits,
  nearestHit,
  rowPieces,
  stepFindKey,
  type TranscriptFindContext,
} from './transcriptFind'

let seq = 0
const nextId = (): string => `i${++seq}`

const assistant = (
  blocks: AssistantBlock[],
  extra: Partial<AssistantItem> = {},
): AssistantItem => ({
  id: nextId(),
  kind: 'assistant',
  blocks,
  streaming: false,
  ...extra,
})
const user = (text: string): ChatItem => ({ id: nextId(), kind: 'user', text })
const prose = (index: number, text: string): AssistantBlock => ({
  type: 'text',
  index,
  text,
  closed: true,
})
const thought = (index: number, text: string): AssistantBlock => ({
  type: 'thinking',
  index,
  text,
  closed: true,
})
const call = (index: number, toolCallId: string): AssistantBlock => ({
  type: 'tool',
  index,
  toolCallId,
})
const bashTool = (id: string, command: string, output: string): ToolState => ({
  toolCallId: id,
  toolName: 'bash',
  args: { command },
  argsText: '',
  status: 'done',
  output: null,
  result: { content: [{ type: 'text', text: output }] },
})

/** A Claude Code provider marker, which `buildTranscriptRows` turns into a CLI-side step. */
const marker = (index: number, text: string): AssistantBlock =>
  prose(index, `[Claude Code · ${text}]`)

const regex = (text: string, options: Partial<typeof DEFAULT_SEARCH_OPTIONS> = {}): RegExp => {
  const compiled = compileQuery({ text, ...DEFAULT_SEARCH_OPTIONS, ...options })
  if (compiled.status !== 'ready') throw new Error('bad query')
  return compiled.regex
}

const context = (
  tools: Record<string, ToolState> = {},
  hideThinking = false,
): TranscriptFindContext => ({
  tools,
  hideThinking,
})

describe('rowPieces', () => {
  it('reads prose as rendered text, not markdown source', () => {
    const [row] = buildTranscriptRows([assistant([prose(0, 'See **the** [docs](https://x.dev)')])])
    expect(rowPieces(row!, context())).toEqual([{ segment: 'body', text: 'See the docs' }])
  })

  it('splits a tool step into the reasoning before it, its summary and its output', () => {
    const tools = { c1: bashTool('c1', 'npm test', 'all green') }
    const rows = buildTranscriptRows([assistant([thought(0, 'Run the *tests*'), call(1, 'c1')])])
    const activity = rows.find((row) => row.kind === 'activity')!
    const segments = rowPieces(activity, context(tools)).map((piece) => piece.segment)
    // The order the rows show them: the thought's row sits above its step.
    expect(segments).toEqual(['thought:c1', 'step:c1', 'detail:c1'])
    expect(rowPieces(activity, context(tools))[0]!.text).toBe('Run the tests')
  })

  it('drops reasoning when thinking is hidden, and pairs a trailing thought with the run end', () => {
    const tools = { c1: bashTool('c1', 'ls', '') }
    const rows = buildTranscriptRows([assistant([call(0, 'c1'), thought(1, 'done now')])])
    const activity = rows.find((row) => row.kind === 'activity')!
    expect(rowPieces(activity, context(tools)).map((piece) => piece.segment)).toContain(
      'thought:end',
    )
    expect(rowPieces(activity, context(tools, true)).map((piece) => piece.segment)).not.toContain(
      'thought:end',
    )
  })

  it('counts the reasoning before every step, since every thought has its own row', () => {
    const tools = { c1: bashTool('c1', 'ls', '') }
    const rows = buildTranscriptRows([
      assistant([
        thought(0, 'before the CLI tool'),
        marker(1, 'Bash {"command":"npm run lint"}'),
        thought(2, 'before the agent'),
        marker(3, 'Agent {"description":"Survey","prompt":"Look around"}'),
        thought(4, 'before the missing tool'),
        call(5, 'gone'),
        thought(6, 'before the tool'),
        call(7, 'c1'),
      ]),
    ])
    const activity = rows.find((row) => row.kind === 'activity')!
    const thoughts = rowPieces(activity, context(tools)).filter((piece) =>
      piece.segment.startsWith('thought:'),
    )
    // Reasoning before a CLI-side tool or a sub-agent used to be on no screen
    // (only a pi tool row had a gutter mark), so find skipped it.
    expect(thoughts.map((piece) => piece.text)).toEqual([
      'before the CLI tool',
      'before the agent',
      'before the missing tool',
      'before the tool',
    ])
    // Each is keyed by the step after it, whatever that step is.
    expect(thoughts.slice(2).map((piece) => piece.segment)).toEqual(['thought:gone', 'thought:c1'])
  })

  it('reads a summary line with its parts spaced, as the row shows them', () => {
    const tools = { c1: { ...bashTool('c1', 'npm test', ''), status: 'error' as const } }
    const rows = buildTranscriptRows([assistant([call(0, 'c1')])])
    const [summary] = rowPieces(rows[0]!, context(tools))
    expect(summary).toEqual({ segment: 'step:c1', text: 'Ran npm test failed' })
    const across = findTranscriptHits(rows, context(tools), regex('test failed'), 10)
    expect(across.hits.map((hit) => hit.segment)).toEqual(['step:c1'])
    const word = findTranscriptHits(rows, context(tools), regex('test', { wholeWord: true }), 10)
    expect(word.hits.map((hit) => hit.segment)).toEqual(['step:c1', 'detail:c1'])
  })

  it('reads a CLI-side row with its outcome, and its preview as the detail', () => {
    const rows = buildTranscriptRows([
      assistant([
        marker(0, 'Bash #t1 {"command":"ls"}'),
        marker(1, 'result #t1 {"status":"ok","summary":"4 lines out","preview":"a\\nb"}'),
      ]),
    ])
    const [row] = rows
    if (row?.kind !== 'activity') throw new Error('expected an activity row')
    const key = stepFindKey(row.steps[0]!)
    expect(rowPieces(row, context())).toEqual([
      { segment: `step:${key}`, text: 'Ran ls 4 lines out' },
      { segment: `detail:${key}`, text: 'a\nb' },
    ])
  })

  it('leaves out what an artifact card restates, but not its failure', () => {
    const artifact = (isError: boolean): ToolState => ({
      toolCallId: 'a1',
      toolName: 'artifact_create',
      args: { title: 'Launch plan', content: '# Launch plan' },
      argsText: '',
      status: isError ? 'error' : 'done',
      output: null,
      isError,
      result: { content: [{ type: 'text', text: isError ? 'Invalid type' : 'Created artifact' }] },
    })
    const rows = buildTranscriptRows([assistant([call(0, 'a1')])])
    const detail = (tool: ToolState): string | undefined =>
      rowPieces(rows[0]!, context({ a1: tool })).find((piece) => piece.segment === 'detail:a1')
        ?.text
    expect(detail(artifact(false))).toBe('')
    expect(detail(artifact(true))).toBe('Invalid type')
  })
})

describe('findTranscriptHits', () => {
  const tools = { c1: bashTool('c1', 'grep needle', 'needle\nneedle') }
  const rows = buildTranscriptRows([
    user('find the needle'),
    assistant([call(0, 'c1')]),
    assistant([prose(0, 'No **needle** here, just a Needle')]),
  ])

  it('counts every match, numbering them within each segment', () => {
    const { hits, capped } = findTranscriptHits(rows, context(tools), regex('needle'), 100)
    expect(capped).toBe(false)
    expect(hits.map((hit) => [hit.row, hit.segment, hit.ordinal])).toEqual([
      [0, 'body', 0],
      [1, 'step:c1', 0],
      [1, 'detail:c1', 0],
      [1, 'detail:c1', 1],
      [1, 'detail:c1', 2],
      [2, 'body', 0],
      [2, 'body', 1],
    ])
  })

  it('stops at the limit and says so', () => {
    const { hits, capped } = findTranscriptHits(rows, context(tools), regex('needle'), 3)
    expect(hits).toHaveLength(3)
    expect(capped).toBe(true)
  })

  it('reuses counts across passes for the same query, and only for it', () => {
    const cache = createFindCache()
    const query = regex('needle')
    findTranscriptHits(rows, context(tools), query, 100, cache)
    // A count no pass would compute: a recount would replace it.
    cache.counts.set('find the needle', 3)
    const again = findTranscriptHits(rows, context(tools), query, 100, cache)
    expect(again.hits.filter((hit) => hit.row === 0)).toHaveLength(3)

    cache.counts.set('find the needle', 3)
    const fresh = findTranscriptHits(rows, context(tools), regex('needle'), 100, cache)
    expect(fresh.hits.filter((hit) => hit.row === 0)).toHaveLength(1)
  })

  it('keeps only the counts the last pass used', () => {
    const cache = createFindCache()
    const query = regex('needle')
    findTranscriptHits(rows, context(tools), query, 100, cache)
    findTranscriptHits(rows.slice(0, 1), context(tools), query, 100, cache)
    expect([...cache.counts.keys()]).toEqual(['find the needle'])
  })

  it('carries CLI-side summaries across passes, though their blocks are rebuilt', () => {
    const items = [assistant([marker(0, 'Bash {"command":"grep needle"}')])]
    const cache = createFindCache()
    const query = regex('needle')
    findTranscriptHits(buildTranscriptRows(items), context(), query, 100, cache)
    expect(cache.summaries.size).toBe(1)
    const [key] = cache.summaries.keys()
    // A line no pass would derive: were it re-derived, it would be replaced.
    cache.summaries.set(key!, 'needle needle')
    const { hits } = findTranscriptHits(buildTranscriptRows(items), context(), query, 100, cache)
    expect(hits).toHaveLength(2)

    findTranscriptHits(buildTranscriptRows([user('no tools')]), context(), query, 100, cache)
    expect(cache.summaries.size).toBe(0)
  })
})

describe('nearestHit', () => {
  const hits = [1, 4, 9].map((row) => ({ row, rowId: `r${row}`, segment: 'body', ordinal: 0 }))

  it('lands on the first hit at or below the top of the viewport', () => {
    expect(nearestHit(hits, 3)).toBe(1)
    expect(nearestHit(hits, 4)).toBe(1)
  })

  it('falls back to the last hit above when nothing is below', () => {
    expect(nearestHit(hits, 10)).toBe(2)
    expect(nearestHit([], 0)).toBe(-1)
  })
})
