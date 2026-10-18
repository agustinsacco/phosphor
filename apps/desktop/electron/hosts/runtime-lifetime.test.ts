import { beforeEach, expect, it, vi } from 'vitest'
import { BrowserWindow, Notification } from 'electron'
import { createHostAttention } from './attention'
import { createHostRuntime } from './runtime'
import { initAttention, installLifetime } from './runtime-lifetime'

const state = vi.hoisted(() => ({
  user: 'user' as string | null,
  account: [] as (() => void)[],
  off: vi.fn(),
  quit: vi.fn(),
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
  lanes: {
    clear: vi.fn(),
    closeWindow: vi.fn(),
    focused: vi.fn(),
    reconcile: vi.fn(),
    terminalLane: vi.fn(),
  },
  terminals: { clear: vi.fn(), reconcile: vi.fn() },
  routines: { clear: vi.fn(), machines: vi.fn(() => ['machine']) },
  attention: { clear: vi.fn(), receive: vi.fn() },
  notification: { once: vi.fn(), show: vi.fn() },
}))
vi.mock('electron', () => ({
  app: { once: (_: string, cb: () => void) => state.quit.mockImplementation(cb) },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  Notification: Object.assign(
    vi.fn(function () {
      return state.notification
    }),
    { isSupported: vi.fn(() => true) },
  ),
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
vi.mock('../control/runtime', () => ({ controlClient: () => ({}), onMachinesChanged: vi.fn() }))
vi.mock('./client-id', () => ({ createClientIds: vi.fn(() => state.clients) }))
vi.mock('./grants', () => ({ createGrants: vi.fn(() => state.grants) }))
vi.mock('./manager', () => ({ createHostManager: vi.fn(() => state.manager) }))
vi.mock('./connection', () => ({ createHostConnection: vi.fn() }))
vi.mock('./socket', () => ({ e2eHostEndpoint: () => 'test-endpoint', openHostSocket: vi.fn() }))
vi.mock('./remote-lanes', () => ({ createRemoteLanes: vi.fn(() => state.lanes) }))
vi.mock('./terminals', () => ({ createRemoteTerminals: vi.fn(() => state.terminals) }))
vi.mock('./routines', () => ({ createRemoteRoutines: vi.fn(() => state.routines) }))
vi.mock('./attention', () => ({
  createHostAttention: vi.fn(() => state.attention),
  readHostReceipt: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  state.user = 'user'
  state.account.length = 0
})
it('cleans account state in order, ignores unchanged identity, and unsubscribes at quit', () => {
  const runtime = createHostRuntime()
  const stopped = vi.fn()
  installLifetime(runtime, stopped)
  state.account.forEach((cb) => cb())
  expect(state.terminals.clear).not.toHaveBeenCalled()
  state.user = null
  state.account.forEach((cb) => cb())
  const account = [
    state.terminals.clear,
    state.routines.clear,
    state.lanes.clear,
    state.attention.clear,
  ]
  for (const fn of account) expect(fn).toHaveBeenCalledExactlyOnceWith()
  const order = account.map((fn) => fn.mock.invocationCallOrder[0])
  expect(order).toEqual([...order].sort((a, b) => (a ?? 0) - (b ?? 0)))
  vi.clearAllMocks()
  state.quit()
  const quit = [state.off, state.terminals.clear, state.lanes.clear, stopped, state.manager.stop]
  for (const fn of quit) expect(fn).toHaveBeenCalledExactlyOnceWith()
  const quitOrder = quit.map((fn) => fn.mock.invocationCallOrder[0])
  expect(quitOrder).toEqual([...quitOrder].sort((a, b) => (a ?? 0) - (b ?? 0)))
  expect(state.routines.clear).not.toHaveBeenCalled()
})
it('window adapter delegates push and destruction and re-registers only after destruction', () => {
  const window = installLifetime(createHostRuntime(), vi.fn())
  const once = vi.fn()
  const send = vi.fn()
  const isDestroyed = vi.fn(() => false)
  const event = {
    sender: { id: 7, once, send, isDestroyed },
  } as unknown as Electron.IpcMainInvokeEvent
  const owner = window(event)
  window(event)
  expect(once).toHaveBeenCalledOnce()
  const destroyed: unknown = once.mock.calls[0]?.[1]
  if (typeof destroyed !== 'function') throw new Error('Missing destruction listener')
  destroyed()
  expect(state.terminals.clear).toHaveBeenCalledExactlyOnceWith(7)
  expect(state.lanes.closeWindow).toHaveBeenCalledExactlyOnceWith(7)
  window(event)
  expect(once).toHaveBeenCalledTimes(2)
  const push = { kind: 'exit', code: 0, signal: null, expected: true } as const
  owner.send('pi:event', push)
  expect(send).toHaveBeenCalledWith('pi:event', push)
  expect(owner.destroyed()).toBe(false)
})
it('attention uses focused lane authority, supports notification clicks and opens a live window', () => {
  const runtime = createHostRuntime()
  initAttention(runtime.manager, runtime.remote)
  const ports = vi.mocked(createHostAttention).mock.calls.at(-1)![0]
  const win = {
    webContents: { id: 7, send: vi.fn() },
    isFocused: () => true,
    isDestroyed: () => false,
    show: vi.fn(),
    focus: vi.fn(),
  }
  vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([
    win,
  ] as unknown as Electron.BrowserWindow[])
  state.lanes.focused.mockReturnValue(true)
  expect(ports.focused('h', 'l')).toBe(true)
  expect(state.lanes.focused).toHaveBeenCalledWith('h', 'l', 7)
  const click = vi.fn()
  ports.notify('title', 'body', click)
  expect(Notification).toHaveBeenCalledWith({ title: 'title', body: 'body' })
  expect(state.notification.once).toHaveBeenCalledWith('click', click)
  expect(state.notification.show).toHaveBeenCalledOnce()
  vi.mocked(Notification.isSupported).mockReturnValueOnce(false)
  ports.notify('ignored', 'ignored', click)
  expect(Notification).toHaveBeenCalledOnce()
  ports.open('h', 'l')
  expect(win.show).toHaveBeenCalledOnce()
  expect(win.focus).toHaveBeenCalledOnce()
  expect(win.webContents.send).toHaveBeenCalledWith('hosts:openLaneRequested', {
    hostId: 'h',
    laneId: 'l',
  })
})
