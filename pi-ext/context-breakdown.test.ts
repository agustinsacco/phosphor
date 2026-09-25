import { describe, expect, it } from 'vitest'
import contextBreakdownExtension, {
  classifyToolServer,
  contextEntriesOf,
  entryChars,
  isNamespaceProxy,
  measureMessages,
  type SessionEntryLike,
} from './context-breakdown'

/**
 * The adapter renames MCP tools four different ways depending on its
 * `toolPrefix` setting, and the default is not the one this code used to
 * assume. Every mode below was read out of `pi-mcp-adapter/types.ts`
 * (`getServerPrefix` / `formatToolName`) and `namespace-tools.ts`.
 */
describe('classifyToolServer', () => {
  const servers = ['linear', 'braintrust', 'search-mcp']

  it('attributes the default prefix mode ("server": <server>_<tool>)', () => {
    expect(classifyToolServer('linear_create_issue', servers)).toBe('linear')
    expect(classifyToolServer('braintrust_list_experiments', servers)).toBe('braintrust')
  })

  it('attributes the "mcp" prefix mode (mcp__<server>_<tool>)', () => {
    expect(classifyToolServer('mcp__linear_create_issue', servers)).toBe('linear')
  })

  it('attributes a namespace-proxy tool, which is the whole server', () => {
    expect(classifyToolServer('mcp__linear', servers)).toBe('linear')
    expect(classifyToolServer('mcp__search_mcp', servers)).toBe('search-mcp')
  })

  it('attributes the "short" mode, which strips a trailing -mcp', () => {
    expect(classifyToolServer('search_web_search', servers)).toBe('search-mcp')
  })

  it('leaves pi built-ins alone', () => {
    for (const name of ['read', 'write', 'edit', 'bash', 'mcp', 'web_search']) {
      expect(classifyToolServer(name, servers), name).toBeNull()
    }
  })

  it('does not let a shorter server name claim a longer one', () => {
    expect(classifyToolServer('linear-readonly_list', ['linear', 'linear-readonly'])).toBe(
      'linear-readonly',
    )
  })

  it('still recognises a namespaced tool from a server it has not been told about', () => {
    expect(classifyToolServer('mcp__fellow_get_action_items', [])).toBe('fellow')
    expect(classifyToolServer('mcp__fellow', [])).toBe('fellow')
  })

  it('reports an unattributable name as built-in rather than guessing', () => {
    // toolPrefix "none" does not rename at all; nothing in the name says MCP.
    expect(classifyToolServer('create_issue', servers)).toBeNull()
  })
})

describe('isNamespaceProxy', () => {
  it('tells the gateway proxy from a directly registered tool', () => {
    expect(isNamespaceProxy('mcp__search_mcp', 'search-mcp')).toBe(true)
    expect(isNamespaceProxy('mcp__linear', 'linear')).toBe(true)
    expect(isNamespaceProxy('mcp__linear_create_issue', 'linear')).toBe(false)
    expect(isNamespaceProxy('linear_create_issue', 'linear')).toBe(false)
  })
})

const user = (id: string, text: string): SessionEntryLike => ({
  id,
  type: 'message',
  message: { role: 'user', content: [{ type: 'text', text }] },
})
const assistant = (id: string, blocks: unknown[]): SessionEntryLike => ({
  id,
  type: 'message',
  message: { role: 'assistant', content: blocks },
})
const toolResult = (id: string, text: string): SessionEntryLike => ({
  id,
  type: 'message',
  message: { role: 'toolResult', content: [{ type: 'text', text }] },
})

/**
 * Mirrors pi's `buildContextEntries` (session-manager.ts): what the model is
 * sent after a compaction is the summary plus the kept tail, never the whole
 * branch. Measuring the branch read 292k for a 151k context on a real session.
 */
describe('contextEntriesOf', () => {
  const branch: SessionEntryLike[] = [
    user('u1', 'a'.repeat(400)),
    assistant('a1', [{ type: 'text', text: 'b'.repeat(400) }]),
    user('u2', 'kept'),
    assistant('a2', [{ type: 'text', text: 'kept too' }]),
    { id: 'c1', type: 'compaction', summary: 's'.repeat(80), firstKeptEntryId: 'u2' },
    user('u3', 'after'),
  ]

  it('keeps the compaction, the kept tail and everything after it', () => {
    expect(contextEntriesOf(branch).map((e) => e.id)).toEqual(['c1', 'u2', 'a2', 'u3'])
  })

  it('is the whole branch when nothing was compacted', () => {
    const plain = branch.filter((e) => e.type !== 'compaction')
    expect(contextEntriesOf(plain)).toEqual(plain)
  })
})

