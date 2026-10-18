import { beforeEach, expect, it, vi } from 'vitest'
import { sessionEventChannel } from '@shared/ipc'
import type { SessionPush } from '@shared/models'
import type { AgentMessage, ExtensionUIRequest, PiEvent, ToolResultMessage } from '@shared/rpc'
import { broadcast } from '../broadcast'
import { desktopSessionSink } from './session-events'

vi.mock('../broadcast', () => ({ broadcast: vi.fn() }))
beforeEach(() => vi.clearAllMocks())

const message: AgentMessage = { role: 'assistant', content: [{ type: 'text', text: 'done' }] }
const result: ToolResultMessage = {
  role: 'toolResult',
  toolCallId: 'read-1',
  toolName: 'read',
  content: [{ type: 'text', text: 'full result' }],
  isError: false,
}

it.each([
  { type: 'agent_end', messages: [message, result], willRetry: true },
  { type: 'turn_end', message, toolResults: [result] },
] satisfies PiEvent[])(
  'empties only renderer arrays for $type and retains the full runtime event',
  (event) => {
    const target = { isDestroyed: () => false, send: vi.fn() }
    const payload: SessionPush = { kind: 'event', event }
    const original = structuredClone(payload)
    desktopSessionSink('lane', target)(payload)
    const expected =
      event.type === 'agent_end' ? { ...event, messages: [] } : { ...event, toolResults: [] }
    expect(target.send).toHaveBeenCalledExactlyOnceWith(sessionEventChannel('lane'), {
      kind: 'event',
      event: expected,
    })
    expect(payload).toEqual(original)
    expect(payload.event).toBe(event)
    if (event.type === 'agent_end') expect(event.messages).toEqual([message, result])
    else {
      expect(event.message).toBe(message)
      expect(event.toolResults).toEqual([result])
    }
    expect(broadcast).not.toHaveBeenCalled()
  },
)

it('broadcasts a trimmed copy without changing the runtime payload', () => {
  const event: PiEvent = { type: 'turn_end', message, toolResults: [result] }
  desktopSessionSink('lane')({ kind: 'event', event })
  expect(broadcast).toHaveBeenCalledExactlyOnceWith(sessionEventChannel('lane'), {
    kind: 'event',
    event: { type: 'turn_end', message, toolResults: [] },
  })
  expect(event.toolResults).toEqual([result])
})

const base = { type: 'extension_ui_request' as const, id: 'dialog', title: 'Question' }
const dialogs: ExtensionUIRequest[] = [
  { ...base, method: 'input' },
  { ...base, method: 'confirm', message: 'Continue?' },
  { ...base, method: 'select', options: ['yes'] },
  { ...base, method: 'editor' },
]
it.each(dialogs)(
  'suppresses unattended $method dialogs on targeted and broadcast delivery',
  (request) => {
    const target = { isDestroyed: () => false, send: vi.fn() }
    const payload: SessionPush = { kind: 'extension-ui', request }
    desktopSessionSink('routine', target, () => true)(payload)
    desktopSessionSink('routine', undefined, () => true)(payload)
    expect(target.send).not.toHaveBeenCalled()
    expect(broadcast).not.toHaveBeenCalled()
    desktopSessionSink('interactive', target)(payload)
    expect(target.send).toHaveBeenCalledExactlyOnceWith(sessionEventChannel('interactive'), payload)
  },
)

it('does not broadcast elsewhere when the targeted renderer is destroyed', () => {
  const target = { isDestroyed: () => true, send: vi.fn() }
  desktopSessionSink(
    'closed',
    target,
  )({
    kind: 'event',
    event: { type: 'agent_end', messages: [message] },
  })
  expect(target.send).not.toHaveBeenCalled()
  expect(broadcast).not.toHaveBeenCalled()
})
