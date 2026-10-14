import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { HOST_LIMITS, parseHostFrame } from '@phosphor/shared/host-protocol'
import type { AgentMessage, PiEvent } from '@phosphor/shared/rpc'
import {
  createLaneProjection,
  type LaneProjection,
} from '@phosphor/session-runtime/lanes/projection'
import {
  emptyChatSession,
  hydrateFromMessages,
  reduceChatEvent,
  type ChatSessionState,
} from './reducer'

// Only generated item ids and local clock fields differ between viewers.
function normalized(state: ChatSessionState, messages: readonly AgentMessage[]): unknown {
  const settledCalls = new Set(
    messages.flatMap((message) =>
      message.role === 'assistant'
        ? message.content.filter((block) => block.type === 'toolCall').map((block) => block.id)
        : [],
    ),
  )
  const ids = new Map<string, string>()
  const json = JSON.stringify({
    ...state,
    agentStartedAt: undefined,
    promptSentAt: undefined,
    items: state.items.map((item, index) => ({
      ...item,
      id: `item-${index}`,
      ...(item.kind === 'assistant'
        ? {
            blocks: item.blocks.map((block) =>
              block.type === 'thinking'
                ? { ...block, startedAt: undefined, endedAt: undefined }
                : block,
            ),
          }
        : {}),
    })),
    tools: Object.fromEntries(
      Object.entries(state.tools).map(([id, tool]) => [
        id,
        {
          ...tool,
          startedAt: undefined,
          endedAt: undefined,
          // Once settled, hydration uses pi's recorded JSON, not streamed whitespace.
          argsText: settledCalls.has(id) ? JSON.parse(tool.argsText) : tool.argsText,
        },
      ]),
    ),
  })
  return JSON.parse(
    json.replace(/pending-ci-\d+-\d+/g, (id) => {
      if (!ids.has(id)) ids.set(id, `pending-generated-${ids.size}`)
      return ids.get(id) ?? id
    }),
  )
}

function equivalent(events: PiEvent[]) {
  const projection = createLaneProjection({
    now: () => 0,
    overflow: () => {
      throw new Error('overflow')
    },
  })
  let live = emptyChatSession()
  for (const [k, event] of events.entries()) {
    live = reduceChatEvent(live, event)
    projection.apply({ kind: 'event', event })
    assertCut(projection, live, `cut ${k + 1}: ${event.type}`)
  }
  return projection
}

function assertCut(projection: LaneProjection, live: ChatSessionState, label = 'cut') {
  const view = projection.view()
  const attached = view.pending.reduce(reduceChatEvent, hydrateFromMessages([...view.messages]))
  expect(normalized(attached, view.messages), label).toEqual(normalized(live, view.messages))
}
// Desktop's local resume hydrates the compacted transcript too. Reset only at settle.
function referenceAfterSettle(messages: AgentMessage[], tail: PiEvent[] = []): ChatSessionState {
  return tail.reduce(reduceChatEvent, hydrateFromMessages(messages))
}
function spacedTool(final = 1): PiEvent[] {
  const message: AgentMessage = {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'tool', name: 'read', arguments: { a: final } }],
  }
  return [
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_start',
        contentIndex: 0,
        id: 'tool',
        toolName: 'read',
      },
    },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: '{"a": 1}' },
    },
    {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { type: 'toolCall', id: 'tool', name: 'read', arguments: { a: final } },
      },
    },
    { type: 'message_end', message },
  ]
}

