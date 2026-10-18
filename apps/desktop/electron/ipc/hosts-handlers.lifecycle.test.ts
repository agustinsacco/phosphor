import { beforeEach, expect, it, vi } from 'vitest'
import type { HostManagerPorts } from '../hosts/manager-state'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  account: [] as (() => void)[],
  user: 'user' as string | null,
  quit: vi.fn(),
  off: vi.fn(),
  manager: {
    connection: vi.fn(),
    present: vi.fn(),
    label: vi.fn(),
    changed: vi.fn(),
    snapshot: () => ({}),
    stop: vi.fn(),
  },
  lanes: {
    clear: vi.fn(),
    closeWindow: vi.fn(),
    open: vi.fn(),
    create: vi.fn(),
    action: vi.fn(),
    setFocused: vi.fn(),
    reconcile: vi.fn(),
  },
  terminals: { clear: vi.fn(), signIn: vi.fn(), reconcile: vi.fn() },
  routines: { clear: vi.fn(), machines: () => [] },
  attention: { clear: vi.fn() },
}))
vi.mock('electron', () => ({
  app: { once: (_: string, cb: () => void) => state.quit.mockImplementation(cb) },
  BrowserWindow: {},
  Notification: {},
}))
vi.mock('../account', () => ({
  accountUserId: () => state.user,
  onAccountChange: (cb: () => void) => {
    state.account.push(cb)
    return state.off
  },
}))
vi.mock('../broadcast', () => ({ broadcast: vi.fn() }))
vi.mock('../debug-log', () => ({ log: vi.fn() }))
vi.mock('../store', () => ({ getRemoteClients: vi.fn(), setRemoteClients: vi.fn() }))
vi.mock('../hosts/client-id', () => ({ createClientIds: () => ({}) }))
vi.mock('../hosts/grants', () => ({ createGrants: () => ({}) }))
vi.mock('../hosts/connection', () => ({ createHostConnection: vi.fn() }))
vi.mock('../hosts/manager', () => ({
  createHostManager: (_ports: HostManagerPorts) => state.manager,
}))
vi.mock('../hosts/socket', () => ({ openHostSocket: vi.fn(), e2eHostEndpoint: vi.fn() }))
vi.mock('../control/runtime', () => ({ controlClient: () => ({}), onMachinesChanged: vi.fn() }))
vi.mock('./handle', () => ({
  handle: (name: string, cb: (...args: unknown[]) => unknown) => state.handlers.set(name, cb),
  setRemoteReadRouter: vi.fn(),
}))
vi.mock('../hosts/remote-lanes', () => ({ createRemoteLanes: () => state.lanes }))
vi.mock('../hosts/terminals', () => ({ createRemoteTerminals: () => state.terminals }))
vi.mock('../hosts/routines', () => ({ createRemoteRoutines: () => state.routines }))
vi.mock('../hosts/attention', () => ({ createHostAttention: () => state.attention }))

import { registerHostsHandlers } from './hosts-handlers'

function sender(id: number) {
  const destroyed = vi.fn()
  return {
    id,
    once: (_: string, cb: () => void) => destroyed.mockImplementation(cb),
    send: vi.fn(),
    isDestroyed: () => false,
    destroyed,
  }
}
function invoke(name: string, ...args: unknown[]) {
  const handler = state.handlers.get(name)
  if (!handler) throw new Error(`Missing ${name}`)
  return handler(...args)
}
beforeEach(() => {
  vi.clearAllMocks()
  state.account.length = 0
  state.user = 'user'
  registerHostsHandlers()
})
it('window destruction clears only its owned handles and installs one listener', () => {
  const a = sender(7)
  const b = sender(8)
  invoke('hosts:setFocusedLane', { sender: a }, { hostId: 'h', laneId: 'l' })
  invoke('hosts:setFocusedLane', { sender: a }, null)
  invoke('hosts:openLane', { sender: b }, 'h', 'l')
  a.destroyed()
  expect(a.destroyed).toHaveBeenCalledTimes(1)
  expect(state.terminals.clear).toHaveBeenCalledExactlyOnceWith(7)
  expect(state.lanes.closeWindow).toHaveBeenCalledExactlyOnceWith(7)
  expect(state.lanes.clear).not.toHaveBeenCalled()
  expect(state.routines.clear).not.toHaveBeenCalled()
})
it('account changes clear all remote state in order only when identity changes', () => {
  state.account.forEach((cb) => cb())
  expect(state.terminals.clear).not.toHaveBeenCalled()
  state.user = null
  state.account.forEach((cb) => cb())
  const calls = [
    state.terminals.clear,
    state.routines.clear,
    state.lanes.clear,
    state.attention.clear,
  ]
  for (const call of calls) expect(call).toHaveBeenCalledExactlyOnceWith()
  expect(calls.map((call) => call.mock.invocationCallOrder[0])).toEqual(
    calls.map((call) => call.mock.invocationCallOrder[0]).sort((a, b) => (a ?? 0) - (b ?? 0)),
  )
})
it('quit unsubscribes then clears terminal and lane state before stopping the manager', () => {
  state.quit()
  const calls = [state.off, state.terminals.clear, state.lanes.clear, state.manager.stop]
  for (const call of calls) expect(call).toHaveBeenCalledExactlyOnceWith()
  expect(state.routines.clear).not.toHaveBeenCalled()
  expect(calls.map((call) => call.mock.invocationCallOrder[0])).toEqual(
    calls.map((call) => call.mock.invocationCallOrder[0]).sort((a, b) => (a ?? 0) - (b ?? 0)),
  )
})
it('lane commands forward window identity, arguments and errors', async () => {
  const event = { sender: sender(7) }
  for (const [channel, method] of [
    ['hosts:openLane', state.lanes.open],
    ['hosts:createLane', state.lanes.create],
  ] as const) {
    invoke(channel, event, 'h', 'l')
    expect(method).toHaveBeenCalledWith(expect.objectContaining({ id: 7 }), 'h', 'l')
    const error = new Error('host rejected')
    method.mockRejectedValueOnce(error)
    await expect(invoke(channel, event, 'h', 'l')).rejects.toBe(error)
  }
  for (const [channel, op] of [
    ['stopLane', 'lane.stop'],
    ['resumeLane', 'lane.resume'],
    ['takeControl', 'control.take'],
    ['releaseControl', 'control.release'],
    ['markRead', 'lane.markRead'],
  ]) {
    invoke(`hosts:${channel}`, event, 'h', 'l')
    expect(state.lanes.action).toHaveBeenLastCalledWith('h', 'l', op)
  }
  invoke('hosts:providerLogin', event, 'h', 'provider')
  expect(state.terminals.signIn).toHaveBeenCalledWith(7, 'h', 'provider')
  invoke('hosts:setFocusedLane', event, null)
  expect(state.lanes.setFocused).toHaveBeenLastCalledWith(7, null)
})
