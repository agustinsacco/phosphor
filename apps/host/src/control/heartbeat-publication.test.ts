import { afterEach, expect, it, vi } from 'vitest'
import type { HeartbeatState } from './heartbeat'
import { drainHeartbeat, PUBLICATION_WAIT_MS, publishHeartbeat } from './heartbeat-publication'

function fixture() {
  let force: () => void = () => {}
  const forced = new Promise<void>((resolve) => {
    force = resolve
  })
  const state: HeartbeatState = {
    ports: {
      now: () => 1000,
      random: () => 0,
      hostVersion: '1.0.0',
      seq: { read: vi.fn(async () => 0), write: vi.fn(async () => {}) },
      readiness: async () => ({ pi: 'ok', claude: 'ok', tailscale: 'ok' }),
      client: vi.fn(async () => ({ accepted: true as const, nextInSec: 30 })),
      wait: vi.fn(async () => new Promise<void>(() => {})),
      log: vi.fn(),
    },
    running: new AbortController(),
    forced,
    force,
    ending: false,
    drain: undefined,
    publication: Promise.resolve(),
    last: 0,
    readiness: { pi: 'unknown', claude: 'unknown', tailscale: 'unknown' },
    refreshed: -Infinity,
    started: 0,
    logState: '',
    staleLogged: false,
    backoff: 5000,
  }
  return state
}

afterEach(() => vi.useRealTimers())

it('serializes reads and durable writes before exposing either request', async () => {
  const state = fixture()
  let release: () => void = () => {}
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const events: string[] = []
  state.ports.seq.read = async () => {
    events.push('read')
    return 9000
  }
  state.ports.seq.write = async (seq) => {
    events.push(`write ${seq}`)
    if (seq === 9001) await blocked
  }
  const first = publishHeartbeat(state, 'running')
  const second = publishHeartbeat(state, 'stopping')
  await vi.waitFor(() => expect(events).toEqual(['read', 'write 9001']))
  expect(state.last).toBe(9000)
  release()
  expect(await first).toMatchObject({ seq: 9001, state: 'running' })
  expect(await second).toMatchObject({ seq: 9002, state: 'stopping' })
  expect(events).toEqual(['read', 'write 9001', 'read', 'write 9002'])
  expect(state.last).toBe(9002)
  expect(state.ports.client).not.toHaveBeenCalled()
})

it('keeps the queue usable after a rejected publication without advancing last', async () => {
  const state = fixture()
  state.ports.seq.write = vi
    .fn()
    .mockRejectedValueOnce(new Error('disk failed'))
    .mockResolvedValueOnce(undefined)
  await expect(publishHeartbeat(state, 'running')).rejects.toThrow('disk failed')
  expect(state.last).toBe(0)
  await expect(publishHeartbeat(state, 'stopping')).resolves.toMatchObject({ seq: 1000 })
  expect(state.last).toBe(1000)
})

it('takes metadata at publication time and rejects invalid metadata before writing', async () => {
  const state = fixture()
  state.ports.endpoint = () => 'https://bee.tail123.ts.net:47615'
  state.readiness = { pi: 'ok', claude: 'signed-out', tailscale: 'no-https' }
  expect(await publishHeartbeat(state, 'running')).toEqual({
    seq: 1000,
    state: 'running',
    hostVersion: '1.0.0',
    uptimeSec: 1,
    readiness: state.readiness,
    lanes: { running: 0, waiting: 0 },
    endpoint: 'https://bee.tail123.ts.net:47615',
  })
  state.ports.hostVersion = 'invalid version'
  await expect(publishHeartbeat(state, 'stopping')).rejects.toThrow('Invalid heartbeat metadata.')
  expect(state.ports.seq.write).toHaveBeenCalledTimes(1)
})

it('drains behind an in-flight write and gives the stopping transport its own signal', async () => {
  const state = fixture()
  let release: () => void = () => {}
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const write = vi.fn(async (seq: number) => {
    if (seq === 1000) await blocked
  })
  state.ports.seq.write = write
  const publication = publishHeartbeat(state, 'running')
  await vi.waitFor(() => expect(write).toHaveBeenCalledOnce())
  const draining = drainHeartbeat(state)
  expect(state.ending).toBe(true)
  expect(state.running.signal.aborted).toBe(true)
  expect(state.ports.client).not.toHaveBeenCalled()
  release()
  await publication
  expect(await draining).toEqual({ state: 'stopped' })
  expect(state.ports.client).toHaveBeenCalledWith(
    expect.objectContaining({ state: 'stopping', seq: 1001 }),
    expect.any(AbortSignal),
  )
  const signal = vi.mocked(state.ports.client).mock.calls[0]?.[1]
  expect(signal).not.toBe(state.running.signal)
  expect(signal?.aborted).toBe(true)
  expect(state.ports.log).toHaveBeenCalledExactlyOnceWith('stopped')
})

it('force skips a stuck disk publication without scheduling another stopping beat', async () => {
  vi.useFakeTimers()
  const state = fixture()
  state.ports.seq.write = vi.fn(async () => new Promise<void>(() => {}))
  state.ports.wait = async () => {}
  let ended = false
  const first = drainHeartbeat(state).then(() => {
    ended = true
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(ended).toBe(false)
  expect(vi.getTimerCount()).toBe(1)
  await expect(drainHeartbeat(state)).resolves.toEqual({ state: 'stopped' })
  await first
  expect(ended).toBe(true)
  expect(state.ports.seq.write).toHaveBeenCalledOnce()
  expect(state.ports.client).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('waits for disk publication only until the one-second bound after the beat deadline', async () => {
  vi.useFakeTimers()
  const state = fixture()
  state.ports.seq.write = async () => new Promise<void>(() => {})
  state.ports.wait = (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms)
    })
  let ended = false
  const first = drainHeartbeat(state).then(() => {
    ended = true
  })
  await vi.advanceTimersByTimeAsync(5000 + PUBLICATION_WAIT_MS - 1)
  expect(ended).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await first
  expect(ended).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
