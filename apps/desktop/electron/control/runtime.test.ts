import { beforeEach, expect, it, vi } from 'vitest'
import type { AccountView } from '@shared/account'
import type { createMachinesLive } from './live'
import type { createControlClient } from './client'
import type { createRealtime } from './realtime'
import type * as Realtime from './realtime'
import type * as Client from './client'

const state = vi.hoisted(() => ({
  createClient: vi.fn<typeof createControlClient>(),
  live: vi.fn<typeof createMachinesLive>(),
  realtime: vi.fn<typeof createRealtime>(),
  clear: vi.fn(),
  broadcast: vi.fn(),
  subscribe: vi.fn<(listener: (view: AccountView) => void) => () => void>(),
  off: vi.fn(),
  stop: vi.fn(),
  once: vi.fn(),
  token: vi.fn(async () => 'token'),
  generation: vi.fn(() => 3),
  snapshot: vi.fn<() => AccountView>(() => ({ account: { status: 'signed-out' } })),
  url: vi.fn(() => 'https://control.example'),
  target: vi.fn(() => ({ url: 'https://realtime.example', key: 'public' })),
  log: vi.fn(),
}))
vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '1.0.0', once: state.once },
}))
vi.mock('../account', () => ({
  accountAccessToken: state.token,
  accountControlGeneration: state.generation,
  accountSnapshot: state.snapshot,
  onAccountChange: state.subscribe,
}))
vi.mock('../account/config', () => ({ supabaseTarget: state.target }))
vi.mock('../broadcast', () => ({ broadcast: state.broadcast }))
vi.mock('../hosts/traffic-tap', () => ({ tappedLog: state.log }))
vi.mock('./client', async (original) => {
  const actual = await original<typeof Client>()
  state.createClient.mockImplementation((ports) => ({
    ...actual.createControlClient(ports),
    clearObservations: state.clear,
  }))
  return { createControlClient: state.createClient, controlUrl: state.url }
})
vi.mock('./live', () => ({ createMachinesLive: state.live }))
vi.mock('./realtime', async (original) => ({
  ...(await original<typeof Realtime>()),
  createRealtime: state.realtime,
}))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  state.subscribe.mockReturnValue(state.off)
  state.live.mockReturnValue(state.stop)
})

it('keeps the client singleton and its account-generation authority without starting live work at import', async () => {
  const { controlClient } = await import('./runtime')
  expect(controlClient()).toBe(controlClient())
  expect(state.createClient).toHaveBeenCalledOnce()
  expect(state.subscribe).not.toHaveBeenCalled()
  expect(state.live).not.toHaveBeenCalled()
  expect(state.once).not.toHaveBeenCalled()
  const ports = state.createClient.mock.calls[0]![0]
  expect(ports.accessToken).toBe(state.token)
  expect(ports.generation).toBe(state.generation)
  expect(ports.log).toBe(state.log)
  expect(ports.version?.()).toBe('1.0.0')
  expect(ports.baseUrl()).toBe('https://control.example')
  expect(state.url).toHaveBeenCalledWith(true, process.env)
})

it('broadcasts before delivering machine listeners and removes only the unsubscribed listener', async () => {
  const { initControlRuntime, onMachinesChanged } = await import('./runtime')
  const delivery: string[] = []
  state.broadcast.mockImplementation(() => delivery.push('broadcast'))
  const first = vi.fn(() => delivery.push('first'))
  const second = vi.fn(() => delivery.push('second'))
  const off = onMachinesChanged(first)
  onMachinesChanged(second)
  initControlRuntime()
  const changed = state.live.mock.calls[0]![0].broadcast
  changed()
  expect(delivery).toEqual(['broadcast', 'first', 'second'])
  expect(state.broadcast).toHaveBeenCalledWith('control:machinesChanged', undefined)
  off()
  off()
  delivery.length = 0
  changed()
  expect(delivery).toEqual(['broadcast', 'second'])
  expect(first).toHaveBeenCalledOnce()
  expect(second).toHaveBeenCalledTimes(2)
})

it('clears observations for every non-signed-in account change and binds quit cleanup in order', async () => {
  const { initControlRuntime } = await import('./runtime')
  initControlRuntime()
  const accountChanged = state.subscribe.mock.calls[0]![0]
  accountChanged({
    account: {
      status: 'signed-in',
      user: { login: 'test', name: null, email: null },
      remembered: false,
    },
  })
  expect(state.clear).not.toHaveBeenCalled()
  accountChanged({ account: { status: 'signing-in' } })
  accountChanged({ account: { status: 'signed-out' } })
  expect(state.clear).toHaveBeenCalledTimes(2)
  expect(state.once.mock.calls).toEqual([
    ['will-quit', state.off],
    ['will-quit', state.stop],
  ])
})

it('wires live and realtime dependencies without replacing account authority', async () => {
  const { initControlRuntime } = await import('./runtime')
  const { liveTimers } = await import('./realtime')
  initControlRuntime()
  const live = state.live.mock.calls[0]![0]
  expect(live.snapshot).toBe(state.snapshot)
  expect(live.subscribe).toBe(state.subscribe)
  expect(live.timers).toBe(liveTimers)
  expect(live.log).toBe(state.log)
  const changed = vi.fn()
  const joined = vi.fn()
  live.realtime(changed, joined)
  const realtime = state.realtime.mock.calls[0]![0]
  expect(realtime).toMatchObject({
    log: state.log,
    target: { url: 'https://realtime.example', key: 'public' },
    accessToken: state.token,
    generation: state.generation,
    timers: liveTimers,
    now: Date.now,
    random: Math.random,
    changed,
    joined,
  })
  expect(state.target).toHaveBeenCalledWith(true, process.env)
})
