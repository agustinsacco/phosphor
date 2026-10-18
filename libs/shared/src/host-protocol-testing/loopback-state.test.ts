import { afterEach, expect, it, vi } from 'vitest'
import { HOST_LIMITS } from '../host-protocol'
import {
  bufferedLoopbackBytes,
  closeLoopback,
  createLoopbackState,
  dropLoopbackMessages,
  scheduleLoopback,
  sendLoopback,
} from './loopback-state'

afterEach(() => vi.restoreAllMocks())

it('validates each limit against its contract maximum and initializes independent queues', () => {
  const state = createLoopbackState()
  expect(state).toMatchObject({
    inbound: HOST_LIMITS.inboundFrameBytes,
    outbound: HOST_LIMITS.outboundFrameBytes,
    cap: HOST_LIMITS.sendQueueBytes,
    open: true,
    paused: false,
    dropped: 0,
    queuedBytes: 0,
    scheduled: false,
    queue: [],
    messages: [[], []],
    closes: [[], []],
  })
  const limits = {
    inboundFrameBytes: HOST_LIMITS.inboundFrameBytes,
    outboundFrameBytes: HOST_LIMITS.outboundFrameBytes,
    queueBytes: HOST_LIMITS.sendQueueBytes,
  }
  for (const [key, maximum] of Object.entries(limits)) {
    expect(() => createLoopbackState({ [key]: 1 })).not.toThrow()
    expect(() => createLoopbackState({ [key]: maximum })).not.toThrow()
    for (const value of [0, -1, 0.5, NaN, Infinity, maximum + 1]) {
      expect(() => createLoopbackState({ [key]: value })).toThrow('Invalid loopback limit')
    }
  }
  expect(createLoopbackState().queue).not.toBe(state.queue)
  expect(state.messages[0]).not.toBe(state.messages[1])
  expect(state.closes[0]).not.toBe(state.closes[1])
})

it('accepts exact UTF-8 frame limits and checks oversize frames before dropping', async () => {
  const state = createLoopbackState({ inboundFrameBytes: 4, outboundFrameBytes: 4 })
  sendLoopback(state, 0, '😀')
  sendLoopback(state, 1, '😀')
  expect(state.queuedBytes).toBe(8)
  expect(bufferedLoopbackBytes(state, 0)).toBe(4)
  expect(bufferedLoopbackBytes(state, 1)).toBe(4)
  await Promise.resolve()
  expect(state.queuedBytes).toBe(0)
  dropLoopbackMessages(state, 1)
  expect(() => sendLoopback(state, 1, '😀a')).toThrow('Outbound frame too large')
  expect(state.open).toBe(true)
  expect(state.dropped).toBe(1)
  sendLoopback(state, 0, '😀a')
  expect(state.open).toBe(false)
  expect(state.dropped).toBe(1)
  expect(() => sendLoopback(state, 1, '')).toThrow('Socket closed')
  await Promise.resolve()
})

it('caps the shared queue exactly and clears accounting before asynchronous close callbacks', async () => {
  const state = createLoopbackState({ queueBytes: 5 })
  state.paused = true
  const closed = vi.fn()
  state.closes[0]?.push(closed)
  state.closes[1]?.push(closed)
  sendLoopback(state, 0, '😀')
  sendLoopback(state, 1, 'a')
  expect(state.queuedBytes).toBe(5)
  expect(bufferedLoopbackBytes(state, 0)).toBe(4)
  expect(bufferedLoopbackBytes(state, 1)).toBe(1)
  sendLoopback(state, 1, 'b')
  expect(state.open).toBe(false)
  expect(state.queue).toEqual([])
  expect(state.queuedBytes).toBe(0)
  expect(bufferedLoopbackBytes(state, 0)).toBe(0)
  expect(bufferedLoopbackBytes(state, 1)).toBe(0)
  closeLoopback(state, 1006, 'ignored')
  expect(closed).not.toHaveBeenCalled()
  await Promise.resolve()
  expect(closed.mock.calls).toEqual([
    [4429, 'Transport queue full'],
    [4429, 'Transport queue full'],
  ])
})

