import { describe, expect, it, vi } from 'vitest'
import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import type { AgentMessage, ExtensionUIRequest, PiEvent } from '@phosphor/shared/rpc'
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

describe('lane projection characterization', () => {
  it('deduplicates same-chunk read overlap by canonical nested value including timestamp', () => {
    const { projection: p, event } = setup()
    const recorded: AgentMessage = {
      role: 'user',
      content: [{ type: 'text', text: 'same' }],
      timestamp: 123,
    }
    p.markSettle()
    event({ type: 'message_end', message: recorded })
    p.markRead()
    const read: AgentMessage = {
      timestamp: 123,
      content: [{ text: 'same', type: 'text' }],
      role: 'user',
    }
    p.settle([read], null)
    expect(p.view().messages).toEqual([read])
    p.markSettle()
    event({ type: 'message_end', message: { ...recorded, timestamp: 124 } })
    p.markRead()
    p.settle([read], null)
    expect(p.view().messages).toEqual([read, { ...recorded, timestamp: 124 }])
  })

  it('matches only pre-read overlap and keeps a post-read duplicate', () => {
    const { projection: p, event } = setup()
    const message: AgentMessage = { role: 'user', content: 'same', timestamp: 1 }
    p.markSettle()
    event({ type: 'message_end', message })
    p.markRead()
    event({ type: 'message_end', message })
    p.settle([message], null)
    expect(p.view().messages).toEqual([message, message])
    p.markSettle()
    p.markRead()
    p.markSettle()
    event({ type: 'message_end', message })
    p.settle([message], null)
    expect(p.view().messages).toEqual([message])
  })

  it('holds compaction replay until compaction ends and a refresh lifts the barrier', () => {
    const { projection: p, event } = setup()
    const run: PiEvent = { type: 'agent_start' }
    const start: PiEvent = { type: 'compaction_start', reason: 'manual' }
    const message: AgentMessage = { role: 'user', content: 'during compaction' }
    const end: PiEvent = {
      type: 'compaction_end',
      reason: 'manual',
      result: null,
      aborted: false,
    }
    event(run)
    event(start)
    p.markSettle()
    event({ type: 'message_end', message })
    p.settle([], null)
    expect(p.view().messages).toEqual([])
    expect(p.view().pending).toEqual([run, start, { type: 'message_end', message }])
    expect(p.activity()).toBe('working')
    event(end)
    p.settle([message], null)
    expect(p.view().messages).toEqual([message])
    expect(p.view().pending).toEqual([run])
  })

  it('replaces duplicate tool updates and removes their execution events on result', () => {
    const { projection: p, event } = setup()
    const start: PiEvent = {
      type: 'tool_execution_start',
      toolCallId: 'a',
      toolName: 'read',
      args: {},
    }
    const update: PiEvent = {
      type: 'tool_execution_update',
      toolCallId: 'a',
      toolName: 'read',
      args: {},
      partialResult: { content: [{ type: 'text', text: 'latest' }] },
    }
    event(start)
    event({ ...update, partialResult: { content: [] } })
    event(update)
    expect(p.view().pending).toEqual([start, update])
    const message: AgentMessage = {
      role: 'toolResult',
      toolCallId: 'a',
      toolName: 'read',
      content: [],
      isError: false,
    }
    event({ type: 'message_end', message })
    expect(p.view().pending).toEqual([])
    expect(p.view().messages).toEqual([message])
  })

  it('discards partial message updates after byte overflow until message end', () => {
    const { projection: p, event, overflow } = setup()
    event({ type: 'agent_start' })
    event({ type: 'message_start', message: { role: 'assistant', content: [] } })
    event({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'text_delta',
        contentIndex: 0,
        delta: 'é'.repeat(HOST_LIMITS.replayBytes),
      },
    })
    expect(overflow).toHaveBeenCalledOnce()
    expect(p.view().pending).toEqual([{ type: 'agent_start' }])
    event({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'ignored' },
    })
    expect(p.view().pending).toEqual([{ type: 'agent_start' }])
    const message: AgentMessage = { role: 'assistant', content: [{ type: 'text', text: 'full' }] }
    event({ type: 'message_end', message })
    expect(p.view().messages).toEqual([message])
    const next: PiEvent = { type: 'message_start', message: { role: 'assistant', content: [] } }
    event(next)
    expect(p.view().pending).toEqual([{ type: 'agent_start' }, next])
  })

  it.each(['setStatus', 'setWidget'] as const)('caps, replaces and clears %s keys', (method) => {
    const { projection: p, ui, overflow } = setup()
    const limit = method === 'setStatus' ? HOST_LIMITS.uiStatusKeys : HOST_LIMITS.uiWidgetKeys
    const request = (key: string, text?: string): ExtensionUIRequest =>
      method === 'setStatus'
        ? { type: 'extension_ui_request', id: key, method, statusKey: key, statusText: text }
        : {
            type: 'extension_ui_request',
            id: key,
            method,
            widgetKey: key,
            widgetLines: text ? [text] : [],
          }
    for (let i = 0; i < limit; i++) ui(request(`${i}`, 'value'))
    ui(request('0', 'replaced'))
    expect(p.view().ui).toHaveLength(limit)
    expect(p.view().ui[0]).toEqual(request('0', 'replaced'))
    expect(overflow).not.toHaveBeenCalled()
    ui(request('extra', 'value'))
    expect(overflow).toHaveBeenCalledOnce()
    expect(p.view().ui).toHaveLength(limit)
    ui(request('0'))
    ui(request('extra', 'value'))
    expect(p.view().ui).toHaveLength(limit)
    expect(p.view().ui.at(-1)).toEqual(request('extra', 'value'))
    ui({ type: 'extension_ui_request', id: 't1', method: 'setTitle', title: 'old' })
    ui({ type: 'extension_ui_request', id: 't2', method: 'setTitle', title: 'new' })
    expect(p.view().ui.at(-1)).toMatchObject({ title: 'new' })
  })

  it('expires dialogs at their deadline with input taking precedence over work', () => {
    const { projection: p, event, ui, time } = setup()
    event({ type: 'agent_start' })
    ui({ type: 'extension_ui_request', id: 'ask', method: 'input', title: 'ask', timeout: 10 })
    expect(p.activity()).toBe('needs-input')
    time(9)
    expect(p.view().dialogs).toHaveLength(1)
    time(10)
    expect(p.activity()).toBe('working')
    expect(p.view().dialogs).toEqual([])
    ui({ type: 'extension_ui_request', id: 'edit', method: 'editor', title: 'edit' })
    time(100)
    expect(p.activity()).toBe('needs-input')
    p.resolveDialog('edit')
    event({ type: 'agent_settled', aborted: false })
    expect(p.activity()).toBe('idle')
    p.apply({ kind: 'exit', code: 1, signal: null, expected: false })
    expect(p.activity()).toBe('failed')
  })
})
