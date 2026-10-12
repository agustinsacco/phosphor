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
