import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  it('applies the server clock offset and ignores an answer after the page closes', async () => {
    const { useMachinesStore } = await import('./machines')
    const { MACHINE } = await import('@/features/machines/__fixtures__/control')
    const now = Date.now()
    useMachinesStore.getState().applyPreview(true)
    useMachinesStore.getState().enableRemote(true)
    invoke.mockResolvedValueOnce({
      ok: true,
      machines: [MACHINE],
      serverTime: new Date(now + 60_000).toISOString(),
    })
    await useMachinesStore.getState().refresh()
    expect(useMachinesStore.getState().machines).toEqual([MACHINE])
    expect(useMachinesStore.getState().clockOffsetMs).toBeGreaterThan(59_000)
    let resolve: ((value: unknown) => void) | undefined
    invoke.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done
        }),
    )
    const request = useMachinesStore.getState().refresh()
    useMachinesStore.getState().enableRemote(false)
    resolve?.({ ok: true, machines: [MACHINE], serverTime: new Date(now).toISOString() })
    await request
    expect(useMachinesStore.getState().machines).toEqual([])
    expect(useMachinesStore.getState().loading).toBe(false)
  })
  it('keeps the newest refresh and clears data on a control signed-out response', async () => {
    const { useMachinesStore } = await import('./machines')
    useMachinesStore.getState().applyPreview(true)
    useMachinesStore.getState().enableRemote(true)
    let finish: ((value: unknown) => void) | undefined
    invoke.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const older = useMachinesStore.getState().refresh()
    invoke.mockResolvedValueOnce({ ok: true, machines: [], serverTime: new Date().toISOString() })
    await useMachinesStore.getState().refresh()
    finish?.({ ok: false, error: { code: 'offline', message: '' } })
    await older
    expect(useMachinesStore.getState().error).toBeNull()
    const { MACHINE } = await import('@/features/machines/__fixtures__/control')
    invoke.mockResolvedValueOnce({
      ok: true,
      machines: [MACHINE],
      serverTime: new Date().toISOString(),
    })
    await useMachinesStore.getState().refresh()
    invoke.mockResolvedValueOnce({ ok: false, error: { code: 'signed-out', message: '' } })
    await useMachinesStore.getState().refresh()
    expect(useMachinesStore.getState().machines).toEqual([])
    expect(useMachinesStore.getState().error).toBe('signed-out')
  })
  it('does not call control while signed out or preview-off and surfaces errors without peer messages', async () => {
    const { useMachinesStore } = await import('./machines')
    await useMachinesStore.getState().refresh()
    useMachinesStore.getState().applyPreview(true)
    await useMachinesStore.getState().refresh()
    expect(invoke).not.toHaveBeenCalled()
    useMachinesStore.getState().enableRemote(true)
    invoke.mockResolvedValueOnce({ ok: false, error: { code: 'offline', message: 'not retained' } })
    await useMachinesStore.getState().refresh()
    expect(useMachinesStore.getState().error).toBe('offline')
    expect(useMachinesStore.getState().loading).toBe(false)
    invoke.mockRejectedValueOnce(new Error('not retained'))
    await useMachinesStore.getState().refresh()
    expect(useMachinesStore.getState().error).toBe('offline')
  })
})
