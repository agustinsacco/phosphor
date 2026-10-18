import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NO_COMMANDS, usePiCommandsStore } from './piCommands'

const invoke = vi.fn()

beforeEach(() => {
  invoke.mockReset()
  vi.stubGlobal('window', { phosphor: { invoke } })
  usePiCommandsStore.setState({ byWorkspace: {}, status: {}, error: {} })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('usePiCommandsStore', () => {
  it('reports loading while the probe runs, then ready with the list', async () => {
    let resolve!: (value: unknown) => void
    invoke.mockReturnValueOnce(new Promise((r) => (resolve = r)))
    const loading = usePiCommandsStore.getState().load('/ws')
    expect(usePiCommandsStore.getState().status['/ws']).toBe('loading')
    resolve({ commands: [{ name: 'a', source: 'extension' }] })
    await loading
    const state = usePiCommandsStore.getState()
    expect(state.status['/ws']).toBe('ready')
    expect(state.byWorkspace['/ws']).toEqual([{ name: 'a', source: 'extension' }])
    expect(state.error['/ws']).toBeUndefined()
  })

  it('makes one call for a burst of `/` keystrokes', async () => {
    invoke.mockResolvedValue({ commands: [] })
    const store = usePiCommandsStore.getState()
    await Promise.all([store.load('/ws'), store.load('/ws'), store.load('/ws')])
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('keeps the reason pi could not be asked, and asks again next time', async () => {
    invoke.mockResolvedValueOnce({ commands: [], error: 'pi is not installed' })
    await usePiCommandsStore.getState().load('/ws')
    let state = usePiCommandsStore.getState()
    expect(state.status['/ws']).toBe('error')
    expect(state.error['/ws']).toBe('pi is not installed')
    expect(state.byWorkspace['/ws']).toBeUndefined()

    invoke.mockResolvedValueOnce({ commands: [{ name: 'a', source: 'skill' }] })
    await usePiCommandsStore.getState().load('/ws')
    state = usePiCommandsStore.getState()
    expect(state.status['/ws']).toBe('ready')
    expect(state.error['/ws']).toBeUndefined()
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('treats a rejected IPC call the same way', async () => {
    invoke.mockRejectedValueOnce(new Error('boom'))
    await usePiCommandsStore.getState().load('/ws')
    expect(usePiCommandsStore.getState().status['/ws']).toBe('error')
    expect(usePiCommandsStore.getState().error['/ws']).toBe('boom')
  })

  it('forgets every folder on invalidateAll so the next `/` re-asks', async () => {
    invoke.mockResolvedValue({ commands: [{ name: 'a', source: 'extension' }] })
    await usePiCommandsStore.getState().load('/ws')
    usePiCommandsStore.getState().invalidateAll()
    expect(usePiCommandsStore.getState().byWorkspace['/ws']).toBeUndefined()
    expect(usePiCommandsStore.getState().status['/ws']).toBeUndefined()
    await usePiCommandsStore.getState().load('/ws')
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('exposes one shared frozen empty list for selectors', () => {
    expect(Object.isFrozen(NO_COMMANDS)).toBe(true)
    expect(NO_COMMANDS).toHaveLength(0)
  })
})
