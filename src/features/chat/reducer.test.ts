import { describe, expect, it } from 'vitest'
import {
  emptyChatSession,
  hydrateFromMessages,
  reduceChatEvent,
  type AssistantItem,
  type ChatSessionState,
} from './reducer'
import type { AssistantMessage, PiEvent } from '@shared/rpc'

function run(events: PiEvent[], initial?: ChatSessionState): ChatSessionState {
  return events.reduce(reduceChatEvent, initial ?? emptyChatSession())
}

const assistantStart: PiEvent = {
  type: 'message_start',
  message: { role: 'assistant', content: [] },
}

function textDelta(delta: string, contentIndex = 0): PiEvent {
  return {
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex, delta },
  }
}

describe('chat reducer — streaming text', () => {
  it('accumulates text deltas into one assistant item', () => {
    const state = run([
      { type: 'agent_start' },
      assistantStart,
      textDelta('Hello'),
      textDelta(' world'),
    ])
    expect(state.isStreaming).toBe(true)
    const item = state.items[0] as AssistantItem
    expect(item.kind).toBe('assistant')
    expect(item.blocks).toEqual([{ type: 'text', index: 0, text: 'Hello world', closed: false }])
  })

  it('closes text blocks on text_end and snaps to authoritative content', () => {
    const state = run([
      assistantStart,
      textDelta('Hel'),
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'text_end', contentIndex: 0, content: 'Hello!' },
      },
    ])
    const item = state.items[0] as AssistantItem
    expect(item.blocks[0]).toEqual({ type: 'text', index: 0, text: 'Hello!', closed: true })
  })

  it('message_end snaps blocks to final content and clears streaming', () => {
    const final: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Final answer' }],
      stopReason: 'stop',
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    }
    const state = run([
      assistantStart,
      textDelta('Fin'),
      { type: 'message_end', message: final },
      { type: 'agent_end', messages: [final] },
    ])
    const item = state.items[0] as AssistantItem
    expect(item.streaming).toBe(false)
    expect(item.stopReason).toBe('stop')
    expect(item.blocks[0]).toEqual({ type: 'text', index: 0, text: 'Final answer', closed: true })
    expect(state.isStreaming).toBe(false)
  })

  it('keeps interleaved thinking and text blocks ordered by contentIndex', () => {
    const state = run([
      assistantStart,
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'hmm' },
      },
      textDelta('answer', 1),
    ])
    const item = state.items[0] as AssistantItem
    expect(item.blocks.map((b) => b.type)).toEqual(['thinking', 'text'])
  })
})

describe('chat reducer — tool calls', () => {
  const toolFlow: PiEvent[] = [
    assistantStart,
    {
      type: 'message_update',
      // The pi >= 0.84.3 wire shape: id + name on the event itself.
      assistantMessageEvent: {
        type: 'toolcall_start',
        contentIndex: 0,
        id: 'call_1',
        toolName: 'bash',
      },
    },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '{"command":' },
    },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '"ls -la"}' },
    },
    {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: {
          type: 'toolCall',
          id: 'call_1',
          name: 'bash',
          arguments: { command: 'ls -la' },
        },
      },
    },
  ]

  it('creates a tool block and streams args', () => {
    const state = run(toolFlow)
    const item = state.items[0] as AssistantItem
    expect(item.blocks[0]).toEqual({ type: 'tool', index: 0, toolCallId: 'call_1' })
    const tool = state.tools['call_1']!
    expect(tool.toolName).toBe('bash')
    expect(tool.argsText).toBe('{"command":"ls -la"}')
    expect(tool.args).toEqual({ command: 'ls -la' })
  })

  it('REPLACES output on tool_execution_update (accumulated partials)', () => {
    const state = run([
      ...toolFlow,
      {
        type: 'tool_execution_start',
        toolCallId: 'call_1',
        toolName: 'bash',
        args: { command: 'ls' },
      },
      {
        type: 'tool_execution_update',
        toolCallId: 'call_1',
        toolName: 'bash',
        args: {},
        partialResult: { content: [{ type: 'text', text: 'line1\n' }] },
      },
      {
        type: 'tool_execution_update',
        toolCallId: 'call_1',
        toolName: 'bash',
        args: {},
        partialResult: { content: [{ type: 'text', text: 'line1\nline2\n' }] },
      },
    ])
    const tool = state.tools['call_1']!
    expect(tool.status).toBe('running')
    expect(tool.output?.content).toEqual([{ type: 'text', text: 'line1\nline2\n' }])
  })

  it('finalizes on tool_execution_end with error styling', () => {
    const state = run([
      ...toolFlow,
      { type: 'tool_execution_start', toolCallId: 'call_1', toolName: 'bash', args: {} },
      {
        type: 'tool_execution_end',
        toolCallId: 'call_1',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'boom' }] },
        isError: true,
      },
    ])
    expect(state.tools['call_1']!.status).toBe('error')
    expect(state.tools['call_1']!.isError).toBe(true)
  })

  it('reconciles placeholder tool ids when toolcall_start lacks the id', () => {
    const state = run([
      assistantStart,
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0 },
      },
      {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'toolcall_end',
          contentIndex: 0,
          toolCall: { type: 'toolCall', id: 'real-id', name: 'grep', arguments: { pattern: 'x' } },
        },
      },
    ])
    const item = state.items[0] as AssistantItem
    expect(item.blocks[0]).toMatchObject({ type: 'tool', toolCallId: 'real-id' })
    expect(state.tools['real-id']!.toolName).toBe('grep')
    expect(Object.keys(state.tools)).toHaveLength(1)
  })
})

