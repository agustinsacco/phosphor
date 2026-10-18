import { describe, expect, it, vi } from 'vitest'
import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import type {
  AgentMessage,
  ExtensionUIRequest,
  PiEvent,
  RpcSessionState,
} from '@phosphor/shared/rpc'
import { createLaneProjection } from './projection'

function setup() {
  let now = 0
  const overflow = vi.fn()
  const projection = createLaneProjection({ now: () => now, overflow })
  return {
    projection,
    overflow,
    event: (event: PiEvent) => projection.apply({ kind: 'event', event }),
    ui: (request: ExtensionUIRequest) => projection.apply({ kind: 'extension-ui', request }),
    time: (value: number) => {
      now = value
    },
  }
}

function session(): RpcSessionState {
  return {
    sessionId: 'resumed',
    thinkingLevel: 'off',
    isStreaming: false,
    isCompacting: false,
    steeringMode: 'all',
    followUpMode: 'all',
    autoCompactionEnabled: true,
    messageCount: 1,
    pendingMessageCount: 0,
  }
}

describe('lane projection state transitions', () => {
  it('removes one steering match before follow-up using concatenated user text', () => {
    const { projection: p, event } = setup()
    event({ type: 'queue_update', steering: ['same', 'same'], followUp: ['same'] })
    const consume = () =>
      event({
        type: 'message_end',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'sa' },
            { type: 'text', text: 'me' },
          ],
        },
      })
    consume()
    expect(p.view().pending).toEqual([
      { type: 'queue_update', steering: ['same'], followUp: ['same'] },
    ])
    consume()
    expect(p.view().pending).toEqual([{ type: 'queue_update', steering: [], followUp: ['same'] }])
    consume()
    consume()
    expect(p.view().pending).toEqual([{ type: 'queue_update', steering: [], followUp: [] }])
  })

  it('orders merged deltas and replacement queues by their latest event sequence', () => {
    const { projection: p, event } = setup()
    const run: PiEvent = { type: 'agent_start' }
    const queue: PiEvent = { type: 'queue_update', steering: ['sent'], followUp: [] }
    const retry: PiEvent = {
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 2,
      delayMs: 10,
      errorMessage: 'retry',
    }
    const delta: PiEvent = {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'a' },
    }
    event(run)
    event(queue)
    event(delta)
    event(retry)
    event(delta)
    expect(p.view().pending).toEqual([
      run,
      queue,
      retry,
      { ...delta, assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'aa' } },
    ])
    event({ type: 'message_end', message: { role: 'user', content: 'sent' } })
    expect(p.view().pending).toEqual([
      run,
      retry,
      { type: 'queue_update', steering: [], followUp: [] },
    ])
  })

  it('restores an assistant start after a barrier overflow discarded its partial message', () => {
    const { projection: p, event, overflow } = setup()
    const run: PiEvent = { type: 'agent_start' }
    event(run)
    event({ type: 'extension_error', error: 'divider' })
    event({ type: 'message_start', message: { role: 'assistant', content: [] } })
    event({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'x'.repeat(HOST_LIMITS.replayBytes),
      },
    })
    expect(overflow).toHaveBeenCalledOnce()
    expect(p.view().pending).toEqual([run])
    const message: AgentMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }] }
    event({ type: 'message_end', message })
    expect(p.view().messages).toEqual([])
    expect(p.view().pending).toEqual([
      run,
      { type: 'message_start', message },
      { type: 'message_end', message },
    ])
    p.settle([message], null)
    expect(p.view().messages).toEqual([message])
    expect(p.view().pending).toEqual([run])
  })

  it('removes only matching tool execution events from a replay barrier', () => {
    const { projection: p, event } = setup()
    const divider: PiEvent = { type: 'extension_error', error: 'divider' }
    const first: PiEvent = {
      type: 'tool_execution_start',
      toolCallId: 'a',
      toolName: 'read',
      args: {},
    }
    const second: PiEvent = { ...first, toolCallId: 'b' }
    const message: AgentMessage = {
      role: 'toolResult',
      toolCallId: 'a',
      toolName: 'read',
      content: [],
      isError: false,
    }
    event(divider)
    event(first)
    event(second)
    event({ type: 'message_end', message })
    expect(p.view().pending).toEqual([divider, second, { type: 'message_end', message }])
    expect(p.view().messages).toEqual([])
    p.settle([message], null)
    expect(p.view().pending).toEqual([])
    expect(p.view().messages).toEqual([message])
  })

  it('clears transient exit state but retains transcript and persistent UI until resumed', () => {
    const { projection: p, event, ui } = setup()
    const message: AgentMessage = { role: 'user', content: 'saved' }
    p.settle([message], session())
    const status: ExtensionUIRequest = {
      type: 'extension_ui_request',
      id: 'status',
      method: 'setStatus',
      statusKey: 'key',
      statusText: 'ok',
    }
    ui(status)
    ui({ type: 'extension_ui_request', id: 'ask', method: 'editor', title: 'ask' })
    event({ type: 'agent_start' })
    event({ type: 'queue_update', steering: ['queued'], followUp: [] })
    event({ type: 'compaction_start', reason: 'manual' })
    p.markSettle()
    p.markRead()
    event({ type: 'message_end', message: { role: 'user', content: 'not saved' } })
    p.apply({ kind: 'exit', code: 1, signal: null, expected: false })
    expect(p.view()).toEqual({
      state: null,
      messages: [message],
      pending: [],
      dialogs: [],
      ui: [status],
    })
    expect(p.activity()).toBe('failed')
    p.setState(session())
    expect(p.activity()).toBe('failed')
    p.settle([message], session())
    expect(p.view().messages).toEqual([message])
    expect(p.activity()).toBe('idle')
    event({ type: 'agent_start' })
    expect(p.activity()).toBe('working')
    expect(p.view().pending).toEqual([{ type: 'agent_start' }])
  })

  it('isolates slots, UI maps, reconciliation marks and clocks between projections', () => {
    const a = setup(),
      b = setup()
    const message: AgentMessage = { role: 'user', content: 'a' }
    a.projection.markSettle()
    a.event({ type: 'message_end', message })
    a.event({ type: 'agent_start' })
    a.ui({ type: 'extension_ui_request', id: 'ask', method: 'input', title: 'a', timeout: 10 })
    b.ui({ type: 'extension_ui_request', id: 'ask', method: 'input', title: 'b', timeout: 10 })
    a.time(10)
    expect(a.projection.activity()).toBe('working')
    expect(b.projection.activity()).toBe('needs-input')
    a.projection.settle([], null)
    b.projection.settle([], null)
    expect(a.projection.view().messages).toEqual([message])
    expect(b.projection.view().messages).toEqual([])
    expect(b.projection.view().pending).toEqual([])
    expect(b.projection.view().dialogs).toMatchObject([{ title: 'b' }])
    a.projection.apply({ kind: 'exit', code: 0, signal: null, expected: false })
    expect(a.projection.activity()).toBe('stopped')
    expect(b.projection.activity()).toBe('needs-input')
  })

  it('returns fresh view arrays for transcript, non-barrier pending, dialogs and UI', () => {
    const { projection: p, event, ui } = setup()
    const message: AgentMessage = { role: 'user', content: 'saved' }
    p.settle([message], null)
    event({ type: 'turn_start' })
    ui({ type: 'extension_ui_request', id: 'ask', method: 'editor', title: 'ask' })
    ui({ type: 'extension_ui_request', id: 'title', method: 'setTitle', title: 'title' })
    const before = p.view()
    const after = p.view()
    expect(after.messages).not.toBe(before.messages)
    expect(after.pending).not.toBe(before.pending)
    expect(after.dialogs).not.toBe(before.dialogs)
    expect(after.ui).not.toBe(before.ui)
    expect(after).toEqual(before)
  })
})
