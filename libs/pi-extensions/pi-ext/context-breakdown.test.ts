import { afterEach, describe, expect, it, vi } from 'vitest'
import contextBreakdownExtension, {
  contextEntriesOf,
  entryChars,
  mcpServerOf,
  measureMessages,
  type SessionEntryLike,
} from './context-breakdown'

/** pi's MCP tool as `getAllTools()` reports it (measured on pi 1.2.0). */
const mcpTool = (server: string, tool: string) => ({
  name: `mcp__${server.replace(/-/g, '_')}__${tool}`,
  description: `${tool} on ${server}`,
  namespace: { name: `mcp__${server.replace(/-/g, '_')}`, aliases: [server] },
})

describe('mcpServerOf', () => {
  it('names the server from the namespace alias, which keeps its dashes', () => {
    expect(mcpServerOf(mcpTool('augment-knowledge', 'search'))).toBe('augment-knowledge')
  })

  it('falls back to the namespace, then to the tool name', () => {
    expect(mcpServerOf({ name: 'x', namespace: { name: 'mcp__linear' } })).toBe('linear')
    expect(mcpServerOf({ name: 'mcp__linear__list_issues' })).toBe('linear')
  })

  it('leaves every other tool alone, codemode and tool search included', () => {
    for (const name of ['read', 'bash', 'codemode', 'tool_search', 'mcp', 'read_mcp_resource']) {
      expect(mcpServerOf({ name }), name).toBeNull()
    }
    expect(mcpServerOf({ name: 'x', namespace: { name: 'other' } })).toBeNull()
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
    expect(measureMessages(entries)).toMatchObject({ tokens: 30, thinking: 0, count: 2 })
  })

  it("counts through an old provider's compaction marker", () => {
    // Recorded before pi-claude-cli 0.9.0, when the CLI compacted by itself.
    // The provider now replays pi's whole context, so nothing before the
    // marker has left the model's window.
    const marker = '[Claude Code · compact {"trigger":"auto","postTokens":18013}]'
    const entries: SessionEntryLike[] = [
      user('u1', 'g'.repeat(4000)),
      assistant('a1', [
        { type: 'text', text: 'before '.repeat(100) },
        { type: 'text', text: marker },
        { type: 'toolCall', name: 'read', arguments: {} },
      ]),
      toolResult('t1', 'r'.repeat(400)),
      assistant('a2', [{ type: 'text', text: 'done' }]),
    ]
    const measured = measureMessages(entries)
    expect(measured.count).toBe(4)
    expect(measured.tokens).toBe(
      Math.ceil((4000 + 700 + marker.length + 'read'.length + 2 + 400 + 4) / 4),
    )
  })
})

describe('context breakdown extension', () => {
  afterEach(() => vi.unstubAllEnvs())

  /** A pi stand-in that records handlers and lets a test fire them. */
  function fakePi(
    tools: Array<{ name: string; description?: string; namespace?: unknown }>,
    systemPrompt = '',
    active = tools.map((tool) => tool.name),
  ) {
    const lifecycle = new Map<string, (event: unknown, ctx: unknown) => unknown>()
    const pushed: string[] = []
    let command: ((args: string, ctx: unknown) => Promise<void>) | undefined
    const ctx = {
      ui: { setStatus: (_key: string, text: string | undefined) => pushed.push(text ?? '') },
      getSystemPrompt: () => systemPrompt,
      getContextUsage: () => ({ tokens: 100, contextWindow: 1000 }),
      sessionManager: { buildContextEntries: () => [] },
    }
    contextBreakdownExtension({
      on: (event, handler) => void lifecycle.set(event, handler),
      getAllTools: () => tools,
      getActiveTools: () => active,
      registerCommand: (name, spec) => {
        if (name === 'phosphor-context-files')
          command = spec.handler as (args: string, ctx: unknown) => Promise<void>
      },
    })
    return {
      tools,
      pushed,
      start: () => lifecycle.get('session_start')?.({}, ctx),
      stop: () => lifecycle.get('session_shutdown')?.({}, ctx),
      toggle: (args: string) => command!(args, ctx),
    }
  }

  it('bills only the MCP schemas in the window, and counts every tool a server offers', () => {
    const pi = fakePi(
      [mcpTool('linear', 'list'), mcpTool('linear', 'save'), mcpTool('slack', 'post')],
      '',
      ['mcp__linear__list'],
    )
    pi.start()
    const { mcpByServer, counts } = JSON.parse(pi.pushed[0]!)
    expect(mcpByServer.linear).toMatchObject({ count: 1, toolCount: 2 })
    expect(mcpByServer.linear.tokens).toBeGreaterThan(0)
    expect(mcpByServer.slack).toEqual({ tokens: 0, count: 0, toolCount: 1 })
    expect(counts.mcpTools).toBe(1)
    pi.stop()
  })

  it('re-measures when a server finishes connecting after the start, and only then', () => {
    vi.useFakeTimers()
    try {
      const pi = fakePi([])
      pi.start()
      expect(pi.pushed).toHaveLength(1)
      vi.advanceTimersByTime(3000)
      expect(pi.pushed).toHaveLength(1)
      pi.tools.push(mcpTool('linear', 'list'))
      vi.advanceTimersByTime(1000)
      expect(pi.pushed).toHaveLength(2)
      expect(JSON.parse(pi.pushed[1]!).mcpByServer.linear).toMatchObject({ toolCount: 1 })
      // The watch is bounded: a server that connects much later waits for a turn.
      vi.advanceTimersByTime(60_000)
      pi.tools.push(mcpTool('slack', 'post'))
      vi.advanceTimersByTime(5000)
      expect(pi.pushed).toHaveLength(2)
      pi.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports the context files and bills only the ones the lane sends', async () => {
    // A run inside Phosphor inherits the lane's own setting.
    vi.stubEnv('PHOSPHOR_CONTEXT_FILES', '')
    const block = `<project_instructions path="/r/CLAUDE.md">\n${'c'.repeat(4000)}\n</project_instructions>`
    const prompt = `pre\n\n<project_context>\nProject-specific instructions and guidelines:\n\n${block}\n</project_context>`
    const pi = fakePi([], prompt)
    pi.start()
    const before = JSON.parse(pi.pushed[0]!)
    expect(before.contextFiles).toEqual({
      off: [],
      files: [
        {
          path: '/r/CLAUDE.md',
          kind: 'claude',
          scope: 'project',
          tokens: Math.ceil(block.length / 4),
          included: true,
        },
      ],
    })
    // The toggle runs no turn, so the command itself re-publishes.
    await pi.toggle('claude=off')
    const after = JSON.parse(pi.pushed[1]!)
    expect(after.contextFiles.off).toEqual(['claude'])
    expect(before.parts.systemPrompt - after.parts.systemPrompt).toBe(Math.ceil(block.length / 4))
  })

  it('waits for a context before publishing anything', () => {
    const pi = fakePi([mcpTool('linear', 'list')])
    expect(pi.pushed).toHaveLength(0)
  })
})
