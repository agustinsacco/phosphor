import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import type { ExtensionUIRequest, PiEvent } from '@phosphor/shared/rpc'
import { createLaneProjection } from './projection'

function setup() {
  let now = 0
  const overflow = vi.fn()
  const projection = createLaneProjection({ now: () => now, overflow })
  const event = (event: PiEvent) => projection.apply({ kind: 'event', event })
  const ui = (request: ExtensionUIRequest) => projection.apply({ kind: 'extension-ui', request })
  return {
    projection,
    event,
    ui,
    overflow,
    time: (value: number) => {
      now = value
    },
  }
}

describe('lane projection', () => {
  it('has no Node, Electron or DOM dependencies', () => {
    expect(readFileSync(new URL('./projection.ts', import.meta.url), 'utf8')).not.toMatch(
      /node:|\b(electron|document|window|process|Buffer|setTimeout)\b/,
    )
  })
  it('tracks run continuations, compaction, retry and exits', () => {
    const { projection: p, event } = setup()
    expect(p.activity()).toBe('idle')
    event({ type: 'agent_start' })
    event({ type: 'agent_end', messages: [], willRetry: true })
    expect(p.activity()).toBe('working')
    event({ type: 'agent_settled' })
    expect(p.activity()).toBe('idle')
    event({ type: 'compaction_start', reason: 'manual' })
    expect(p.activity()).toBe('working')
    event({ type: 'compaction_end', reason: 'manual', result: null, aborted: true })
    event({
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 2,
      delayMs: 1,
      errorMessage: 'retry',
    })
    expect(p.activity()).toBe('working')
    event({ type: 'auto_retry_end', success: true, attempt: 1 })
    expect(p.activity()).toBe('idle')
    p.apply({ kind: 'exit', code: 1, signal: null, expected: false })
    expect(p.activity()).toBe('failed')
    p.apply({ kind: 'exit', code: null, signal: 'SIGTERM', expected: true })
    expect(p.activity()).toBe('stopped')
    p.apply({ kind: 'exit', code: 0, signal: null, expected: false })
    expect(p.activity()).toBe('stopped')
  })
  it('opens, replaces, answers and expires dialogs, and clears them on exit', () => {
    const { projection: p, ui, time } = setup()
    for (const method of ['select', 'confirm', 'input', 'editor'] as const) {
      const request: ExtensionUIRequest =
        method === 'select'
          ? {
              type: 'extension_ui_request',
              id: method,
              method,
              title: 'pick',
              options: ['a'],
              timeout: 10,
            }
          : method === 'confirm'
            ? {
                type: 'extension_ui_request',
                id: method,
                method,
                title: 'confirm',
                message: '?',
                timeout: 10,
              }
            : method === 'input'
              ? { type: 'extension_ui_request', id: method, method, title: 'input', timeout: 10 }
              : { type: 'extension_ui_request', id: method, method, title: 'editor' }
      ui(request)
    }
    expect(p.view().dialogs).toHaveLength(4)
    expect(p.activity()).toBe('needs-input')
    p.resolveDialog('select')
    time(9)
    expect(p.view().dialogs).toHaveLength(3)
    time(10)
    expect(p.view().dialogs.map((d) => d.id)).toEqual(['editor'])
    ui({ type: 'extension_ui_request', id: 'editor', method: 'editor', title: 'replacement' })
    expect(p.view().dialogs[0]).toMatchObject({ title: 'replacement' })
    p.apply({ kind: 'exit', code: 0, signal: null, expected: true })
    expect(p.view().dialogs).toEqual([])
  })
  it('resumes after a partial exit without stale tail, barrier, mark or queues', () => {
    const { projection: p, event } = setup()
    event({ type: 'agent_start' })
    event({ type: 'queue_update', steering: [], followUp: ['queued'] })
    event({ type: 'compaction_start', reason: 'manual' })
    p.markSettle()
    event({ type: 'message_end', message: { role: 'user', content: 'marked' } })
    event({ type: 'message_start', message: { role: 'assistant', content: [] } })
    event({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'unfinished' },
    })
    p.apply({ kind: 'exit', code: 1, signal: null, expected: false })
    const settled = [{ role: 'user' as const, content: 'settled' }]
    p.settle(settled, {
      sessionId: 'resumed',
      thinkingLevel: 'off',
      isStreaming: false,
      isCompacting: false,
      steeringMode: 'all',
      followUpMode: 'all',
      autoCompactionEnabled: true,
      messageCount: 1,
      pendingMessageCount: 0,
    })
    expect(p.view().pending).toEqual([])
    expect(p.view().messages).toEqual(settled)
    expect(p.activity()).toBe('idle')
  })
  it('bounds open dialogs and ignores momentary UI requests', () => {
    const { projection: p, ui, overflow } = setup()
    for (let k = 0; k < HOST_LIMITS.pendingEvents; k++)
      ui({ type: 'extension_ui_request', id: `${k}`, method: 'editor', title: 'edit' })
    expect(p.view().dialogs).toHaveLength(HOST_LIMITS.pendingEvents)
    expect(overflow).not.toHaveBeenCalled()
    ui({ type: 'extension_ui_request', id: 'extra', method: 'editor', title: 'edit' })
    expect(overflow).toHaveBeenCalledOnce()
    expect(p.view().dialogs).toHaveLength(HOST_LIMITS.pendingEvents)
    ui({ type: 'extension_ui_request', id: 'notice', method: 'notify', message: 'notice' })
    ui({ type: 'extension_ui_request', id: 'text', method: 'set_editor_text', text: 'draft' })
    expect(p.view().ui).toEqual([])
  })
  it.each(['setStatus', 'setWidget'] as const)('bounds, replaces and clears %s keys', (method) => {
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
    for (let k = 0; k < limit; k++) ui(request(`${k}`, 'value'))
    expect(p.view().ui).toHaveLength(limit)
    expect(overflow).not.toHaveBeenCalled()
    ui(request('0', 'replace'))
    expect(p.view().ui[0]).toMatchObject(
      method === 'setStatus' ? { statusText: 'replace' } : { widgetLines: ['replace'] },
    )
    ui(request('extra', 'value'))
    expect(overflow).toHaveBeenCalledOnce()
    expect(p.view().ui).toHaveLength(limit)
    ui(request('0'))
    expect(p.view().ui).toHaveLength(limit - 1)
    ui(request('extra', 'value'))
    expect(p.view().ui).toHaveLength(limit)
    ui({ type: 'extension_ui_request', id: 'title', method: 'setTitle', title: 'first' })
    ui({ type: 'extension_ui_request', id: 'title2', method: 'setTitle', title: 'last' })
    expect(p.view().ui.at(-1)).toMatchObject({ title: 'last' })
  })
  it('bounds event count and UTF-8 bytes and retains only the latest tool update', () => {
    const { projection: p, event, overflow } = setup()
    const update: PiEvent = {
      type: 'tool_execution_update',
      toolCallId: 'tool',
      toolName: 'read',
      args: {},
      partialResult: { content: [] },
    }
    for (let k = 0; k < 100; k++) event(update)
    expect(p.view().pending).toHaveLength(1)
    event({ type: 'message_end', message: { role: 'user', content: '' } })
    for (let k = 0; k < HOST_LIMITS.pendingEvents; k++) event({ type: 'turn_start' })
    expect(overflow).not.toHaveBeenCalled()
    expect(p.view().pending).toHaveLength(HOST_LIMITS.pendingEvents)
    event({ type: 'turn_start' })
    expect(overflow).toHaveBeenCalledOnce()
    expect(p.view().pending.length).toBeLessThanOrEqual(HOST_LIMITS.pendingEvents)
    const base: PiEvent = { type: 'extension_error', error: '' }
    const padding =
      HOST_LIMITS.replayBytes - new TextEncoder().encode(JSON.stringify([base])).length
    event({ ...base, error: 'x'.repeat(padding) })
    expect(overflow).toHaveBeenCalledOnce()
    event({ type: 'message_end', message: { role: 'user', content: '' } })
    event({ ...base, error: 'x'.repeat(padding + 1) })
    expect(overflow).toHaveBeenCalledTimes(2)
    event({ type: 'message_end', message: { role: 'user', content: '' } })
    event({ ...base, error: 'é'.repeat(padding) })
    expect(overflow).toHaveBeenCalledTimes(3)
  })
  it('bounds reconciliation marks and compares recorded messages by deep JSON value', () => {
    const { projection: p, event, overflow } = setup()
    p.markSettle()
    for (let k = 0; k < HOST_LIMITS.pendingEvents; k++)
      event({ type: 'message_end', message: { role: 'user', content: `${k}` } })
    expect(overflow).not.toHaveBeenCalled()
    event({ type: 'message_end', message: { role: 'user', content: 'past' } })
    expect(overflow).toHaveBeenCalledOnce()
    p.markSettle()
    event({ type: 'message_end', message: { role: 'user', content: 'same' } })
    p.settle([{ content: 'same', role: 'user' }], null)
    expect(p.view().messages).toHaveLength(1)
  })
  it('coalesces barrier events and does not lift the barrier before compaction ends', () => {
    const { projection: p, event, overflow } = setup()
    event({ type: 'compaction_start', reason: 'manual' })
    p.markSettle()
    p.settle([], null)
    event({ type: 'message_start', message: { role: 'assistant', content: [] } })
    for (let k = 0; k < 10_000; k++)
      event({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'x' },
      })
    expect(p.view().pending).toHaveLength(3)
    expect(overflow).not.toHaveBeenCalled()
    event({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] },
    })
    expect(p.view().messages).toHaveLength(0)
    event({ type: 'extension_error', error: 'x'.repeat(HOST_LIMITS.replayBytes) })
    expect(overflow).toHaveBeenCalledOnce()
  })
})
