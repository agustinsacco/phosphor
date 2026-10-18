import { afterEach, expect, it, vi } from 'vitest'
import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import { openHostSocket } from './socket'

class FixtureSocket extends EventTarget {
  static OPEN = 1
  static instance: FixtureSocket
  readyState = 1
  bufferedAmount = 0
  close = vi.fn()
  send = vi.fn()
  constructor() {
    super()
    FixtureSocket.instance = this
  }
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
function setup() {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FixtureSocket)
  const pending = openHostSocket('wss://fixture.invalid')
  return { pending, ws: FixtureSocket.instance }
}
it.each(['error', 'close', 'timeout'])('cleans opening deadline after %s', async (event) => {
  const t = setup()
  const rejected = expect(t.pending).rejects.toThrow('offline')
  if (event === 'timeout') vi.advanceTimersByTime(10000)
  else t.ws.dispatchEvent(new Event(event))
  await rejected
  expect(vi.getTimerCount()).toBe(0)
  t.ws.dispatchEvent(new Event('open'))
  expect(t.ws.close).toHaveBeenCalledTimes(1)
})
it.each([new Uint8Array([1]), 'x'.repeat(HOST_LIMITS.outboundFrameBytes + 1)])(
  'refuses non-text or oversized frames without delivering content',
  async (data) => {
    const t = setup()
    t.ws.dispatchEvent(new Event('open'))
    const socket = await t.pending
    const receive = vi.fn()
    socket.onMessage(receive)
    t.ws.dispatchEvent(new MessageEvent('message', { data }))
    expect(receive).not.toHaveBeenCalled()
    expect(t.ws.close).toHaveBeenCalledWith(4400, 'Bad frame')
    expect(vi.getTimerCount()).toBe(0)
  },
)
