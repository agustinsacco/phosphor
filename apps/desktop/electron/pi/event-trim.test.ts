import { describe, expect, it } from 'vitest'
import type { AgentMessage, PiEvent, ToolResultMessage } from '@shared/rpc'
import { trimForRenderer } from './event-trim'

const message: AgentMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }] }
const result: ToolResultMessage = {
  role: 'toolResult',
  toolCallId: 'read-1',
  toolName: 'read',
  content: [{ type: 'text', text: 'full result' }],
  isError: false,
}

describe('trimForRenderer delivery boundary', () => {
  it.each([true, false, undefined])(
    'preserves willRetry %s and leaves messages present',
    (willRetry) => {
      const event: PiEvent = {
        type: 'agent_end',
        messages: [message],
        ...(willRetry === undefined ? {} : { willRetry }),
      }
      expect(trimForRenderer(event)).toEqual({ ...event, messages: [] })
      expect(event.messages).toEqual([message])
    },
  )

  it('keeps an absent willRetry absent', () => {
    const trimmed = trimForRenderer({ type: 'agent_end', messages: [message] })
    expect(Object.hasOwn(trimmed, 'willRetry')).toBe(false)
  })

  it('leaves toolResults present and preserves the turn message identity', () => {
    const event: PiEvent = { type: 'turn_end', message, toolResults: [result] }
    const trimmed = trimForRenderer(event)
    expect(trimmed).toEqual({ type: 'turn_end', message, toolResults: [] })
    expect(trimmed.type === 'turn_end' && trimmed.message).toBe(message)
    expect(event.toolResults).toEqual([result])
  })

  it.each([
    { type: 'agent_start' },
    {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hi' },
    },
    { type: 'agent_end', messages: [], willRetry: false },
    { type: 'turn_end', message, toolResults: [] },
  ] satisfies PiEvent[])('retains identity for untouched $type events', (event) => {
    expect(trimForRenderer(event)).toBe(event)
  })
})
