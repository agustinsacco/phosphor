import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdateState } from '@shared/models'
import { isUpdateVisible, useUpdatesStore } from './updatesStore'

describe('isUpdateVisible', () => {
  const visible = (phase: UpdateState['phase']): boolean => isUpdateVisible({ phase })

  it('shows only when there is something to see or act on', () => {
    expect(visible('downloading')).toBe(true)
    expect(visible('downloaded')).toBe(true)
    expect(visible('manual-download')).toBe(true)
  })

  it('stays hidden for idle, checking, and unsupported', () => {
    // The pill must not flicker on every 30-minute poll, and a dev build has
    // no update mechanism at all — neither should draw the eye.
    expect(visible('idle')).toBe(false)
    expect(visible('checking')).toBe(false)
    expect(visible('unsupported')).toBe(false)
  })
})

describe('updates store', () => {
  const invoke = vi.fn()
  let pushListener: ((state: UpdateState) => void) | null = null
  const unsubscribe = vi.fn()

  beforeEach(() => {
    invoke.mockReset().mockResolvedValue(undefined)
    unsubscribe.mockReset()
    pushListener = null
    vi.stubGlobal('window', {
      phosphor: {
        invoke,
        onUpdateEvent: (listener: (state: UpdateState) => void) => {
          pushListener = listener
          return unsubscribe
        },
      },
    })
    useUpdatesStore.setState({ update: { phase: 'idle' }, acting: false })
  })

  it('records pushed state and detaches its listener', () => {
    const detach = useUpdatesStore.getState().subscribe()
    pushListener?.({ phase: 'downloaded', version: '0.1.42' })
    expect(useUpdatesStore.getState().update).toEqual({ phase: 'downloaded', version: '0.1.42' })

    detach()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('reads the current state on subscribe, for a window opened mid-download', () => {
    invoke.mockResolvedValue({ phase: 'downloading', version: '0.1.42', progressPercent: 30 })
    useUpdatesStore.getState().subscribe()
    expect(invoke).toHaveBeenCalledWith('updates:state')
  })

  it('does not double-fire the install while one is in flight', async () => {
    // quitAndInstall tears the app down; a second click mid-teardown is at
    // best wasted and at worst a race.
    let release: (() => void) | undefined
    invoke.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        }),
    )

    const store = useUpdatesStore.getState()
    const first = store.restartAndInstall()
    await Promise.resolve()
    expect(useUpdatesStore.getState().acting).toBe(true)

    await useUpdatesStore.getState().restartAndInstall()
    expect(invoke).toHaveBeenCalledTimes(1)

    release?.()
    await first
    expect(useUpdatesStore.getState().acting).toBe(false)
  })

  it('clears the acting flag even when the install call rejects', async () => {
    invoke.mockRejectedValue(new Error('boom'))
    await expect(useUpdatesStore.getState().restartAndInstall()).rejects.toThrow('boom')
    // Otherwise the button would stay dead until relaunch.
    expect(useUpdatesStore.getState().acting).toBe(false)
  })
})