describe('chat reducer — queues, compaction, retry', () => {
  it('finalizes at agent_end when nothing signals a continuation (protocol without agent_settled)', () => {
    // Some pi builds/fixtures predate agent_settled. Without willRetry or a
    // pending queue entry, agent_end alone must still terminate the run —
    // otherwise a client that never receives agent_settled gets stuck
    // "streaming" forever.
    let state = reduceChatEvent(emptyChatSession(), { type: 'agent_start' })
    state = reduceChatEvent(state, { type: 'agent_end', messages: [] })
    expect(state.isStreaming).toBe(false)
    expect(state.agentStartedAt).toBeNull()
  })

  it('keeps the session active at agent_end and clears it only when fully settled', () => {
    let state = reduceChatEvent(emptyChatSession(), { type: 'agent_start' })
    state = {
      ...state,
      queues: { steering: ['queued steer'], followUp: [] },
    }

    state = reduceChatEvent(state, { type: 'agent_end', messages: [] })
    expect(state.isStreaming).toBe(true)
    expect(state.agentStartedAt).toEqual(expect.any(Number))
    expect(state.queues.steering).toEqual(['queued steer'])

    state = reduceChatEvent(state, { type: 'agent_settled' })
    expect(state.isStreaming).toBe(false)
    expect(state.agentStartedAt).toBeNull()
    expect(state.queues).toEqual({ steering: [], followUp: [] })
  })

  it('removes a steering chip when pi starts delivering that queued message', () => {
    const initial: ChatSessionState = {
      ...emptyChatSession(),
      isStreaming: true,
      queues: { steering: ['do X', 'do X'], followUp: ['then Y'] },
    }
    const state = reduceChatEvent(initial, {
      type: 'message_start',
      message: { role: 'user', content: 'do X' },
    })
    expect(state.queues).toEqual({ steering: ['do X'], followUp: ['then Y'] })
  })

  it('tracks queue_update', () => {
    const state = run([{ type: 'queue_update', steering: ['do X'], followUp: ['then Y'] }])
    expect(state.queues).toEqual({ steering: ['do X'], followUp: ['then Y'] })
  })

  it('adds a compaction divider with summary', () => {
    const state = run([
      { type: 'compaction_start', reason: 'threshold' },
      {
        type: 'compaction_end',
        reason: 'threshold',
        result: { summary: 'We did things', firstKeptEntryId: 'aa', tokensBefore: 1234 },
        aborted: false,
      },
    ])
    expect(state.isCompacting).toBe(false)
    expect(state.items[0]).toMatchObject({
      kind: 'divider',
      variant: 'compaction',
      summary: 'We did things',
      tokensBefore: 1234,
    })
  })

  it('tracks retry lifecycle and failure divider', () => {
    let state = run([
      {
        type: 'auto_retry_start',
        attempt: 2,
        maxAttempts: 3,
        delayMs: 4000,
        errorMessage: 'overloaded',
      },
    ])
    expect(state.retry).toMatchObject({ attempt: 2, maxAttempts: 3 })
    state = reduceChatEvent(state, {
      type: 'auto_retry_end',
      success: false,
      attempt: 3,
      finalError: 'still down',
    })
    expect(state.retry).toBeNull()
    expect(state.items.at(-1)).toMatchObject({ kind: 'divider', variant: 'error' })
  })
})

describe('chat reducer — agentStartedAt (working indicator)', () => {
  it('is null before any run starts', () => {
    expect(emptyChatSession().agentStartedAt).toBeNull()
  })

  it('sets a timestamp on agent_start and clears it once nothing continues', () => {
    let state = reduceChatEvent(emptyChatSession(), { type: 'agent_start' })
    expect(state.agentStartedAt).toEqual(expect.any(Number))
    expect(state.agentStartedAt).toBeGreaterThan(0)

    state = reduceChatEvent(state, { type: 'agent_end', messages: [] })
    expect(state.agentStartedAt).toBeNull()
  })

  it('keeps the timer running across agent_end when a retry is coming', () => {
    let state = reduceChatEvent(emptyChatSession(), { type: 'agent_start' })
    state = reduceChatEvent(state, { type: 'agent_end', messages: [], willRetry: true })
    expect(state.agentStartedAt).toEqual(expect.any(Number))
    expect(state.isStreaming).toBe(true)

    state = reduceChatEvent(state, { type: 'agent_settled' })
    expect(state.agentStartedAt).toBeNull()
  })

  it('keeps one continuous timer across a multi-step tool run', () => {
    // A run with several think-then-call rounds must NOT reset the timer
    // between message_start/message_end pairs — only agent_start/agent_settled
    // bracket it. This is what keeps the elapsed time counting through a
    // whole tool-heavy turn instead of restarting on every sub-step.
    const state = run([
      { type: 'agent_start' },
      assistantStart,
      { type: 'message_end', message: { role: 'assistant', content: [] } },
      assistantStart,
      { type: 'message_end', message: { role: 'assistant', content: [] } },
    ])
    expect(state.agentStartedAt).toEqual(expect.any(Number))
    expect(state.isStreaming).toBe(true)
  })
})

