import { describe, expect, it } from 'vitest'
import {
  emptyChatSession,
  reduceChatEvent,
  type AssistantItem,
  type ChatSessionState,
} from './reducer'
import type { PiEvent } from '@shared/rpc'

/**
 * Regression suite for the provider that withholds tool identity while a call
 * streams (Bedrock-routed Claude). Before toolIdentity.ts these flows produced
 * a card labelled "Running unknown" that never resolved, plus a *second*,
 * invisible tool entry that received all the real output.
 */

function run(events: PiEvent[], initial?: ChatSessionState): ChatSessionState {
  return events.reduce(reduceChatEvent, initial ?? emptyChatSession())
}

const assistantStart: PiEvent = {
  type: 'message_start',
  message: { role: 'assistant', content: [] },
}

/**
 * `toolcall_start` that names no tool: identity unknown at this point. That's
 * older pi (< 0.84.3), or a provider that withholds identity while streaming.
 */
const anonymousToolStart = (contentIndex = 0): PiEvent => ({
  type: 'message_update',
  assistantMessageEvent: { type: 'toolcall_start', contentIndex },
})

/** `toolcall_start` in the pi >= 0.84.3 wire shape: id + name on the event. */
const namedToolStart = (id: string, name: string, contentIndex = 0): PiEvent => ({
  type: 'message_update',
  assistantMessageEvent: { type: 'toolcall_start', contentIndex, id, toolName: name },
})

const argsDelta = (delta: string, contentIndex = 0): PiEvent => ({
  type: 'message_update',
  assistantMessageEvent: { type: 'toolcall_delta', contentIndex, delta },
})

