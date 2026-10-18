import { expect, it, vi } from 'vitest'
import type { HeartbeatRequest } from '@phosphor/shared/control-api'
import { ControlFailure } from './client'
import type { HeartbeatState } from './heartbeat'
import { runHeartbeat } from './heartbeat-loop'

function fixture() {
  let now = 1000
  let force: () => void = () => {}
  const forced = new Promise<void>((resolve) => {
    force = resolve
  })
  const requests: HeartbeatRequest[] = []
  const waits: number[] = []
  const state: HeartbeatState = {
    ports: {
      now: () => now,
      random: () => 0,
      hostVersion: '1.0.0',
      seq: { read: async () => 0, write: async () => {} },
      readiness: vi.fn(async () => ({
        pi: 'ok' as const,
        claude: 'ok' as const,
        tailscale: 'ok' as const,
      })),
      client: async (request) => {
        requests.push(request)
        return { accepted: true, nextInSec: 30 }
      },
      wait: async (ms) => {
        waits.push(ms)
        state.ending = true
      },
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
    started: now,
    logState: '',
    staleLogged: false,
    backoff: 5000,
  }
  return {
    state,
    requests,
    waits,
    clock: (value: number) => {
      now = value
    },
  }
}

it('refreshes the readiness cache exactly at sixty seconds and publishes its current value', async () => {
  const f = fixture()
  const times = [60999, 61000]
  const ready = { pi: 'ok', claude: 'ok', tailscale: 'ok' } as const
  const changed = { pi: 'missing', claude: 'signed-out', tailscale: 'no-https' } as const
  f.state.ports.readiness = vi.fn().mockResolvedValueOnce(ready).mockResolvedValueOnce(changed)
  f.state.ports.wait = async () => {
    const next = times.shift()
    if (next === undefined) f.state.ending = true
    else f.clock(next)
  }
  expect(await runHeartbeat(f.state)).toBe(0)
  expect(f.state.ports.readiness).toHaveBeenCalledTimes(2)
  expect(f.requests.map((body) => body.readiness)).toEqual([ready, ready, changed])
  expect(f.state.refreshed).toBe(61000)
})

it('resets exponential backoff on success without resetting it on minimum-interval retries', async () => {
  const f = fixture()
  const replies: (ControlFailure['code'] | 'ok')[] = [
    'offline',
    'conflict',
    'too-many-requests',
    'offline',
    'ok',
    'offline',
  ]
  f.state.ports.client = async () => {
    const reply = replies.shift()
    if (reply === 'ok') return { accepted: true, nextInSec: 30 }
    throw new ControlFailure(reply ?? 'gone')
  }
  f.state.ports.wait = async (ms) => {
    f.waits.push(ms)
  }
  expect(await runHeartbeat(f.state)).toBe(77)
  expect(f.waits).toEqual([5000, 10000, 10000, 10000, 30000, 5000])
  expect(f.state.ports.log).toHaveBeenCalledWith('Heartbeat sequence was stale; retrying.')
})

it('uses internal-error backoff for invalid replies without accepting them', async () => {
  const f = fixture()
  f.state.ports.client = async () => ({ accepted: true, nextInSec: 0 })
  f.state.ports.onAccepted = vi.fn()
  await runHeartbeat(f.state)
  expect(f.waits).toEqual([5000])
  expect(f.state.ports.onAccepted).not.toHaveBeenCalled()
  expect(f.state.ports.log).toHaveBeenCalledExactlyOnceWith('retrying in 5s')
})

it.each([0, 0.5, 1])('accepts parsed replies and adds jitter %s to their delay', async (jitter) => {
  const f = fixture()
  f.state.ports.random = () => jitter
  f.state.ports.onAccepted = vi.fn()
  await runHeartbeat(f.state)
  expect(f.waits).toEqual([30000 + jitter * 3000])
  expect(f.state.ports.onAccepted).toHaveBeenCalledExactlyOnceWith({
    accepted: true,
    nextInSec: 30,
  })
})

it('removes the external abort listener after a fatal metadata error', async () => {
  const f = fixture()
  const controller = new AbortController()
  const remove = vi.spyOn(controller.signal, 'removeEventListener')
  f.state.ports.signal = controller.signal
  f.state.ports.hostVersion = 'bad version'
  await expect(runHeartbeat(f.state)).rejects.toThrow('Invalid heartbeat metadata.')
  expect(remove).toHaveBeenCalledExactlyOnceWith('abort', expect.any(Function))
  expect(f.waits).toEqual([])
  expect(f.requests).toEqual([])
})

it('cancels a hung readiness probe and drains without publishing a running beat', async () => {
  const f = fixture()
  const controller = new AbortController()
  f.state.ports.signal = controller.signal
  f.state.ports.readiness = vi.fn(() => new Promise<HeartbeatState['readiness']>(() => {}))
  const running = runHeartbeat(f.state)
  expect(f.state.ports.readiness).toHaveBeenCalledOnce()
  controller.abort()
  expect(await running).toBe(0)
  expect(f.requests.map((body) => body.state)).toEqual(['stopping'])
  expect(f.requests[0]?.readiness).toEqual({
    pi: 'unknown',
    claude: 'unknown',
    tailscale: 'unknown',
  })
})
