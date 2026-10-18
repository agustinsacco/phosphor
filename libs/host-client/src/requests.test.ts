import { afterEach, expect, it, vi } from 'vitest'
import type { ClientFrame, LaneOp } from '@phosphor/shared/host-protocol'
import {
  closeRequests,
  createPendingState,
  createRequests,
  flushReplay,
  settleReceipt,
  trackCommand,
  type RequestPorts,
} from './requests'

afterEach(() => vi.useRealTimers())
it('retries backpressure with browser timers even without an unref port', () => {
  vi.useFakeTimers()
  const write = vi.fn(() => false)
  const requests = createRequests({
    now: Date.now,
    write,
    later: setTimeout,
    canReplay: () => true,
    changed: () => {},
    transportFailed: () => {},
    hostId: 'host',
    log: () => {},
  })
  requests.track({ type: 'command', requestId: 'request', op: { type: 'abort' } }, () => {})
  requests.prepareReplay()
  requests.flushReplay()
  expect(write).toHaveBeenCalledTimes(1)
  write.mockReturnValue(true)
  vi.advanceTimersByTime(250)
  expect(write).toHaveBeenCalledTimes(2)
  expect(requests.replaying()).toBe(false)
  requests.close()
  expect(vi.getTimerCount()).toBe(0)
})

function ports(overrides: Partial<RequestPorts> = {}) {
  const written: ClientFrame[] = []
  const log = vi.fn()
  const value: RequestPorts = {
    now: Date.now,
    write: (frame) => {
      written.push(frame)
      return true
    },
    later: setTimeout,
    canReplay: () => true,
    changed: () => {},
    transportFailed: () => {},
    hostId: 'host',
    log,
    ...overrides,
  }
  return { ports: value, written, log }
}
const command = (requestId: string, op: LaneOp = { type: 'abort' }) =>
  ({ type: 'command', requestId, op }) as const

it('rechecks the replay age on every retry, turning a late resend into a status query', () => {
  vi.useFakeTimers()
  let full = true
  const t = ports()
  const write = vi.fn((frame: ClientFrame) => !full && t.ports.write(frame))
  const state = createPendingState()
  const p = { ...t.ports, write }
  trackCommand(state, p, command('late'), () => {})
  vi.setSystemTime(Date.now() + 59_800)
  state.replay.push('late')
  flushReplay(state, p)
  expect(write).toHaveBeenLastCalledWith(command('late'))
  full = false
  vi.advanceTimersByTime(250)
  expect(t.written).toEqual([{ type: 'receipt-status', requestId: 'late' }])
  expect(state.replay).toEqual([])
  closeRequests(state)
  expect(vi.getTimerCount()).toBe(0)
})

it('logs settled receipts but never terminal operations, and only for tracked commands', () => {
  const t = ports()
  const state = createPendingState()
  trackCommand(
    state,
    t.ports,
    command('kill', { type: 'terminal.kill', terminalId: 't' }),
    () => {},
  )
  trackCommand(state, t.ports, command('abort'), () => {})
  settleReceipt(state, t.ports, { requestId: 'kill', status: 'done' })
  settleReceipt(state, t.ports, { requestId: 'abort', status: 'unknown' })
  settleReceipt(state, t.ports, { requestId: 'stranger', status: 'done' })
  expect(t.log.mock.calls).toEqual([
    ['hosts', 'receipt', { hostId: 'host', requestId: 'abort', status: 'unknown' }],
  ])
  expect(state.pending.size).toBe(0)
  expect(state.expiries.size).toBe(0)
})

it('clears expiry and call timers on receipt, result, timeout and close', async () => {
  vi.useFakeTimers()
  const t = ports()
  const requests = createRequests(t.ports)
  const settled: string[] = []
  requests.track(command('a'), (r) => settled.push(`a:${r.status}`))
  requests.track(command('b'), (r) => settled.push(`b:${r.status}`))
  const answered = requests.call('c1', true, 'host.repositories', undefined, 'trace')
  const timedOut = requests.call('c2', true, 'host.repositories', undefined, 'trace')
  expect(vi.getTimerCount()).toBe(4)
  requests.receipt({ requestId: 'a', status: 'done' })
  requests.result({ type: 'result', id: 'c1', ok: true, data: null })
  expect(vi.getTimerCount()).toBe(2)
  expect(await answered).toMatchObject({ ok: true })
  vi.advanceTimersByTime(30_000)
  expect(await timedOut).toMatchObject({ error: { message: 'Query timed out.' } })
  // A disconnect keeps commands and their deadlines; only close clears them.
  requests.disconnect(1001)
  expect(vi.getTimerCount()).toBe(1)
  requests.close()
  expect(vi.getTimerCount()).toBe(0)
  expect(settled).toEqual(['a:done', 'b:unknown'])
})

it('expires an unanswered command into status-only uncertainty after 60000ms', () => {
  vi.useFakeTimers()
  const t = ports()
  const requests = createRequests(t.ports)
  const settled = vi.fn()
  requests.track(command('slow'), settled)
  vi.advanceTimersByTime(59_999)
  expect(settled).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(settled).toHaveBeenCalledWith({ requestId: 'slow', status: 'unknown' })
  expect(t.written).toEqual([{ type: 'receipt-status', requestId: 'slow' }])
  expect(requests.full()).toBe(false)
  requests.prepareReplay()
  requests.flushReplay()
  expect(t.written.at(-1)).toEqual({ type: 'receipt-status', requestId: 'slow' })
  requests.close()
})

it('keeps every connection state isolated', () => {
  vi.useFakeTimers()
  const a = ports()
  const b = ports()
  const first = createRequests(a.ports)
  const second = createRequests(b.ports)
  first.track(command('only-first'), () => {})
  first.prepareReplay()
  second.prepareReplay()
  expect(first.replaying()).toBe(true)
  expect(second.replaying()).toBe(false)
  second.flushReplay()
  first.flushReplay()
  expect(a.written).toEqual([command('only-first')])
  expect(b.written).toEqual([])
  const states = [createPendingState(), createPendingState()]
  expect(states[0]?.pending).not.toBe(states[1]?.pending)
  expect(states[0]?.replay).not.toBe(states[1]?.replay)
  first.close()
  second.close()
  expect(vi.getTimerCount()).toBe(0)
})