describe('streaming tool identity', () => {
  it('leaves toolName null instead of inventing "unknown"', () => {
    const state = run([assistantStart, anonymousToolStart()])
    const tools = Object.values(state.tools)
    expect(tools).toHaveLength(1)
    expect(tools[0]!.toolName).toBeNull()
    expect(tools[0]!.toolCallId).toMatch(/^pending-/)
  })

  it('stays on the placeholder when an event carries an id but no name', () => {
    // Re-keying onto an id with a blank title would render a nameless card,
    // which is worse than the honest placeholder.
    const state = run([
      assistantStart,
      {
        type: 'message_update',
        assistantMessageEvent: { type: 'toolcall_start', contentIndex: 0, id: 'half-1' },
      },
    ])
    expect(Object.values(state.tools)[0]!.toolCallId).toMatch(/^pending-/)
    expect(Object.values(state.tools)[0]!.toolName).toBeNull()
  })

  it('keeps streaming args onto the placeholder', () => {
    const state = run([
      assistantStart,
      anonymousToolStart(),
      argsDelta('{"path"'),
      argsDelta(':1}'),
    ])
    expect(Object.values(state.tools)[0]!.argsText).toBe('{"path":1}')
  })

  it('titles the card when `toolcall_start` names the call (pi >= 0.84.3)', () => {
    const state = run([
      assistantStart,
      namedToolStart('real-1', 'read'),
      argsDelta('{"path"'),
      argsDelta(':1}'),
    ])
    // One entry, keyed by the real id, with the streamed args preserved.
    expect(Object.keys(state.tools)).toEqual(['real-1'])
    expect(state.tools['real-1']).toMatchObject({ toolName: 'read', argsText: '{"path":1}' })
    const item = state.items[0] as AssistantItem
    expect(item.blocks[0]).toMatchObject({ type: 'tool', toolCallId: 'real-1' })
  })

  it('adopts the placeholder when tool_execution_start arrives first', () => {
    const state = run([
      assistantStart,
      anonymousToolStart(),
      argsDelta('{"command":"ls"}'),
      {
        type: 'tool_execution_start',
        toolCallId: 'exec-1',
        toolName: 'bash',
        args: { command: 'ls' },
      },
    ])
    // The bug: this used to create a second entry under 'exec-1' while the
    // rendered block still pointed at the placeholder.
    expect(Object.keys(state.tools)).toEqual(['exec-1'])
    const tool = state.tools['exec-1']!
    expect(tool).toMatchObject({ toolName: 'bash', status: 'running' })
    expect(tool.argsText).toBe('{"command":"ls"}')
    const item = state.items[0] as AssistantItem
    expect(item.blocks[0]).toMatchObject({ type: 'tool', toolCallId: 'exec-1' })
  })

  it('routes output and completion to the visible card', () => {
    const state = run([
      assistantStart,
      anonymousToolStart(),
      {
        type: 'tool_execution_start',
        toolCallId: 'exec-1',
        toolName: 'bash',
        args: { command: 'ls' },
      },
      {
        type: 'tool_execution_update',
        toolCallId: 'exec-1',
        toolName: 'bash',
        args: {},
        partialResult: { content: [{ type: 'text', text: 'partial' }] },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'exec-1',
        toolName: 'bash',
        isError: false,
        result: { content: [{ type: 'text', text: 'done' }] },
      },
    ])
    const item = state.items[0] as AssistantItem
    const rendered = item.blocks[0]
    expect(rendered).toMatchObject({ type: 'tool' })
    const visible = state.tools[(rendered as { toolCallId: string }).toolCallId]!
    expect(visible.status).toBe('done')
    expect(visible.result?.content).toEqual([{ type: 'text', text: 'done' }])
    expect(Object.keys(state.tools)).toHaveLength(1)
  })

  it('adopts even when only tool_execution_update arrives (no start)', () => {
    const state = run([
      assistantStart,
      anonymousToolStart(),
      {
        type: 'tool_execution_update',
        toolCallId: 'exec-9',
        toolName: 'bash',
        args: {},
        partialResult: { content: [{ type: 'text', text: 'tick' }] },
      },
    ])
    expect(Object.keys(state.tools)).toEqual(['exec-9'])
    expect(state.tools['exec-9']!.output?.content).toEqual([{ type: 'text', text: 'tick' }])
  })

  it('pairs parallel anonymous calls in arrival order', () => {
    const state = run([
      assistantStart,
      anonymousToolStart(0),
      anonymousToolStart(1),
      { type: 'tool_execution_start', toolCallId: 'first', toolName: 'read', args: {} },
      { type: 'tool_execution_start', toolCallId: 'second', toolName: 'grep', args: {} },
    ])
    const item = state.items[0] as AssistantItem
    expect(item.blocks.map((b) => (b.type === 'tool' ? b.toolCallId : b.type))).toEqual([
      'first',
      'second',
    ])
    expect(state.tools['first']!.toolName).toBe('read')
    expect(state.tools['second']!.toolName).toBe('grep')
  })

  it('does not steal an identified tool when a new id appears', () => {
    const state = run([
      assistantStart,
      // Identified up front (the pi >= 0.84.3 shape).
      namedToolStart('known', 'read'),
      // An unrelated execution event must not re-key the identified block.
      { type: 'tool_execution_start', toolCallId: 'other', toolName: 'bash', args: {} },
    ])
    const item = state.items[0] as AssistantItem
    expect(item.blocks[0]).toMatchObject({ toolCallId: 'known' })
    expect(state.tools['known']!.toolName).toBe('read')
    expect(state.tools['other']!.toolName).toBe('bash')
  })

  it('handles the ordering real pi produces: message_end reveals identity before any tool_execution_*', () => {
    // pi-agent-core's loop awaits the assistant stream (emitting the
    // authoritative message_end) BEFORE executeToolCalls emits any
    // tool_execution_start. A provider that never revealed identity during
    // streaming therefore re-keys via message_end content — the placeholder
    // entry must be pruned, and execution events must land on the real id.
    const state = run([
      { type: 'agent_start' },
      assistantStart,
      anonymousToolStart(),
      argsDelta('{"command":"npm test"}'),
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'real-9', name: 'bash', arguments: { command: 'npm test' } },
          ],
          stopReason: 'toolUse',
        },
      },
      { type: 'tool_execution_start', toolCallId: 'real-9', toolName: 'bash', args: {} },
      {
        type: 'tool_execution_end',
        toolCallId: 'real-9',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: 'ok' }] },
        isError: false,
      },
    ])
    // Exactly one tools entry: the real id. No leaked pending-* placeholder.
    expect(Object.keys(state.tools)).toEqual(['real-9'])
    expect(state.tools['real-9']!.status).toBe('done')
    const item = state.items[0] as AssistantItem
    expect(item.blocks[0]).toMatchObject({ toolCallId: 'real-9' })
  })
})