function captured(): PiEvent[] {
  return readFileSync(new URL('./__fixtures__/real-session-events.jsonl', import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .flatMap((line) => {
      const event: unknown = JSON.parse(line)
      const parsed = parseHostFrame(
        JSON.stringify({
          type: 'event',
          id: 's',
          laneId: '12345678-1234-4234-8234-123456789012',
          cursor: { epoch: '0123456789abcdef', seq: 1 },
          event: { kind: 'pi', push: { kind: 'event', event } },
        }),
      )
      return parsed.ok &&
        parsed.value.type === 'event' &&
        parsed.value.event.kind === 'pi' &&
        parsed.value.event.push.kind === 'event'
        ? [parsed.value.event.push.event]
        : []
    })
}

describe('remote snapshot equivalence', () => {
  it('matches the captured real pi stream at every cut', () => equivalent(captured()))

  it('keeps the captured tool arguments internally consistent', () => {
    const deltas = new Map<number, string>(),
      calls = new Map<string, unknown>()
    let count = 0
    for (const event of captured()) {
      if (event.type === 'message_start') deltas.clear()
      if (event.type === 'message_update') {
        const delta = event.assistantMessageEvent
        if (delta.type === 'toolcall_delta')
          deltas.set(delta.contentIndex, (deltas.get(delta.contentIndex) ?? '') + delta.delta)
        if (delta.type === 'toolcall_end' && delta.toolCall) {
          const parsed: unknown = JSON.parse(deltas.get(delta.contentIndex) ?? '')
          expect(parsed).toEqual(delta.toolCall.arguments)
          calls.set(delta.toolCall.id, parsed)
          count++
        }
      }
      if (event.type === 'message_end' && event.message.role === 'assistant')
        for (const block of event.message.content)
          if (block.type === 'toolCall') expect(calls.get(block.id)).toEqual(block.arguments)
    }
    expect(count).toBeGreaterThan(0)
  })
  it('compares settled arguments by JSON value, never ignores disagreement', () => {
    equivalent(spacedTool())
    expect(() => equivalent(spacedTool(2))).toThrow()
  })
  it('keeps live state through the compaction read window, resetting only at settle', () => {
    const events: PiEvent[] = [
      { type: 'message_end', message: { role: 'user', content: 'before' } },
      { type: 'agent_start' },
      { type: 'compaction_start', reason: 'manual' },
      {
        type: 'compaction_end',
        reason: 'manual',
        result: { summary: 'summary', firstKeptEntryId: 'entry', tokensBefore: 20 },
        aborted: false,
      },
      { type: 'queue_update', steering: ['next'], followUp: [] },
      { type: 'agent_start' },
    ]
    const p = equivalent(events)
    let live = events.reduce(reduceChatEvent, emptyChatSession())
    // A failed settle keeps this state and has no reference restart.
    assertCut(p, live, 'failed settle')
    const compacted: AgentMessage[] = [
      { role: 'compactionSummary', summary: 'summary', tokensBefore: 20 },
    ]
    p.settle(compacted, null)
    live = referenceAfterSettle(compacted, [
      { type: 'queue_update', steering: ['next'], followUp: [] },
      { type: 'agent_start' },
    ])
    assertCut(p, live, 'settled')
    const next: PiEvent = { type: 'agent_start' }
    p.apply({ kind: 'event', event: next })
    live = reduceChatEvent(live, next)
    assertCut(p, live, 'after settle')
  })
  it.each(['excluded', 'included', 'in-flight'] as const)(
    'reconciles a %s message across the settle barrier',
    (variant) => {
      const before: AgentMessage = { role: 'user', content: 'before' }
      const final: AgentMessage = { role: 'assistant', content: [{ type: 'text', text: 'after' }] }
      const compacted: AgentMessage = {
        role: 'compactionSummary',
        summary: 'compact',
        tokensBefore: 10,
      }
      const initial: PiEvent[] = [
        { type: 'message_end', message: before },
        { type: 'agent_start' },
        { type: 'compaction_start', reason: 'manual' },
        {
          type: 'compaction_end',
          reason: 'manual',
          result: { summary: 'compact', firstKeptEntryId: 'id', tokensBefore: 10 },
          aborted: false,
        },
      ]
      const p = equivalent(initial)
      p.markSettle()
      let live = initial.reduce(reduceChatEvent, emptyChatSession())
      const tail: PiEvent[] = [
        { type: 'message_start', message: { role: 'assistant', content: [] } },
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'after' },
        },
      ]
      for (const event of [
        ...tail,
        ...(variant === 'in-flight' ? [] : [{ type: 'message_end' as const, message: final }]),
      ]) {
        p.apply({ kind: 'event', event })
        live = reduceChatEvent(live, event)
        assertCut(p, live, 'read window')
      }
      p.settle([compacted, ...(variant === 'included' ? [final] : [])], null)
      const settled = [compacted, ...(variant === 'in-flight' ? [] : [final])]
      live = referenceAfterSettle(settled, [
        { type: 'agent_start' },
        ...(variant === 'in-flight' ? tail : []),
      ])
      assertCut(p, live, 'reconciled settle')
    },
  )
  it('reconciles repeated messages by ordered overlap, preserving multiplicity', () => {
    const message: AgentMessage = { role: 'user', content: 'same' }
    const p = equivalent([])
    p.markSettle()
    let live = emptyChatSession()
    for (let k = 0; k < 2; k++) {
      const event: PiEvent = { type: 'message_end', message }
      p.apply({ kind: 'event', event })
      live = reduceChatEvent(live, event)
      assertCut(p, live, `repeat ${k}`)
    }
    p.settle([message], null)
    expect(p.view().messages).toEqual([message, message])
    assertCut(p, live, 'repeated messages settled')
  })
  it.each(['before', 'after'] as const)(
    'reconciles a duplicate ending %s the read answer with full live state',
    (timing) => {
      const message: AgentMessage = { role: 'user', content: 'same' }
      const event: PiEvent = { type: 'message_end', message }
      const p = equivalent([event])
      let live = reduceChatEvent(emptyChatSession(), event)
      p.markSettle()
      if (timing === 'after') p.markRead()
      p.apply({ kind: 'event', event })
      live = reduceChatEvent(live, event)
      assertCut(p, live, 'duplicate before settle')
      if (timing === 'before') p.markRead()
      p.settle(timing === 'before' ? [message, message] : [message], null)
      expect(p.view().messages).toEqual([message, message])
      assertCut(p, live, 'duplicate after settle')
    },
  )
  it.each(['extension', 'retry'] as const)(
    'keeps %s error dividers and subsequent framing until settle',
    (kind) => {
      const message: AgentMessage =
        kind === 'extension'
          ? { role: 'user', content: 'next' }
          : { role: 'assistant', content: [{ type: 'text', text: 'next' }] }
      const events: PiEvent[] = [
        ...(kind === 'retry'
          ? [
              {
                type: 'auto_retry_start' as const,
                attempt: 1,
                maxAttempts: 1,
                delayMs: 1,
                errorMessage: 'retry',
              },
            ]
          : []),
        kind === 'extension'
          ? { type: 'extension_error', error: 'failed' }
          : { type: 'auto_retry_end', success: false, attempt: 1, finalError: 'failed' },
        { type: 'message_start', message },
        { type: 'message_end', message },
      ]
      const p = equivalent(events)
      let live = events.reduce(reduceChatEvent, emptyChatSession())
      assertCut(p, live, 'failed settle leaves barrier')
      p.settle([message], null)
      live = referenceAfterSettle([message])
      assertCut(p, live, 'error barrier settled')
      const next: PiEvent = { type: 'message_end', message: { role: 'user', content: 'later' } }
      p.apply({ kind: 'event', event: next })
      assertCut(p, reduceChatEvent(live, next), 'after error settle')
    },
  )
  it.each(['normal', 'error barrier'] as const)(
    'retains only unfinished parallel tool execution in %s mode',
    (mode) => {
      const calls: AgentMessage = {
        role: 'assistant',
        content: ['A', 'B'].map((id) => ({ type: 'toolCall', id, name: 'read', arguments: {} })),
      }
      const result: AgentMessage = {
        role: 'toolResult',
        toolCallId: 'A',
        toolName: 'read',
        content: [],
        isError: false,
      }
      const events: PiEvent[] = [
        ...(mode === 'error barrier'
          ? [{ type: 'extension_error' as const, error: 'failed' }]
          : []),
        { type: 'message_start', message: calls },
        { type: 'message_end', message: calls },
        ...['A', 'B'].map((toolCallId): PiEvent => ({
          type: 'tool_execution_start',
          toolCallId,
          toolName: 'read',
          args: {},
        })),
        {
          type: 'tool_execution_update',
          toolCallId: 'B',
          toolName: 'read',
          args: {},
          partialResult: { content: [{ type: 'text', text: 'partial' }] },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'A',
          toolName: 'read',
          result: { content: [] },
          isError: false,
        },
        { type: 'message_end', message: result },
        {
          type: 'tool_execution_update',
          toolCallId: 'B',
          toolName: 'read',
          args: {},
          partialResult: { content: [{ type: 'text', text: 'new partial' }] },
        },
      ]
      const p = equivalent(events)
      expect(
        p
          .view()
          .pending.filter((e) => 'toolCallId' in e)
          .map((e) => e.toolCallId),
      ).toEqual(['B', 'B'])
      if (mode === 'error barrier')
        expect(p.view().pending.filter((e) => e.type.startsWith('message_'))).toEqual(
          events.filter((e) => e.type.startsWith('message_')),
        )
      p.settle([calls, result], null)
      assertCut(p, referenceAfterSettle([calls, result]), 'parallel tools settled')
      const next: PiEvent = {
        type: 'tool_execution_update',
        toolCallId: 'B',
        toolName: 'read',
        args: {},
        partialResult: { content: [] },
      }
      p.apply({ kind: 'event', event: next })
      assertCut(
        p,
        reduceChatEvent(referenceAfterSettle([calls, result]), next),
        'after tools settle',
      )
    },
  )
  it('preserves streaming through overflow, discarded message end and refresh', () => {
    const overflow = { count: 0 }
    const p = createLaneProjection({
      now: () => 0,
      overflow: () => {
        overflow.count++
      },
    })
    const message: AgentMessage = { role: 'assistant', content: [{ type: 'text', text: 'final' }] }
    const events: PiEvent[] = [
      { type: 'agent_start' },
      { type: 'message_start', message: { role: 'assistant', content: [] } },
      {
        type: 'message_update',
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'x'.repeat(HOST_LIMITS.replayBytes),
        },
      },
      { type: 'message_end', message },
    ]
    let live = emptyChatSession()
    for (const [k, event] of events.entries()) {
      live = reduceChatEvent(live, event)
      p.apply({ kind: 'event', event })
      // The overflow cut is intentionally discarded; the final message restores its content.
      if (event.type !== 'message_update') assertCut(p, live, `overflow cut ${k}`)
    }
    expect(overflow.count).toBe(1)
    p.settle([message], null)
    assertCut(p, live, 'overflow refresh preserves full live state')
    const end: PiEvent = { type: 'agent_end', messages: [message] }
    p.apply({ kind: 'event', event: end })
    assertCut(p, reduceChatEvent(live, end), 'run ends after overflow')
  })
  it('keeps chat equivalent while a dialog opens and is answered', () => {
    const p = equivalent([{ type: 'agent_start' }])
    const live = reduceChatEvent(emptyChatSession(), { type: 'agent_start' })
    p.apply({
      kind: 'extension-ui',
      request: {
        type: 'extension_ui_request',
        id: 'dialog',
        method: 'confirm',
        title: 'confirm',
        message: '?',
      },
    })
    assertCut(p, live)
    expect(p.view().dialogs).toHaveLength(1)
    p.resolveDialog('dialog')
    assertCut(p, live)
    expect(p.view().dialogs).toHaveLength(0)
  })
  it('matches a steer queue', () =>
    equivalent([
      { type: 'agent_start' },
      { type: 'queue_update', steering: ['next'], followUp: [] },
      { type: 'agent_end', messages: [] },
      { type: 'message_start', message: { role: 'user', content: 'next' } },
      { type: 'message_end', message: { role: 'user', content: 'next' } },
      { type: 'agent_settled', aborted: false },
    ]))
  it('matches an auto-retry', () =>
    equivalent([
      { type: 'agent_start' },
      { type: 'agent_end', messages: [], willRetry: true },
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 100, errorMessage: 'retry' },
      { type: 'auto_retry_end', success: false, attempt: 1, finalError: 'failed' },
      { type: 'agent_settled', aborted: false },
    ]))
  it('matches compaction', () =>
    equivalent([
      { type: 'agent_start' },
      { type: 'compaction_start', reason: 'manual' },
      {
        type: 'compaction_end',
        reason: 'manual',
        result: { summary: 'summary', firstKeptEntryId: 'entry', tokensBefore: 20 },
        aborted: false,
      },
      { type: 'agent_settled', aborted: false },
    ]))
  it('coalesces 4,001 toolcall deltas without overflowing', () => {
    let overflows = 0
    const p = createLaneProjection({
      now: () => 0,
      overflow: () => {
        overflows++
      },
    })
    p.apply({
      kind: 'event',
      event: { type: 'message_start', message: { role: 'assistant', content: [] } },
    })
    for (let k = 0; k < 4001; k++)
      p.apply({
        kind: 'event',
        event: {
          type: 'message_update',
          assistantMessageEvent: { type: 'toolcall_delta', contentIndex: 0, delta: 'x' },
        },
      })
    expect(overflows).toBe(0)
    expect(p.view().pending).toHaveLength(2)
    expect(p.view().pending[1]).toMatchObject({
      assistantMessageEvent: { type: 'toolcall_delta', delta: 'x'.repeat(4001) },
    })
  })
  it.each(['normal', 'barrier'] as const)(
    'discards overflowed updates without orphan framing in %s mode',
    (mode) => {
      let overflows = 0
      const p = createLaneProjection({
        now: () => 0,
        overflow: () => {
          overflows++
        },
      })
      const before: AgentMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: 'before' }],
      }
      const final: AgentMessage = { role: 'assistant', content: [{ type: 'text', text: 'full' }] }
      const step = (event: PiEvent) => {
        p.apply({ kind: 'event', event })
        let started = false
        for (const pending of p.view().pending) {
          if (pending.type === 'message_start') started = true
          if (pending.type === 'message_end') started = false
          if (pending.type === 'message_update') expect(started).toBe(true)
        }
      }
      step({ type: 'message_end', message: before })
      step({ type: 'agent_start' })
      if (mode === 'barrier') step({ type: 'compaction_start', reason: 'manual' })
      step({ type: 'message_start', message: { role: 'assistant', content: [] } })
      step({
        type: 'message_update',
        assistantMessageEvent: {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'x'.repeat(HOST_LIMITS.replayBytes),
        },
      })
      expect(overflows).toBe(1)
      expect(p.activity()).toBe('working')
      step({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'more' },
      })
      expect(p.view().pending.some((event) => event.type === 'message_update')).toBe(false)
      step({ type: 'message_end', message: final })
      const view = p.view()
      if (mode === 'normal') expect(view.messages).toEqual([before, final])
      else expect(view.pending.at(-1)).toEqual({ type: 'message_end', message: final })
      const attached = view.pending.reduce(reduceChatEvent, hydrateFromMessages([...view.messages]))
      expect(attached.items).toHaveLength(2)
      expect(attached.items[0]).toMatchObject({
        kind: 'assistant',
        blocks: [{ type: 'text', text: 'before' }],
      })
      expect(attached.items[1]).toMatchObject({
        kind: 'assistant',
        blocks: [{ type: 'text', text: 'full' }],
      })
    },
  )
  it('coalesces 10,000 deltas and matches every cut', () => {
    const delta: PiEvent = {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x' },
    }
    const projection = equivalent([
      { type: 'agent_start' },
      { type: 'message_start', message: { role: 'assistant', content: [] } },
      ...Array.from({ length: 10_000 }, () => delta),
    ])
    expect(projection.view().pending.length).toBeLessThanOrEqual(3)
    const final: PiEvent = {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(10_000) }] },
    }
    const live = projection.view().pending.reduce(reduceChatEvent, emptyChatSession())
    projection.apply({ kind: 'event', event: final })
    assertCut(projection, reduceChatEvent(live, final))
  })
})
