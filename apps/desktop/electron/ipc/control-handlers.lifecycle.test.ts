import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AccountView } from '@shared/account'
import type { createRealtime } from '../control/realtime'
import type * as Realtime from '../control/realtime'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  quit: [] as (() => void)[],
  accountListeners: new Set<(view: AccountView) => void>(),
  off: vi.fn(),
  close: vi.fn(),
  realtime: vi.fn<typeof createRealtime>(),
  client: {
    machines: vi.fn(),
    lookupEnrollment: vi.fn(),
    approveEnrollment: vi.fn(),
    renameMachine: vi.fn(),
    removeMachine: vi.fn(),
    clearObservations: vi.fn(),
  },
}))
vi.mock('./sender-policy', () => ({ admitSender: () => undefined }))
vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getVersion: () => '1.0.0',
    once: (event: string, listener: () => void) => {
      expect(event).toBe('will-quit')
      state.quit.push(listener)
    },
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      state.handlers.set(channel, handler),
  },
}))
vi.mock('../account', () => ({
  accountAccessToken: async () => 'token',
  accountControlGeneration: () => 3,
  accountSnapshot: (): AccountView => ({
    account: {
      status: 'signed-in',
      user: { login: 'test', name: null, email: null },
      remembered: false,
    },
  }),
  onAccountChange: (listener: (view: AccountView) => void) => {
    state.accountListeners.add(listener)
    return () => {
      state.off()
      state.accountListeners.delete(listener)
    }
  },
}))
vi.mock('../control/client', () => ({
  createControlClient: () => state.client,
  controlUrl: () => 'https://control.example',
}))
vi.mock('../control/realtime', async (original) => ({
  ...(await original<typeof Realtime>()),
  createRealtime: state.realtime,
}))
vi.mock('../broadcast', () => ({ broadcast: vi.fn() }))
vi.mock('../hosts/traffic-tap', () => ({ tappedLog: vi.fn() }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  state.handlers.clear()
  state.quit.length = 0
  state.accountListeners.clear()
  for (const method of Object.values(state.client)) method.mockReset()
  state.realtime.mockImplementation(() => ({ stop: state.close }))
})
afterEach(() => {
  for (const quit of state.quit) quit()
  vi.useRealTimers()
})

it('starts one live subscription on registration, clears on sign-out and unsubscribes on quit', async () => {
  const { registerControlHandlers } = await import('./control-handlers')
  expect(state.realtime).not.toHaveBeenCalled()
  expect(state.accountListeners.size).toBe(0)
  expect(state.quit).toHaveLength(0)
  registerControlHandlers()
  expect(state.realtime).toHaveBeenCalledOnce()
  // Observation clearing and the live subscription each observe the account.
  expect(state.accountListeners.size).toBe(2)
  expect(state.quit).toHaveLength(2)
  expect([...state.handlers.keys()]).toEqual([
    'control:machines',
    'control:lookupEnrollment',
    'control:approveEnrollment',
    'control:renameMachine',
    'control:removeMachine',
  ])
  for (const listener of state.accountListeners) listener({ account: { status: 'signed-out' } })
  expect(state.client.clearObservations).toHaveBeenCalledOnce()
  expect(state.close).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
  for (const quit of state.quit) quit()
  expect(state.off).toHaveBeenCalledTimes(2)
  expect(state.accountListeners.size).toBe(0)
  state.quit.length = 0
})

it('stops a still-active live subscription at will-quit', async () => {
  const { registerControlHandlers } = await import('./control-handlers')
  registerControlHandlers()
  expect(state.close).not.toHaveBeenCalled()
  for (const quit of state.quit) quit()
  expect(state.close).toHaveBeenCalledOnce()
  expect(state.off).toHaveBeenCalledTimes(2)
  expect(state.accountListeners.size).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
  state.quit.length = 0
})

const channels = [
  ['control:machines', 'machines', []],
  ['control:lookupEnrollment', 'lookupEnrollment', ['BCDFGHJK']],
  ['control:approveEnrollment', 'approveEnrollment', ['BCDFGHJK', 'my host']],
  ['control:approveEnrollment', 'approveEnrollment', ['BCDFGHJK']],
  ['control:renameMachine', 'renameMachine', ['11111111-1111-4111-8111-111111111111', 'new']],
  ['control:removeMachine', 'removeMachine', ['11111111-1111-4111-8111-111111111111']],
] as const

it.each(channels)(
  'forwards %s arguments and exact success/error results (%s, %j)',
  async (channel, method, args) => {
    const { registerControlHandlers } = await import('./control-handlers')
    registerControlHandlers()
    const invoke = state.handlers.get(channel)
    expect(invoke).toBeDefined()
    const forwarded = method === 'approveEnrollment' ? [args[0], args[1]] : [...args]
    for (const result of [
      { ok: true, data: { value: 'unchanged' } },
      { ok: false, error: { code: 'network', message: 'unchanged' } },
    ]) {
      state.client[method].mockResolvedValueOnce(result)
      expect(await invoke?.({ sender: { id: 7 } }, ...args)).toBe(result)
      expect(state.client[method]).toHaveBeenLastCalledWith(...forwarded)
    }
    const error = new Error('transport failure')
    state.client[method].mockRejectedValueOnce(error)
    await expect(invoke?.({ sender: { id: 7 } }, ...args)).rejects.toBe(error)
    expect(state.client[method]).toHaveBeenLastCalledWith(...forwarded)
  },
)
