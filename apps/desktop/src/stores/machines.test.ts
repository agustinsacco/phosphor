import type { AccountView } from '@shared/account'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Machines preview: off unless set, persisted through main, and turning
 * it off puts the filter, the made-up lanes and the page back.
 */
const invoke = vi.fn().mockResolvedValue(undefined)

beforeEach(async () => {
  invoke.mockClear()
  vi.stubGlobal('window', { phosphor: { invoke, platform: 'darwin' } })
  const { useMachinesStore } = await import('./machines')
  useMachinesStore.getState().applyPreview(false)
  const { useLayoutStore } = await import('./layout')
  useLayoutStore.setState({ page: null })
  const { useExtensionUiStore } = await import('./extensionUi')
  useExtensionUiStore.setState({ toasts: [] })
})

describe('the Machines preview', () => {
  it('is off until prefs say otherwise', async () => {
    const { useMachinesStore } = await import('./machines')
    expect(useMachinesStore.getState().preview).toBe(false)
    useMachinesStore.getState().applyPreview(true)
    expect(useMachinesStore.getState().preview).toBe(true)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('persists a change through main before applying it', async () => {
    const { useMachinesStore } = await import('./machines')
    await useMachinesStore.getState().setPreview(true)
    expect(invoke).toHaveBeenCalledWith('app:setMachinesPreview', true)
    expect(useMachinesStore.getState().preview).toBe(true)
  })

  it('stays as it was when main refuses the change', async () => {
    const { useMachinesStore } = await import('./machines')
    invoke.mockRejectedValueOnce(new Error('disk full'))
    await expect(useMachinesStore.getState().setPreview(true)).rejects.toThrow('disk full')
    expect(useMachinesStore.getState().preview).toBe(false)
  })

  it('turned off, resets the filter, the lanes and the page', async () => {
    const { useMachinesStore } = await import('./machines')
    const { useLayoutStore } = await import('./layout')
    const { FAKE_LANES } = await import('@/features/machines/fakeMachines')
    await useMachinesStore.getState().setPreview(true)
    useMachinesStore.getState().setFilter('bee1')
    useMachinesStore.getState().pretendFinished()
    useMachinesStore.getState().show({ kind: 'machine', id: 'bee1', tab: 'logins' })
    expect(useLayoutStore.getState().page).toBe('machines')

    await useMachinesStore.getState().setPreview(false)
    const state = useMachinesStore.getState()
    expect(state.filter).toBe('all')
    expect(state.lanes).toEqual(FAKE_LANES)
    expect(state.view).toEqual({ kind: 'list' })
    expect(useLayoutStore.getState().page).toBeNull()
  })

  it('turned off, leaves another page open', async () => {
    const { useMachinesStore } = await import('./machines')
    const { useLayoutStore } = await import('./layout')
    useLayoutStore.setState({ page: 'skills' })
    await useMachinesStore.getState().setPreview(false)
    expect(useLayoutStore.getState().page).toBe('skills')
  })
})

describe('a lane finishing on another machine', () => {
  beforeEach(async () => {
    const { useMachinesStore } = await import('./machines')
    useMachinesStore.getState().applyPreview(true)
  })

  it('sends the notice a real lane does, and opening it shows that lane', async () => {
    const { useMachinesStore } = await import('./machines')
    const { useLayoutStore } = await import('./layout')
    const { useExtensionUiStore } = await import('./extensionUi')
    useMachinesStore.getState().pretendFinished()

    const lane = useMachinesStore.getState().lanes.find((l) => l.id === 'bee1-bundle')
    expect(lane?.state).toBe('done')
    const [toast] = useExtensionUiStore.getState().toasts
    expect(toast).toMatchObject({
      title: 'Host bundle on Linux',
      message: 'Finished on bee1',
      kind: 'success',
      openLabel: 'Open lane',
    })
    toast?.onOpen?.()
    expect(useMachinesStore.getState().view).toEqual({ kind: 'lane', id: 'bee1-bundle' })
    expect(useLayoutStore.getState().page).toBe('machines')
  })

  it('does nothing for a lane that already finished', async () => {
    const { useMachinesStore } = await import('./machines')
    const { useExtensionUiStore } = await import('./extensionUi')
    useMachinesStore.getState().pretendFinished('bee1-bundle')
    useMachinesStore.getState().pretendFinished('bee1-bundle')
    expect(useExtensionUiStore.getState().toasts).toHaveLength(1)
  })
})

describe('with the preview off', () => {
  it('opens nothing and finishes nothing', async () => {
    const { useMachinesStore } = await import('./machines')
    const { useLayoutStore } = await import('./layout')
    const { useExtensionUiStore } = await import('./extensionUi')
    useMachinesStore.getState().show({ kind: 'machine', id: 'bee1', tab: 'overview' })
    useMachinesStore.getState().pretendFinished()
    expect(useLayoutStore.getState().page).toBeNull()
    expect(useMachinesStore.getState().view).toEqual({ kind: 'list' })
    expect(useMachinesStore.getState().lanes.every((lane) => lane.state !== 'done')).toBe(true)
    expect(useExtensionUiStore.getState().toasts).toHaveLength(0)
  })

  it('withdraws a notice it sent, and an old one does not bring the page back', async () => {
    const { useMachinesStore } = await import('./machines')
    const { useLayoutStore } = await import('./layout')
    const { useExtensionUiStore } = await import('./extensionUi')
    await useMachinesStore.getState().setPreview(true)
    useMachinesStore.getState().pretendFinished()
    const [toast] = useExtensionUiStore.getState().toasts
    expect(toast?.leaving).toBe(false)

    await useMachinesStore.getState().setPreview(false)
    expect(useExtensionUiStore.getState().toasts.find((t) => t.id === toast?.id)?.leaving).toBe(
      true,
    )
    toast?.onOpen?.()
    expect(useLayoutStore.getState().page).toBeNull()
  })

  it('leaves other notices alone when it goes off', async () => {
    const { useMachinesStore } = await import('./machines')
    const { useExtensionUiStore } = await import('./extensionUi')
    await useMachinesStore.getState().setPreview(true)
    const other = useExtensionUiStore
      .getState()
      .notify({ message: 'Lane finished', kind: 'success' })
    await useMachinesStore.getState().setPreview(false)
    expect(useExtensionUiStore.getState().toasts.find((t) => t.id === other)?.leaving).toBe(false)
  })
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
  async function start(signedIn = true) {
    const { attachMachinesListener, useMachinesStore } = await import('./machines')
    useMachinesStore.getState().applyPreview(true)
    invoke.mockResolvedValueOnce({
      preview: true,
      account: { status: signedIn ? 'signed-in' : 'signed-out' },
    })
    off = attachMachinesListener()
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
  it('ignores signals with the Machines preview off and starts when prefs enable it', async () => {
    const store = await start(false)
    store.getState().applyPreview(false)
    push({
      preview: true,
      account: {
        status: 'signed-in',
        user: { login: 'test', name: null, email: null },
        remembered: false,
      },
    })
    signal()
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    invoke.mockResolvedValueOnce({ ok: true, machines: [], serverTime: new Date().toISOString() })
    store.getState().applyPreview(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(invoke).toHaveBeenCalledWith('control:machines')
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
      preview: true,
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
    push({ preview: true, account: { status: 'signed-out' } })
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
      preview: true,
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
      preview: true,
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
