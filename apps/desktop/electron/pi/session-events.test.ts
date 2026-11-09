import { beforeEach, expect, it, vi } from 'vitest'
import type { ExtensionUIRequest, PiEvent } from '@shared/rpc'
import { sessionEventChannel } from '@shared/ipc'
import { broadcast } from '../broadcast'
import { desktopSessionSink } from './session-events'

vi.mock('../broadcast', () => ({ broadcast: vi.fn() }))
beforeEach(() => vi.clearAllMocks())

it('trims renderer payloads without mutating the full event', () => {
  const target = { isDestroyed: () => false, send: vi.fn() }
  const event: PiEvent = {
    type: 'agent_end',
    messages: [{ role: 'user', content: 'complete' }],
    willRetry: true,
  }
  desktopSessionSink('session', target)({ kind: 'event', event })
  expect(target.send).toHaveBeenCalledExactlyOnceWith(sessionEventChannel('session'), {
    kind: 'event',
    event: { type: 'agent_end', messages: [], willRetry: true },
  })
  expect(event.messages).toHaveLength(1)
  expect(broadcast).not.toHaveBeenCalled()
})

it('does not copy envelopes on the untrimmed streaming path', () => {
  const target = { isDestroyed: () => false, send: vi.fn() }
  const payload = { kind: 'event' as const, event: { type: 'agent_start' as const } }
  desktopSessionSink('session', target)(payload)
  expect(target.send.mock.calls[0]![1]).toBe(payload)
})

it('broadcasts only without a target and never falls back for a destroyed window', () => {
  const payload = { kind: 'stderr' as const, text: 'diagnostic' }
  desktopSessionSink('broadcast')(payload)
  expect(broadcast).toHaveBeenCalledExactlyOnceWith(sessionEventChannel('broadcast'), payload)
  const target = { isDestroyed: () => true, send: vi.fn() }
  desktopSessionSink('closed', target)(payload)
  expect(target.send).not.toHaveBeenCalled()
  expect(broadcast).toHaveBeenCalledTimes(1)
})

const base = { type: 'extension_ui_request' as const, id: 'ask', title: 'Question' }
const dialogs: ExtensionUIRequest[] = [
  { ...base, method: 'input' },
  { ...base, method: 'select', options: ['yes'] },
  { ...base, method: 'confirm', message: 'Continue?' },
  { ...base, method: 'editor' },
]
it.each(dialogs)(
  'suppresses unattended $method dialogs but forwards interactive ones',
  (request) => {
    const payload = { kind: 'extension-ui' as const, request }
    desktopSessionSink('routine', undefined, () => true)(payload)
    expect(broadcast).not.toHaveBeenCalled()
    desktopSessionSink('interactive')(payload)
    expect(broadcast).toHaveBeenCalledExactlyOnceWith(sessionEventChannel('interactive'), payload)
  },
)

it('reads unattended policy at delivery time', () => {
  let unattended = true
  const sink = desktopSessionSink('session', undefined, () => unattended)
  const payload = { kind: 'extension-ui' as const, request: dialogs[0]! }
  sink(payload)
  expect(broadcast).not.toHaveBeenCalled()
  unattended = false
  sink(payload)
  expect(broadcast).toHaveBeenCalledOnce()
})

it('keeps display-only status visible for unattended sessions', () => {
  const request: ExtensionUIRequest = {
    type: 'extension_ui_request',
    id: 'status',
    method: 'setStatus',
    statusKey: 'account',
    statusText: 'ready',
  }
  const payload = { kind: 'extension-ui' as const, request }
  desktopSessionSink('routine', undefined, () => true)(payload)
  expect(broadcast).toHaveBeenCalledExactlyOnceWith(sessionEventChannel('routine'), payload)
})