describe('chat reducer — user echo dedup', () => {
  it('marks the optimistic user item instead of duplicating on echo', () => {
    const withOptimistic: ChatSessionState = {
      ...emptyChatSession(),
      items: [{ id: 'u1', kind: 'user', text: 'hi there', optimistic: true }],
    }
    const state = reduceChatEvent(withOptimistic, {
      type: 'message_end',
      message: { role: 'user', content: 'hi there' },
    })
    expect(state.items).toHaveLength(1)
    expect(state.items[0]).toMatchObject({ kind: 'user', text: 'hi there', optimistic: false })
  })

  /** Rewind finds a message's entry by this timestamp (`matchRenderedUserMessage`). */
  it("takes pi's timestamp onto the confirmed item", () => {
    const withOptimistic: ChatSessionState = {
      ...emptyChatSession(),
      items: [{ id: 'u1', kind: 'user', text: 'hi there', optimistic: true }],
    }
    const state = reduceChatEvent(withOptimistic, {
      type: 'message_end',
      message: { role: 'user', content: 'hi there', timestamp: 1_758_800_000_123 },
    })
    expect(state.items[0]).toMatchObject({ optimistic: false, timestamp: 1_758_800_000_123 })
  })

  it('appends steering user messages that were not local', () => {
    const state = reduceChatEvent(emptyChatSession(), {
      type: 'message_end',
      message: { role: 'user', content: 'steered instruction' },
    })
    expect(state.items).toHaveLength(1)
    expect(state.items[0]).toMatchObject({ kind: 'user', text: 'steered instruction' })
  })
})

describe('chat reducer — extension-injected messages', () => {
  it('renders customMessage as an in-context item', () => {
    const state = reduceChatEvent(emptyChatSession(), {
      type: 'message_end',
      message: {
        role: 'customMessage',
        customType: 'pi-web-access',
        content: 'Fetched https://example.com',
        display: true,
      },
    })
    expect(state.items).toHaveLength(1)
    expect(state.items[0]).toMatchObject({
      kind: 'custom',
      customType: 'pi-web-access',
      text: 'Fetched https://example.com',
      inContext: true,
    })
  })

  it('renders custom (extension state) as NOT in context', () => {
    const state = reduceChatEvent(emptyChatSession(), {
      type: 'message_end',
      message: { role: 'custom', customType: 'my-ext', content: 'note', display: true },
    })
    expect(state.items[0]).toMatchObject({ kind: 'custom', inContext: false })
  })

  it('honors display:false by hiding the message', () => {
    const state = reduceChatEvent(emptyChatSession(), {
      type: 'message_end',
      message: { role: 'custom', customType: 'hidden-ext', content: 'internal', display: false },
    })
    expect(state.items).toHaveLength(0)
  })

  it('supports block content arrays with images', () => {
    const state = reduceChatEvent(emptyChatSession(), {
      type: 'message_end',
      message: {
        role: 'customMessage',
        customType: 'shot',
        display: true,
        content: [
          { type: 'text', text: 'A screenshot' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        ],
      },
    })
    expect(state.items[0]).toMatchObject({
      kind: 'custom',
      text: 'A screenshot',
      images: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
    })
  })

  it('hydrates extension messages from session history', () => {
    const state = hydrateFromMessages([
      { role: 'user', content: 'go' },
      { role: 'customMessage', customType: 'ext', content: 'injected context', display: true },
    ])
    expect(state.items.map((i) => i.kind)).toEqual(['user', 'custom'])
  })
})

describe('chat reducer — hydration', () => {
  it('rebuilds items and tools from get_messages history', () => {
    const state = hydrateFromMessages([
      { role: 'user', content: 'read the file' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'let me look' },
          { type: 'text', text: 'Reading now.' },
          { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.ts' } },
        ],
        stopReason: 'toolUse',
      },
      {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'read',
        content: [{ type: 'text', text: 'const x = 1' }],
        isError: false,
      },
      {
        role: 'bashExecution',
        command: 'ls',
        output: 'a.ts',
        exitCode: 0,
        cancelled: false,
        truncated: false,
      },
      { role: 'compactionSummary', summary: 'earlier stuff', tokensBefore: 999 },
    ])
    expect(state.items.map((i) => i.kind)).toEqual(['user', 'assistant', 'bash', 'divider'])
    const assistant = state.items[1] as AssistantItem
    expect(assistant.blocks.map((b) => b.type)).toEqual(['thinking', 'text', 'tool'])
    expect(state.tools['c1']).toMatchObject({ toolName: 'read', status: 'done' })
  })
})
