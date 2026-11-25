import { afterEach, describe, expect, it, vi } from 'vitest'
import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import type { AgentMessage, PiEvent, ToolResultMessage } from '@phosphor/shared/rpc'
import { createLaneProjection } from './projection'

const limit = HOST_LIMITS.replayBytes
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length

const delta = (text: string, contentIndex = 0): PiEvent => ({
  type: 'message_update',
  assistantMessageEvent: { type: 'text_delta', contentIndex, delta: text },
})
const assistantStart: PiEvent = {
  type: 'message_start',
  message: { role: 'assistant', content: [] },
}
const toolResult = (toolCallId: string, text: string): ToolResultMessage => ({
  role: 'toolResult',
  toolCallId,
  toolName: 'read',
  content: [{ type: 'text', text }],
  isError: false,
})
const toolUpdate = (toolCallId: string, text: string): PiEvent => ({
  type: 'tool_execution_update',
  toolCallId,
  toolName: 'read',
  args: {},
  partialResult: { content: [{ type: 'text', text }] },
})

function setup() {
  const overflow = vi.fn()
  const projection = createLaneProjection({ now: () => 0, overflow })
  const event = (e: PiEvent) => projection.apply({ kind: 'event', event: e })
  const pendingBytes = () => bytes(projection.view().pending)
  /** Grows the last pending text delta (or starts one) to exactly `target` bytes. */
  const fillTo = (target: number, text = 'a') => {
    event(delta(''))
    const gap = target - pendingBytes()
    expect(gap).toBeGreaterThanOrEqual(0)
    const unit = bytes(text) - 2
    event(delta(text.repeat(Math.floor(gap / unit)) + 'a'.repeat(gap % unit)))
    expect(pendingBytes()).toBe(target)
  }
  /** The bound allows exactly the limit and trips on the next byte. */
  const expectTripsOnePastLimit = (text = 'a') => {
    const calls = overflow.mock.calls.length
    fillTo(limit, text)
    expect(overflow).toHaveBeenCalledTimes(calls)
    event(delta('a'))
    expect(overflow).toHaveBeenCalledTimes(calls + 1)
  }
  return { projection, overflow, event, pendingBytes, fillTo, expectTripsOnePastLimit }
}

