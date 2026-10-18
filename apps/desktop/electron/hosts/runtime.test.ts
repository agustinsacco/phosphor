import { beforeEach, expect, it, vi } from 'vitest'
import { BrowserWindow } from 'electron'
import { broadcast } from '../broadcast'
import { createClientIds } from './client-id'
import { createGrants } from './grants'
import { createHostManager } from './manager'
import { createHostConnection } from './connection'
import { createRemoteLanes } from './remote-lanes'
import { createRemoteTerminals } from './terminals'
import { createRemoteRoutines } from './routines'
import { createHostAttention } from './attention'
import { createHostRuntime, remoteLanes, remoteRoutineMachines, clearHostRuntime } from './runtime'

const state = vi.hoisted(() => ({
  clients: { current: vi.fn(), resetReplacementBudget: vi.fn() },
  grants: { clear: vi.fn(), grantFor: vi.fn() },
  manager: {
    connection: vi.fn(),
    present: vi.fn(),
    label: vi.fn(),
    changed: vi.fn(),
    disabled: vi.fn(),
    snapshot: () => ({ h: {} }),
    stop: vi.fn(),
  },
  lanes: { reconcile: vi.fn(), terminalLane: vi.fn() },
  terminals: { reconcile: vi.fn() },
  routines: { machines: vi.fn(() => ['machine']) },
  attention: { receive: vi.fn() },
}))
vi.mock('electron', () => ({ app: {}, BrowserWindow: { getAllWindows: vi.fn(() => []) } }))
vi.mock('../account', () => ({ accountUserId: vi.fn(), onAccountChange: vi.fn() }))
vi.mock('../broadcast', () => ({ broadcast: vi.fn() }))
vi.mock('../debug-log', () => ({ log: vi.fn() }))
vi.mock('../store', () => ({ getRemoteClients: vi.fn(), setRemoteClients: vi.fn() }))
vi.mock('../control/runtime', () => ({ controlClient: () => ({}), onMachinesChanged: vi.fn() }))
vi.mock('./client-id', () => ({ createClientIds: vi.fn(() => state.clients) }))
vi.mock('./grants', () => ({ createGrants: vi.fn(() => state.grants) }))
vi.mock('./manager', () => ({ createHostManager: vi.fn(() => state.manager) }))
vi.mock('./connection', () => ({ createHostConnection: vi.fn() }))
vi.mock('./socket', () => ({ e2eHostEndpoint: () => 'test-endpoint', openHostSocket: vi.fn() }))
vi.mock('./remote-lanes', () => ({ createRemoteLanes: vi.fn(() => state.lanes) }))
vi.mock('./terminals', () => ({ createRemoteTerminals: vi.fn(() => state.terminals) }))
vi.mock('./routines', () => ({ createRemoteRoutines: vi.fn(() => state.routines) }))
vi.mock('./attention', () => ({ createHostAttention: vi.fn(() => state.attention) }))

beforeEach(() => vi.clearAllMocks())
it('constructs connection ports before views without invoking late-bound callbacks', () => {
  const runtime = createHostRuntime()
  const constructors = [
    createClientIds,
    createGrants,
    createHostManager,
    createRemoteLanes,
    createRemoteTerminals,
    createRemoteRoutines,
    createHostAttention,
  ]
  const order = constructors.map((fn) => vi.mocked(fn).mock.invocationCallOrder[0])
  expect(order).toEqual([...order].sort((a, b) => (a ?? 0) - (b ?? 0)))
  expect(state.manager.present).not.toHaveBeenCalled()
  expect(state.lanes.reconcile).not.toHaveBeenCalled()
  expect(state.attention.receive).not.toHaveBeenCalled()
  expect(runtime.remote).toBe(state.lanes)
  expect(remoteLanes()).toBe(state.lanes)
  expect(remoteRoutineMachines()).toEqual(['machine'])
  clearHostRuntime()
  expect(remoteRoutineMachines()).toEqual([])
})
it('wires deferred manager, grant, routine and attention callbacks to constructed views', () => {
  createHostRuntime()
  const manager = vi.mocked(createHostManager).mock.calls[0]![0]
  const grants = vi.mocked(createGrants).mock.calls[0]![0]
  grants.present('h')
  expect(state.manager.present).toHaveBeenCalledWith('h')
  manager.changed()
  expect(state.lanes.reconcile).toHaveBeenCalledOnce()
  expect(state.terminals.reconcile).toHaveBeenCalledOnce()
  expect(broadcast).toHaveBeenCalledWith('hosts:changed', undefined)
  manager.clearGrants('h')
  expect(state.grants.clear).toHaveBeenCalledWith('h')
  manager.connection('h', 'endpoint')
  const connection = vi.mocked(createHostConnection).mock.calls[0]![0]
  expect(connection).toMatchObject({
    hostId: 'h',
    endpoint: 'endpoint',
    testEndpoint: 'test-endpoint',
  })
  void connection.grant()
  expect(state.grants.grantFor).toHaveBeenCalledWith('h')
  connection.changed()
  expect(state.manager.changed).toHaveBeenCalledOnce()
  connection.onRoutinesChanged?.()
  expect(broadcast).toHaveBeenCalledWith('routines:changed', { machine: 'host:h' })
  const event = {
    id: 'a',
    laneId: 'l',
    kind: 'finished',
    attention: 1,
    at: 'now',
    title: null,
  } as const
  connection.onAttention?.(event)
  expect(state.attention.receive).toHaveBeenCalledWith('h', event)
  const routines = vi.mocked(createRemoteRoutines).mock.calls[0]![0]
  expect(routines.hosts()).toEqual(['h'])
  expect(routines.view?.('h')).toEqual({})
})
it('delivers terminal events only to the live owning sender and delegates lane authority', () => {
  createHostRuntime()
  const ports = vi.mocked(createRemoteTerminals).mock.calls[0]![0]
  const send = vi.fn()
  vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
    { webContents: { id: 7, isDestroyed: () => false, send } },
    { webContents: { id: 8, isDestroyed: () => true, send } },
  ] as unknown as Electron.BrowserWindow[])
  ports.emit(7, 'pty:data', 'hello')
  ports.emit(8, 'pty:data', 'ignored')
  ports.emit(9, 'pty:data', 'ignored')
  expect(send).toHaveBeenCalledExactlyOnceWith('pty:data', 'hello')
  ports.lane(7, 'remote-handle', 'workspace')
  expect(state.lanes.terminalLane).toHaveBeenCalledWith(7, 'remote-handle', 'workspace')
})
