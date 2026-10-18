// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { compileQuery, DEFAULT_SEARCH_OPTIONS, type SearchOptions } from '@shared/text-search'
import type { AssistantBlock, AssistantItem, ChatItem, ToolState } from './reducer'

// jsdom implements neither of these, and importing MessageItem pulls in the
// settings store (matchMedia) and MenuRow's scroll-into-view. Stub before the
// module graph loads, since the store subscribes at module scope.
window.matchMedia = vi.fn().mockReturnValue({
  matches: false,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}) as unknown as typeof window.matchMedia
Element.prototype.scrollIntoView = vi.fn()

const { MessageItemView } = await import('./MessageItem')
const { buildTranscriptRows } = await import('./items/transcriptRows')
const { findTranscriptHits, rowPieces } = await import('./transcriptFind')
const { findRanges } = await import('@/components/search/domFind')
const { useSessionsStore } = await import('@/stores/sessions')

/**
 * The invariant find rests on: for every segment, the matches counted from a
 * row's data are the matches its rendered element holds. The count says
 * "3 of 7" from data; the jump lands on the DOM's third match in that
 * segment. Where the two disagree, the bar lands on the wrong word.
 *
 * Each row is rendered once per segment it counts, revealed there — so the
 * run, the tool output, the diff, the reasoning are opened the way a jump
 * opens them — and every segment on screen is held to its count.
 */

let seq = 0
const nextId = (): string => `i${++seq}`

const assistant = (blocks: AssistantBlock[], extra: Partial<AssistantItem> = {}): ChatItem => ({
  id: nextId(),
  kind: 'assistant',
  blocks,
  streaming: false,
  ...extra,
})
const prose = (index: number, text: string): AssistantBlock => ({
  type: 'text',
  index,
  text,
  closed: true,
})
const marker = (index: number, text: string): AssistantBlock =>
  prose(index, `[Claude Code · ${text}]`)
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
const tool = (
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
  text: string,
  extra: Partial<ToolState> = {},
): ToolState => ({
  toolCallId,
  toolName,
  args,
  argsText: '',
  status: 'done',
  output: null,
  result: { content: [{ type: 'text', text }] },
  ...extra,
})

const LONG_DIFF = Array.from(
  { length: 45 },
  (_, i) => `${i % 3 === 0 ? '+' : ' '}${i + 1} line ${i + 1} of the needle file`,
).join('\n')

const TOOLS: Record<string, ToolState> = {
  bash: tool(
    'bash',
    'bash',
    { command: 'cd /repo/src && npm test' },
    'passed\nneedle in a haystack',
  ),
  failed: tool('failed', 'bash', { command: 'false' }, 'command failed: needle', {
    status: 'error',
    isError: true,
  }),
  quiet: tool('quiet', 'bash', { command: 'true' }, ''),
  read: tool(
    'read',
    'read',
    { path: '/repo/src/app.ts', offset: 10, limit: 5 },
    'const needle = 1',
  ),
  edit: tool('edit', 'edit', { path: '/repo/src/app.ts' }, 'Edited', {
    result: { content: [{ type: 'text', text: 'Edited' }], details: { diff: LONG_DIFF } },
  }),
  grep: tool('grep', 'grep', { pattern: 'needle' }, 'src/a.ts:1: a needle'),
  fetch: tool('fetch', 'web_fetch', { url: 'https://needle.dev' }, 'Fetched a page about needles'),
  artifact: tool('artifact', 'artifact_create', { title: 'Needle plan' }, 'Created artifact', {
    result: {
      content: [{ type: 'text', text: 'Created artifact' }],
      details: { id: 'needle-plan', title: 'Needle plan', type: 'markdown', version: 1 },
    },
  }),
}

const ITEMS: ChatItem[] = [
  {
    id: nextId(),
    kind: 'user',
    text: 'Please find the needle in src/app.ts\n\n- one needle\n- two',
  },
  assistant([
    prose(
      0,
      'See **the** [docs](https://x.dev) for `needle`.\n\n## A needle heading\n\n- item one\n- item two\n\n| name | value |\n| --- | --- |\n| needle | a |',
    ),
  ]),
  {
    id: nextId(),
    kind: 'custom',
    customType: 'note',
    text: 'An *extension* note about the needle',
    inContext: true,
  },
  {
    id: nextId(),
    kind: 'bash',
    command: 'grep -rn needle .',
    output: 'a.ts: needle\nb.ts: another needle',
    exitCode: 0,
    running: false,
    truncated: false,
  },
  {
    id: nextId(),
    kind: 'bash',
    command: 'true',
    output: '',
    exitCode: 0,
    running: false,
    truncated: false,
  },
  { id: nextId(), kind: 'divider', variant: 'error', summary: 'Compaction failed: needle lost' },
  {
    id: nextId(),
    kind: 'divider',
    variant: 'compaction',
    tokensBefore: 12_000,
    summary: 'Summarized the needle hunt so far',
  },
  assistant([
    thought(0, 'Think about the *needle*'),
    call(1, 'bash'),
    call(2, 'failed'),
    call(3, 'quiet'),
    thought(4, 'Read it first'),
    thought(5, 'then edit'),
    call(6, 'read'),
    call(7, 'edit'),
    call(8, 'grep'),
    call(9, 'fetch'),
    call(10, 'artifact'),
    thought(11, 'A thought no row shows'),
    call(12, 'gone'),
    thought(13, 'Another thought no row shows'),
    marker(14, 'Bash #t1 {"command":"ls /repo/src"}'),
    marker(15, 'result #t1 {"status":"ok","summary":"2 lines","preview":"app.ts\\nneedle.ts"}'),
    marker(16, 'Bash #t2 {"command":"cat needle"}'),
    marker(
      17,
      'result #t2 {"status":"error","summary":"exit 1","error":"cat: needle: No such file"}',
    ),
    marker(18, 'WebSearch {"query":"needle docs"}'),
    marker(19, 'Bash #t3 {"command":"true"}'),
    marker(20, 'result #t3 {"status":"ok","summary":"no output","preview":""}'),
    marker(21, 'Agent {"description":"Survey the needle","prompt":"Look for every needle"}'),
    marker(22, 'Agent {"subagent_type":"general-purpose"}'),
    thought(23, 'All done, the needle is found'),
  ]),
  assistant([prose(0, 'Trying again')], {
    stopReason: 'error',
    errorMessage: 'Something failed: needle not threaded',
  }),
]