describe('lane projection byte bound', () => {
  afterEach(() => vi.restoreAllMocks())

  it('trips one byte past the limit while merging adjacent text deltas', () => {
    const h = setup()
    h.event({ type: 'agent_start' })
    h.event(assistantStart)
    h.expectTripsOnePastLimit()
    expect(h.projection.view().pending).toEqual([{ type: 'agent_start' }])
  })

  it.each([
    ['two-byte', 'é'],
    ['three-byte', '€'],
    ['four-byte', '😀'],
    ['escaped', '"\\\n\u0001'],
    ['mixed', 'aé€😀"\n\u0001'],
  ])('counts %s UTF-8 text exactly at the limit', (_name, text) => {
    const h = setup()
    h.event({ type: 'agent_start' })
    h.event(assistantStart)
    h.expectTripsOnePastLimit(text)
  })

  it('trips when a multi-byte character crosses the limit by less than its width', () => {
    const h = setup()
    h.event({ type: 'agent_start' })
    h.event(assistantStart)
    h.fillTo(limit - 1)
    h.event(delta('é'))
    expect(h.overflow).toHaveBeenCalledOnce()
  })

  it('counts split surrogate pairs exactly at the limit', () => {
    const h = setup()
    h.event({ type: 'agent_start' })
    h.event(assistantStart)
    h.fillTo(limit - 12)
    h.event(delta('\ud83d'))
    h.event(delta(''))
    h.event(delta('\ude00'))
    expect(h.pendingBytes()).toBe(limit - 8)
    h.event(delta('a'))
    expect(h.pendingBytes()).toBe(limit - 7)
    h.event(delta('a'.repeat(7)))
    expect(h.pendingBytes()).toBe(limit)
    expect(h.overflow).not.toHaveBeenCalled()
    h.event(delta('a'))
    expect(h.overflow).toHaveBeenCalledOnce()
  })

  it('sizes a merge that inserts a missing delta field from an unchecked wire event', () => {
    const h = setup()
    h.fillTo(limit - 'undefined'.length)
    h.event({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0 },
    } as PiEvent)
    expect(h.pendingBytes()).toBe(limit)
    expect(h.overflow).not.toHaveBeenCalled()
    h.event(delta('a'))
    expect(h.overflow).toHaveBeenCalledOnce()
  })

  it('isolates cached queue bytes from mutations to the pending view', () => {
    const h = setup()
    h.event({ type: 'queue_update', steering: [], followUp: [] })
    const [queue] = h.projection.view().pending
    if (queue?.type !== 'queue_update') throw new Error('expected a pending queue update')
    queue.steering.push('q'.repeat(limit))
    h.event({ type: 'turn_start' })
    expect(h.overflow).not.toHaveBeenCalled()
    expect(h.projection.view().pending[0]).toMatchObject({ steering: [] })
  })

  it('isolates cached bytes from mutations to a retained apply input', () => {
    const h = setup()
    const partialResult = { content: [{ type: 'text' as const, text: 'original' }] }
    h.event({
      type: 'tool_execution_update',
      toolCallId: 'a',
      toolName: 'read',
      args: {},
      partialResult,
    })
    partialResult.content[0]!.text = 'r'.repeat(limit)
    h.event({ type: 'turn_start' })
    expect(h.overflow).not.toHaveBeenCalled()
    expect(h.projection.view().pending[0]).toMatchObject({
      partialResult: { content: [{ type: 'text', text: 'original' }] },
    })
  })

  it('isolates the pending view array while a barrier holds', () => {
    const h = setup()
    h.event({ type: 'compaction_start', reason: 'manual' })
    h.event({ type: 'turn_start' })
    h.projection.view().pending.length = 0
    expect(h.projection.view().pending.map((e) => e.type)).toEqual([
      'compaction_start',
      'turn_start',
    ])
    h.expectTripsOnePastLimit()
  })

  it('keeps merges of different blocks and kinds as separate entries', () => {
    const h = setup()
    h.event({ type: 'agent_start' })
    h.event(assistantStart)
    h.event({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'think' },
    })
    h.event(delta('first', 1))
    h.event(delta('x'.repeat(1000), 2))
    h.expectTripsOnePastLimit()
  })

  it('counts a merged delta by its own envelope, not the one it extends', () => {
    const h = setup()
    const withUsage = (text: string): PiEvent => ({
      type: 'message_update',
      usage: {
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        totalTokens: 10,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text },
    })
    h.event({ type: 'agent_start' })
    h.event(assistantStart)
    h.event(withUsage('with usage'))
    h.fillTo(limit - (bytes(withUsage('')) - bytes(delta(''))))
    h.event(withUsage(''))
    expect(h.pendingBytes()).toBe(limit)
    expect(h.overflow).not.toHaveBeenCalled()
    h.event(withUsage('a'))
    expect(h.overflow).toHaveBeenCalledOnce()
  })

  it('frees a replaced tool update and counts its replacement', () => {
    const h = setup()
    h.event({ type: 'agent_start' })
    h.event({ type: 'tool_execution_start', toolCallId: 'a', toolName: 'read', args: {} })
    h.event(toolUpdate('b', 'other'))
    const base = h.pendingBytes() + 1 + bytes(toolUpdate('a', ''))
    const big = toolUpdate('a', 'x'.repeat(limit - base - 1))
    h.event(big)
    expect(h.pendingBytes()).toBe(limit - 1)
    h.event(toolUpdate('a', 'y'.repeat(limit - base)))
    expect(h.pendingBytes()).toBe(limit)
    expect(h.overflow).not.toHaveBeenCalled()
    h.event(toolUpdate('a', 'small'))
    h.expectTripsOnePastLimit()
  })

  it('frees an ended message and the previous turn before the next message', () => {
    const h = setup()
    h.event({ type: 'agent_start' })
    h.event(assistantStart)
    h.fillTo(limit - 100)
    h.event({ type: 'message_end', message: { role: 'assistant', content: [] } })
    h.event({
      type: 'turn_end',
      message: { role: 'assistant', content: [] },
      toolResults: [toolResult('a', 'r'.repeat(4 * 1024 * 1024))],
    })
    h.event(assistantStart)
    h.expectTripsOnePastLimit()
    h.event({ type: 'message_end', message: { role: 'assistant', content: [] } })
    h.event(assistantStart)
    h.expectTripsOnePastLimit()
  })

  it('frees tool execution events on their result', () => {
    const h = setup()
    h.event({ type: 'agent_start' })
    h.event({ type: 'tool_execution_start', toolCallId: 'a', toolName: 'read', args: {} })
    h.event(toolUpdate('a', 'u'.repeat(6 * 1024 * 1024)))
    h.event({ type: 'message_end', message: toolResult('a', 'done') })
    h.event(assistantStart)
    h.expectTripsOnePastLimit()
  })

  it('starts counting again from the reset state after an overflow', () => {
    const h = setup()
    h.event({ type: 'agent_start' })
    h.event({ type: 'queue_update', steering: ['q'.repeat(1000)], followUp: [] })
    h.event({
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 2,
      delayMs: 1,
      errorMessage: 'e'.repeat(1000),
    })
    h.event(assistantStart)
    h.expectTripsOnePastLimit()
    expect(h.projection.view().pending).toEqual([{ type: 'agent_start' }])
    h.event({ type: 'message_end', message: { role: 'assistant', content: [] } })
    h.event(assistantStart)
    h.expectTripsOnePastLimit()
  })

  it('counts the replacement queue after a queued message is consumed', () => {
    const h = setup()
    h.event({ type: 'agent_start' })
    h.event({ type: 'queue_update', steering: ['s'.repeat(4 * 1024 * 1024), 'b'], followUp: [] })
    h.event({
      type: 'message_end',
      message: { role: 'user', content: 's'.repeat(4 * 1024 * 1024) },
    })
    h.event({ type: 'queue_update', steering: ['c'.repeat(1000)], followUp: ['d'] })
    h.event({ type: 'message_end', message: { role: 'user', content: 'd' } })
    h.event(assistantStart)
    h.expectTripsOnePastLimit()
  })

  it('bounds the barrier, including the message start it rebuilds after discarding', () => {
    const h = setup()
    h.event({ type: 'agent_start' })
    h.event({ type: 'compaction_start', reason: 'manual' })
    h.event(assistantStart)
    h.expectTripsOnePastLimit()
    expect(h.projection.view().pending).toEqual([{ type: 'agent_start' }])
    const message: AgentMessage = { role: 'assistant', content: [{ type: 'text', text: 'm' }] }
    h.event({ type: 'message_end', message })
    expect(h.projection.view().pending.map((e) => e.type)).toEqual([
      'agent_start',
      'message_start',
      'message_end',
    ])
    h.event(assistantStart)
    h.expectTripsOnePastLimit()
  })

  it('frees barrier tool events on their result and resets on settle', () => {
    const h = setup()
    h.event({ type: 'agent_start' })
    h.event({ type: 'compaction_start', reason: 'manual' })
    h.event({ type: 'tool_execution_start', toolCallId: 'a', toolName: 'read', args: {} })
    h.event(toolUpdate('a', 'u'.repeat(6 * 1024 * 1024)))
    h.event({ type: 'message_end', message: toolResult('a', 'done') })
    h.event(assistantStart)
    h.expectTripsOnePastLimit()
    h.event({ type: 'message_end', message: { role: 'assistant', content: [] } })
    h.event({ type: 'compaction_end', reason: 'manual', result: null, aborted: false })
    h.event({ type: 'tool_execution_start', toolCallId: 'b', toolName: 'read', args: {} })
    h.event(toolUpdate('b', 'v'.repeat(6 * 1024 * 1024)))
    h.projection.settle([], null)
    expect(h.projection.view().pending).toEqual([{ type: 'agent_start' }])
    h.event(assistantStart)
    h.expectTripsOnePastLimit()
  })

  it('resets the count when the process exits', () => {
    const h = setup()
    h.event({ type: 'agent_start' })
    h.event(assistantStart)
    h.fillTo(limit - 10)
    h.projection.apply({ kind: 'exit', code: 0, signal: null, expected: true })
    h.event({ type: 'agent_start' })
    h.event(assistantStart)
    h.expectTripsOnePastLimit()
  })

  /** Characters JSON.stringify produces while `run` executes. */
  function serializedDuring(run: () => void): number {
    const stringify = JSON.stringify
    let serialized = 0
    vi.spyOn(JSON, 'stringify').mockImplementation((...args: Parameters<typeof stringify>) => {
      const text = stringify(...args)
      serialized += text.length
      return text
    })
    try {
      run()
    } finally {
      vi.restoreAllMocks()
    }
    return serialized
  }
  const previousTurn = (): PiEvent => ({
    type: 'turn_end',
    message: { role: 'assistant', content: [] },
    toolResults: [toolResult('a', 'r'.repeat(2 * 1024 * 1024))],
  })

  it('does per-delta work independent of the bytes already pending', () => {
    const h = setup()
    h.event({ type: 'agent_start' })
    h.event(previousTurn())
    h.event(assistantStart)
    const serialized = serializedDuring(() => {
      for (let i = 0; i < 100; i++) h.event(delta('d'.repeat(100)))
    })
    expect(h.overflow).not.toHaveBeenCalled()
    expect(serialized).toBeLessThan(100 * 1024)
  })

  it('does per-delta work independent of the bytes already behind a barrier', () => {
    const h = setup()
    h.event({ type: 'agent_start' })
    h.event({ type: 'compaction_start', reason: 'threshold' })
    h.event(previousTurn())
    h.event(assistantStart)
    const serialized = serializedDuring(() => {
      for (let i = 0; i < 100; i++) h.event(delta('d'.repeat(100)))
    })
    expect(h.overflow).not.toHaveBeenCalled()
    expect(serialized).toBeLessThan(100 * 1024)
  })

  it('does per-tool-update work independent of the bytes already pending', () => {
    const h = setup()
    h.event({ type: 'agent_start' })
    h.event(previousTurn())
    h.event({ type: 'tool_execution_start', toolCallId: 'b', toolName: 'read', args: {} })
    const serialized = serializedDuring(() => {
      for (let i = 0; i < 100; i++) h.event(toolUpdate('b', 'u'.repeat(100 + i)))
    })
    expect(h.overflow).not.toHaveBeenCalled()
    expect(serialized).toBeLessThan(100 * 1024)
  })
})
