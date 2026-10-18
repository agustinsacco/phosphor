import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HOST_LIMITS, type ClientFrame } from '@phosphor/shared/host-protocol'
import {
  ackInput,
  clearSubscriptions,
  createSubscriptionState,
  dropInputs,
  resubscribe,
  sendInput,
  watchLane,
  watchTerminal,
  type SubscriptionPorts,
} from './subscriptions'

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

function fakePorts(overrides: Partial<SubscriptionPorts> = {}) {
  let n = 0
  const written: ClientFrame[] = []
  const ports: SubscriptionPorts = {
    identity: { randomUUID: () => `sub-${++n}`, randomHex: () => 'f'.repeat(16) },
    write: vi.fn((frame: ClientFrame) => {
      written.push(frame)
      return true
    }),
    later: vi.fn((fn: () => void, ms: number) => setTimeout(fn, ms)),
    cancel: vi.fn((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer)),
    unrefTimer: vi.fn(),
    transportFailed: vi.fn(),
    ready: () => true,
    stopped: () => false,
    ...overrides,
  }
  return { ports, written }
}

it('caps lane watches at 63 and counts terminal watches against both', () => {
  const state = createSubscriptionState()
  const { ports } = fakePorts()
  const limit = HOST_LIMITS.subscriptionsPerConnection - 1
  for (let i = 0; i < limit - 1; i++) watchLane(state, ports, 'lane', () => {})
  watchTerminal(state, ports, 'terminal', () => {})
  expect(() => watchTerminal(state, ports, 'terminal', () => {})).toThrow(
    'Subscription unavailable.',
  )
  watchLane(state, ports, 'lane', () => {})
  expect(() => watchLane(state, ports, 'lane', () => {})).toThrow('Subscription unavailable.')
  expect(state.watches.size + state.terminals.size).toBe(limit + 1)
  const stopped = fakePorts({ stopped: () => true }).ports
  const fresh = createSubscriptionState()
  expect(() => watchLane(fresh, stopped, 'lane', () => {})).toThrow('Subscription unavailable.')
  expect(() => watchTerminal(fresh, stopped, 't', () => {})).toThrow('Subscription unavailable.')
})

it('subscribes and unsubscribes on the wire only while ready', () => {
  let ready = false
  const state = createSubscriptionState()
  const { ports, written } = fakePorts({ ready: () => ready })
  const off = watchLane(state, ports, 'lane', () => {})
  const terminal = watchTerminal(state, ports, 'terminal', () => {})
  off()
  terminal.close()
  expect(written).toEqual([])
  ready = true
  const offReady = watchLane(state, ports, 'lane', () => {})
  const ready2 = watchTerminal(state, ports, 'terminal', () => {})
  ready2.reset()
  offReady()
  ready2.close()
  expect(written.map((f) => (f.type === 'subscribe' ? `subscribe:${f.topic}` : f.type))).toEqual([
    'subscribe:lane',
    'subscribe:terminal',
    'subscribe:terminal',
    'unsubscribe',
    'unsubscribe',
  ])
  expect(state.watches.size + state.terminals.size).toBe(0)
})

it('resubscribes the lanes list, each watch at its cursor, then each terminal', () => {
  const state = createSubscriptionState()
  const { ports, written } = fakePorts({ ready: () => false })
  watchLane(state, ports, 'lane-1', () => {})
  watchLane(state, ports, 'lane-2', () => {})
  watchTerminal(state, ports, 'terminal-1', () => {})
  const first = state.watches.get('sub-1')
  if (!first) throw new Error('No watch')
  first.cursor = { epoch: 'a'.repeat(16), seq: 3 }
  resubscribe(state, ports, { epoch: 'a'.repeat(16), seq: 9 })
  expect(written).toEqual([
    {
      type: 'subscribe',
      id: 'lanes',
      topic: 'lanes',
      after: { epoch: 'a'.repeat(16), seq: 9 },
      trace: 'f'.repeat(16),
    },
    {
      type: 'subscribe',
      id: 'sub-1',
      topic: 'lane',
      laneId: 'lane-1',
      after: first.cursor,
      trace: 'f'.repeat(16),
    },
    {
      type: 'subscribe',
      id: 'sub-2',
      topic: 'lane',
      laneId: 'lane-2',
      after: undefined,
      trace: 'f'.repeat(16),
    },
    { type: 'subscribe', topic: 'terminal', id: 'sub-3', terminalId: 'terminal-1' },
  ])
  expect(ports.transportFailed).not.toHaveBeenCalled()
  const refused = fakePorts({ write: () => false }).ports
  resubscribe(state, refused, undefined)
  expect(refused.transportFailed).toHaveBeenCalledTimes(4)
})

it('cancels the input timer when an ack, a refused write or a disconnect settles it', async () => {
  const state = createSubscriptionState()
  const { ports, written } = fakePorts()
  const acked = sendInput(state, ports, 't1', 1, 'ls')
  expect(written).toEqual([{ type: 'terminal.input', terminalId: 't1', seq: 1, data: 'ls' }])
  expect(ports.later).toHaveBeenCalledWith(expect.any(Function), 5000)
  expect(ports.unrefTimer).toHaveBeenCalledTimes(1)
  expect(await sendInput(state, ports, 't1', 2, 'busy')).toBe(false)
  ackInput(state, { type: 'terminal.ack', terminalId: 't1', seq: 1, accepted: true })
  expect(await acked).toBe(true)
  expect(ports.cancel).toHaveBeenCalledTimes(1)
  const dropped = sendInput(state, ports, 't1', 2, 'pwd')
  const other = sendInput(state, ports, 't2', 1, 'pwd')
  dropInputs(state)
  expect(await Promise.all([dropped, other])).toEqual([false, false])
  expect(ports.cancel).toHaveBeenCalledTimes(3)
  expect(vi.getTimerCount()).toBe(0)
  const refused = fakePorts({ write: () => false }).ports
  expect(await sendInput(state, refused, 't1', 3, 'x')).toBe(false)
  expect(refused.cancel).toHaveBeenCalledTimes(1)
  expect(refused.transportFailed).toHaveBeenCalledTimes(1)
  expect(state.inputs.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})

it('times an input out after 5000ms and ignores a late ack', async () => {
  const state = createSubscriptionState()
  const { ports } = fakePorts()
  let accepted: boolean | undefined
  void sendInput(state, ports, 't1', 1, 'ls').then((value) => {
    accepted = value
  })
  await vi.advanceTimersByTimeAsync(4999)
  expect(accepted).toBeUndefined()
  await vi.advanceTimersByTimeAsync(1)
  expect(accepted).toBe(false)
  ackInput(state, { type: 'terminal.ack', terminalId: 't1', seq: 1, accepted: true })
  expect(state.inputs.size).toBe(0)
  expect(await sendInput(state, fakePorts({ ready: () => false }).ports, 't1', 2, 'x')).toBe(false)
})

it('keeps each connection state isolated and clears all of it on finish', async () => {
  const a = createSubscriptionState()
  const b = createSubscriptionState()
  const { ports } = fakePorts()
  watchLane(a, ports, 'lane', () => {})
  watchTerminal(a, ports, 'terminal', () => {})
  const input = sendInput(a, ports, 'terminal', 1, 'ls')
  expect(b.watches.size + b.terminals.size + b.inputs.size).toBe(0)
  clearSubscriptions(a)
  expect(await input).toBe(false)
  expect(a.watches.size + a.terminals.size + a.inputs.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
})