/** Same roles and block types as pi's `estimateTokens` (compaction.ts). */
describe('entryChars', () => {
  it('counts tool results, which the old measurement skipped entirely', () => {
    expect(entryChars(toolResult('t', 'x'.repeat(1000)))).toBe(1000)
  })

  it('counts an assistant message the way pi does', () => {
    const entry = assistant('a', [
      { type: 'text', text: '12345' },
      { type: 'thinking', thinking: '123' },
      { type: 'toolCall', name: 'read', arguments: { path: 'x' } },
    ])
    expect(entryChars(entry)).toBe(5 + 3 + 'read'.length + JSON.stringify({ path: 'x' }).length)
  })

  it('counts a compaction summary and an image stand-in', () => {
    expect(entryChars({ type: 'compaction', summary: 'abcd' })).toBe(4)
    expect(entryChars({ type: 'custom_message', content: [{ type: 'image' }] })).toBe(4800)
  })

  it('ignores entries pi never sends', () => {
    expect(entryChars({ type: 'model_change' })).toBe(0)
    expect(entryChars({ type: 'label' })).toBe(0)
  })
})

describe('measureMessages', () => {
  it('sums pi context entries and counts only messages', () => {
    const entries: SessionEntryLike[] = [
      { id: 'c', type: 'compaction', summary: 'x'.repeat(40), firstKeptEntryId: 'u' },
      user('u', 'y'.repeat(40)),
      toolResult('t', 'z'.repeat(40)),
    ]
    expect(measureMessages(entries)).toEqual({ tokens: 30, count: 2 })
  })

  it("starts at the CLI's compaction marker on a Claude Code session", () => {
    // pi's record never compacts on these sessions; the provider's marker is
    // the cut. Only what follows it is still in the model's window.
    const entries: SessionEntryLike[] = [
      user('u1', 'g'.repeat(4000)),
      assistant('a1', [
        { type: 'text', text: 'before '.repeat(100) },
        { type: 'text', text: '[Claude Code · compact {"trigger":"auto","postTokens":18013}]' },
        { type: 'toolCall', name: 'read', arguments: {} },
      ]),
      toolResult('t1', 'r'.repeat(400)),
      assistant('a2', [{ type: 'text', text: 'done' }]),
    ]
    const measured = measureMessages(entries)
    expect(measured.count).toBe(3)
    expect(measured.tokens).toBe(Math.ceil(('read'.length + 2 + 400 + 4) / 4))
  })
})

describe('context breakdown extension', () => {
  /** A pi stand-in that records handlers and lets a test fire them. */
  function fakePi(tools: Array<{ name: string; description?: string }>) {
    const lifecycle = new Map<string, (event: unknown, ctx: unknown) => unknown>()
    const bus = new Map<string, (payload: unknown) => void>()
    const pushed: string[] = []
    const ctx = {
      ui: { setStatus: (_key: string, text: string | undefined) => pushed.push(text ?? '') },
      getSystemPrompt: () => '',
      getContextUsage: () => ({ tokens: 100, contextWindow: 1000 }),
      sessionManager: { buildContextEntries: () => [] },
    }
    contextBreakdownExtension({
      on: (event, handler) => void lifecycle.set(event, handler),
      getAllTools: () => tools,
      getActiveTools: () => tools.map((tool) => tool.name),
      events: { on: (event, handler) => void bus.set(event, handler) },
    })
    return {
      pushed,
      start: () => lifecycle.get('session_start')?.({}, ctx),
      status: (servers: Array<{ name: string; toolCount?: number }>) =>
        bus.get('pi-mcp-adapter/status/v1')?.({ servers }),
    }
  }

  it('re-measures when a reconnect changes the servers, which runs no turn', () => {
    const pi = fakePi([{ name: 'linear_list_issues', description: 'List issues' }])
    pi.start()
    expect(pi.pushed).toHaveLength(1)
    pi.status([{ name: 'linear', toolCount: 81 }])
    expect(pi.pushed).toHaveLength(2)
    expect(JSON.parse(pi.pushed[1]!).mcpByServer.linear).toMatchObject({ toolCount: 81, count: 1 })
  })

  it('does not re-measure on a snapshot that changes nothing', () => {
    const pi = fakePi([])
    pi.start()
    pi.status([{ name: 'linear', toolCount: 81 }])
    pi.status([{ name: 'linear', toolCount: 81 }])
    expect(pi.pushed).toHaveLength(2)
  })

  it('waits for a context before publishing anything', () => {
    const pi = fakePi([])
    pi.status([{ name: 'linear', toolCount: 81 }])
    expect(pi.pushed).toHaveLength(0)
  })
})
