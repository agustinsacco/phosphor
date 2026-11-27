import type { AccountView } from '@shared/account'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const invoke = vi.fn()
beforeEach(async () => {
  vi.stubGlobal('window', { phosphor: { invoke, platform: 'darwin' } })
  const { useMachinesStore } = await import('./machines')
  useMachinesStore.getState().enableRemote(false)
})
describe('the enrolled machines projection', () => {
  let signal: () => void
  let push: (view: AccountView) => void
  let off: (() => void) | undefined
  beforeEach(() => {
    vi.useFakeTimers()
    invoke.mockReset()
    window.phosphor.onMachinesChanged = (listener) => {
      signal = listener
      return () => undefined
    }
    window.phosphor.onAccountChanged = (listener) => {
      push = listener
      return () => undefined
    }
  })
  afterEach(() => {
    off?.()
    off = undefined
    vi.useRealTimers()
  })
  async function start(signedIn = true, onDemand = false, remoteDiscoveryActive = false) {
    const { attachMachinesListener, useMachinesStore } = await import('./machines')
    invoke.mockResolvedValueOnce({
      account: { status: signedIn ? 'signed-in' : 'signed-out' },
      remoteDiscoveryActive,
    })
    off = attachMachinesListener(onDemand)
    await Promise.resolve()
    return useMachinesStore
  }
  it('makes no machine call or timer at signed-out startup and is idempotent', async () => {
    const { attachMachinesListener } = await import('./machines')
    const store = await start(false)
    const second = attachMachinesListener()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('account:get')
    expect(vi.getTimerCount()).toBe(0)
    expect(store.getState().remoteEnabled).toBe(false)
    second()
  })
  it('does not fetch for a remembered Desktop account until Machines is opened', async () => {
    const { useLayoutStore } = await import('./layout')
    const store = await start(true, true)
    expect(store.getState().remoteEnabled).toBe(true)
    signal()
    expect(invoke.mock.calls).toEqual([['account:get']])
    invoke.mockResolvedValueOnce({ ok: true, machines: [], serverTime: new Date().toISOString() })
    useLayoutStore.getState().setPage('machines')
    await vi.advanceTimersByTimeAsync(0)
    expect(invoke.mock.calls).toEqual([['account:get'], ['control:machines']])
    useLayoutStore.getState().setPage(null)
  })
  it('loads the directory for a new Desktop window when discovery is already active in main', async () => {
    invoke.mockResolvedValue({ ok: true, machines: [], serverTime: new Date().toISOString() })
    const store = await start(true, true, true)
    await vi.advanceTimersByTimeAsync(0)
    expect(invoke.mock.calls).toEqual([['account:get'], ['control:machines']])
    expect(store.getState().directoryLoaded).toBe(true)
  })
  it('loads the directory for an open Desktop window when main starts discovery after launch', async () => {
    const store = await start(true, true)
    expect(invoke.mock.calls).toEqual([['account:get']])
    invoke.mockResolvedValue({ ok: true, machines: [], serverTime: new Date().toISOString() })
    push({
      account: {
        status: 'signed-in',
        user: { login: 'test', name: null, email: null },
        remembered: true,
      },
      remoteDiscoveryActive: true,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(invoke.mock.calls).toEqual([['account:get'], ['control:machines']])
    expect(store.getState().directoryLoaded).toBe(true)
  })
  it('coalesces signals during a request into one follow-up and ignores late signed-out data', async () => {
    const { MACHINE } = await import('@/features/machines/__fixtures__/control')
    let finish: ((value: unknown) => void) | undefined
    const store = await start(false)
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    push({
      account: {
        status: 'signed-in',
        user: { login: 'test', name: null, email: null },
        remembered: false,
      },
    })
    signal()
    signal()
    signal()
    expect(invoke.mock.calls.filter(([c]) => c === 'control:machines')).toHaveLength(1)
    invoke.mockResolvedValueOnce({
      ok: true,
      machines: [MACHINE],
      serverTime: new Date().toISOString(),
    })
    finish?.({ ok: true, machines: [], serverTime: new Date().toISOString() })
    await vi.advanceTimersByTimeAsync(0)
    expect(invoke.mock.calls.filter(([c]) => c === 'control:machines')).toHaveLength(2)
    expect(store.getState().machines).toEqual([MACHINE])
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    signal()
    push({ account: { status: 'signed-out' } })
    finish?.({ ok: true, machines: [MACHINE], serverTime: new Date().toISOString() })
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getState().machines).toEqual([])
    expect(store.getState().loading).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('rejudges on the server clock every five seconds without fetching and stops when empty', async () => {
    const { MACHINE } = await import('@/features/machines/__fixtures__/control')
    const now = Date.now()
    const machine = {
      ...MACHINE,
      state: 'running',
      lastSeenAt: new Date(now + 60_000 - 85_000).toISOString(),
    }
    const store = await start(false)
    invoke.mockResolvedValueOnce({
      ok: true,
      machines: [machine],
      serverTime: new Date(now + 60_000).toISOString(),
    })
    push({
      account: {
        status: 'signed-in',
        user: { login: 'test', name: null, email: null },
        remembered: false,
      },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getState().clockOffsetMs).toBe(60_000)
    expect(store.getState().statuses[MACHINE.id]).toBe('up')
    await vi.advanceTimersByTimeAsync(5000)
    expect(store.getState().statuses[MACHINE.id]).toBe('up')
    await vi.advanceTimersByTimeAsync(5000)
    expect(store.getState().statuses[MACHINE.id]).toBe('down')
    expect(invoke.mock.calls.filter(([c]) => c === 'control:machines')).toHaveLength(1)
    invoke.mockResolvedValueOnce({ ok: true, machines: [], serverTime: new Date().toISOString() })
    await store.getState().refresh()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('surfaces errors without retaining peer messages and clears signed-out data', async () => {
    const store = await start(false)
    await store.getState().refresh()
    expect(invoke).toHaveBeenCalledTimes(1)
    invoke.mockResolvedValueOnce({ ok: false, error: { code: 'offline', message: 'not retained' } })
    push({
      account: {
        status: 'signed-in',
        user: { login: 'test', name: null, email: null },
        remembered: false,
      },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(store.getState().error).toBe('offline')
    invoke.mockRejectedValueOnce(new Error('not retained'))
    await store.getState().refresh()
    expect(store.getState().error).toBe('offline')
    invoke.mockImplementationOnce(() => {
      throw new Error('not retained')
    })
    await store.getState().refresh()
    expect(store.getState().error).toBe('offline')
    invoke.mockResolvedValueOnce({ ok: false, error: { code: 'signed-out', message: '' } })
    await store.getState().refresh()
    expect(store.getState().machines).toEqual([])
    expect(store.getState().error).toBe('signed-out')
  })
})