it('coalesces scheduling until a flush starts and leaves paused traffic queued', async () => {
  const microtask = vi.spyOn(globalThis, 'queueMicrotask')
  const state = createLoopbackState()
  state.paused = true
  sendLoopback(state, 0, 'a')
  sendLoopback(state, 0, 'b')
  scheduleLoopback(state)
  expect(microtask).toHaveBeenCalledTimes(1)
  expect(state.scheduled).toBe(true)
  await Promise.resolve()
  expect(state.scheduled).toBe(false)
  expect(state.queuedBytes).toBe(2)
  state.paused = false
  const received = vi.fn()
  state.messages[1]?.push(received)
  scheduleLoopback(state)
  scheduleLoopback(state)
  expect(microtask).toHaveBeenCalledTimes(2)
  expect(received).not.toHaveBeenCalled()
  await Promise.resolve()
  expect(received.mock.calls).toEqual([['a'], ['b']])
  expect(state.scheduled).toBe(false)
  expect(state.queuedBytes).toBe(0)
})

it('accounts before listeners and drains reentrant sends in the current microtask', async () => {
  const microtask = vi.spyOn(globalThis, 'queueMicrotask')
  const state = createLoopbackState({ queueBytes: 1 })
  const received: string[] = []
  state.messages[1]?.push((text) => {
    received.push(text)
    expect(state.queuedBytes).toBe(0)
    if (text === 'a') sendLoopback(state, 0, 'b')
  })
  sendLoopback(state, 0, 'a')
  await Promise.resolve()
  expect(received).toEqual(['a', 'b'])
  expect(state.open).toBe(true)
  expect(microtask).toHaveBeenCalledTimes(2)
  expect(state.scheduled).toBe(true)
  await Promise.resolve()
  expect(state.scheduled).toBe(false)
  expect(received).toEqual(['a', 'b'])
})

it.each(['pause', 'close'] as const)(
  'interrupts draining on %s only after all listeners of the current frame',
  async (action) => {
    const state = createLoopbackState()
    const received: string[] = []
    state.messages[1]?.push((text) => {
      received.push(`first:${text}`)
      if (action === 'pause') state.paused = true
      else closeLoopback(state, 1006, 'Severed')
    })
    state.messages[1]?.push((text) => received.push(`second:${text}`))
    sendLoopback(state, 0, 'a')
    sendLoopback(state, 0, 'b')
    await Promise.resolve()
    expect(received).toEqual(['first:a', 'second:a'])
    expect(state.queuedBytes).toBe(action === 'pause' ? 1 : 0)
    expect(state.queue.map((frame) => frame.text)).toEqual(action === 'pause' ? ['b'] : [])
    await Promise.resolve()
  },
)

it('validates drop counts without mutation and replaces rather than adds to the count', async () => {
  const state = createLoopbackState({ queueBytes: 1 })
  dropLoopbackMessages(state, 2)
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => dropLoopbackMessages(state, value)).toThrow('Invalid drop count')
    expect(state.dropped).toBe(2)
  }
  dropLoopbackMessages(state, Number.MAX_SAFE_INTEGER)
  dropLoopbackMessages(state, 1)
  sendLoopback(state, 0, 'a')
  expect(state.dropped).toBe(0)
  expect(state.queuedBytes).toBe(0)
  expect(state.scheduled).toBe(false)
  sendLoopback(state, 0, 'b')
  dropLoopbackMessages(state, 1)
  sendLoopback(state, 1, 'dropped before capacity check')
  expect(state.open).toBe(true)
  expect(state.queuedBytes).toBe(1)
  dropLoopbackMessages(state, 1)
  dropLoopbackMessages(state, 0)
  await Promise.resolve()
  sendLoopback(state, 0, 'c')
  expect(state.queuedBytes).toBe(1)
  await Promise.resolve()
})