const QUERIES: Array<[string, Partial<SearchOptions>]> = [
  ['needle', {}],
  // Single letters: any label or placeholder a segment renders but the data
  // leaves out (or the reverse) holds one of these.
  ['e', {}],
  ['a', {}],
  ['o', {}],
  ['ran', {}],
  ['Ran npm', {}],
  ['needle', { wholeWord: true }],
  ['Needle', { caseSensitive: true }],
  ['n\\w+e', { regex: true }],
]

function compile(text: string, options: Partial<SearchOptions>): RegExp {
  const compiled = compileQuery({ text, ...DEFAULT_SEARCH_OPTIONS, ...options })
  if (compiled.status !== 'ready') throw new Error(`bad query ${text}`)
  return compiled.regex
}

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(ui: React.ReactNode): HTMLDivElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(ui)
  })
  return container
}

beforeAll(() => {
  // ErrorBlock reads the active AWS profile over IPC on mount.
  ;(globalThis as unknown as { window: { phosphor: unknown } }).window.phosphor = {
    invoke: vi.fn().mockResolvedValue({ awsProfile: undefined }),
  }
  // Tool rows strip the session's cwd out of commands, as the count does.
  useSessionsStore.setState({ live: { s1: { phosphorId: 's1', workspacePath: '/repo' } } })
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

/** The row's segments a reader can see: not inside a collapsed run or hidden subtree. */
function visibleSegments(row: HTMLElement): HTMLElement[] {
  return [...row.querySelectorAll<HTMLElement>('[data-find-segment]')].filter((segment) => {
    const hidden = segment.closest('[aria-hidden="true"], [hidden]')
    return !hidden || !row.contains(hidden)
  })
}

describe.each([false, true])('data and DOM agree (hideThinking: %s)', (hideThinking) => {
  const rows = buildTranscriptRows(ITEMS)
  const context = { tools: TOOLS, hideThinking, workspacePath: '/repo' }
  const counts = QUERIES.map(([text, options]) => {
    const regex = compile(text, options)
    const bySegment = new Map<string, number>()
    for (const hit of findTranscriptHits(rows, context, regex, 10_000).hits) {
      const key = `${hit.rowId}\u0000${hit.segment}`
      bySegment.set(key, (bySegment.get(key) ?? 0) + 1)
    }
    return { label: `${text} ${JSON.stringify(options)}`, regex, bySegment }
  })

  const cases = rows.flatMap((row) =>
    [...new Set(rowPieces(row, context).map((piece) => piece.segment))].map(
      (segment) => [row.id, segment, row] as const,
    ),
  )

  it('counts something in every kind of row', () => {
    const kinds = new Set(cases.map(([, , row]) => row.kind))
    expect([...kinds].sort()).toEqual(['activity', 'item', 'outcome', 'text'])
  })

  it.each(cases)('%s revealed at %s', (rowId, segment, row) => {
    const host = render(
      <div data-find-row={rowId}>
        <MessageItemView
          row={row}
          tools={TOOLS}
          hideThinking={hideThinking}
          sessionId="s1"
          reveal={{ rowId, segment, nonce: 1 }}
        />
      </div>,
    )
    const rowElement = host.firstElementChild as HTMLElement
    const shown = visibleSegments(rowElement)
    const names = shown.map((element) => element.dataset.findSegment!)
    // Found again by name, so a name means one element per row.
    expect(new Set(names).size, `duplicate segments: ${names.join(', ')}`).toBe(names.length)
    // The reveal opened whatever hid it.
    expect(names).toContain(segment)

    for (const element of shown) {
      const name = element.dataset.findSegment!
      for (const { label, regex, bySegment } of counts) {
        expect(
          findRanges(element, regex, 10_000).length,
          `${name} for ${label}: "${element.textContent}"`,
        ).toBe(bySegment.get(`${rowId}\u0000${name}`) ?? 0)
      }
    }
  })
})
