import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Suspending reclaims a session's pi subprocess (~200MB measured) while keeping
 * its sidebar row. The marker is keyed by DISK PATH, not phosphorId, because the
 * phosphorId dies with the process — that is what lets the row stay labelled and
 * the reopen path clear it.
 */
const invoke = vi.fn().mockResolvedValue(undefined)

beforeEach(async () => {
  invoke.mockClear()
  vi.stubGlobal('window', {
    phosphor: {
      invoke,
      onSessionPush: vi.fn(() => () => {}),
      // bootstrapSession fires these; without a stub they reject unhandled.
      piCommand: vi.fn().mockResolvedValue({ success: true, data: {} }),
    },
  })
  const { useSessionsStore } = await import('./sessions')
  useSessionsStore.setState({
    live: {},
    unread: {},
    baselines: {},
    suspendedPaths: [],
    activeSessionId: null,
  })
})

describe('suspendSession', () => {
  it('disposes the process and marks the session suspended by disk path', async () => {
    const { useSessionsStore } = await import('./sessions')
    useSessionsStore.setState({
      live: { s1: { phosphorId: 's1', workspacePath: '/w', diskPath: '/sessions/a.jsonl' } },
      activeSessionId: 's1',
    })

    await useSessionsStore.getState().suspendSession('s1')

    const state = useSessionsStore.getState()
    expect(state.live).not.toHaveProperty('s1')
    expect(state.suspendedPaths).toEqual(['/sessions/a.jsonl'])
    expect(invoke).toHaveBeenCalledWith('pi:disposeSession', 's1')
  })

  it('does not record a marker for a session with no file yet', async () => {
    // A brand-new session has no disk path to reopen from, so there is nothing
    // to label.
    const { useSessionsStore } = await import('./sessions')
    useSessionsStore.setState({ live: { s2: { phosphorId: 's2', workspacePath: '/w' } } })

    await useSessionsStore.getState().suspendSession('s2')

    expect(useSessionsStore.getState().suspendedPaths).toEqual([])
  })

  it('does not duplicate the marker when suspended twice', async () => {
    const { useSessionsStore } = await import('./sessions')
    useSessionsStore.setState({
      live: { s1: { phosphorId: 's1', workspacePath: '/w', diskPath: '/sessions/a.jsonl' } },
      suspendedPaths: ['/sessions/a.jsonl'],
    })

    await useSessionsStore.getState().suspendSession('s1')

    expect(useSessionsStore.getState().suspendedPaths).toEqual(['/sessions/a.jsonl'])
  })

  it('clears the marker when the session is reopened', async () => {
    const { useSessionsStore } = await import('./sessions')
    useSessionsStore.setState({ suspendedPaths: ['/sessions/a.jsonl', '/sessions/b.jsonl'] })
    invoke.mockResolvedValue({ sessionId: 'new-id' })

    await useSessionsStore.getState().openDiskSession('/w', {
      path: '/sessions/a.jsonl',
      cwd: '/w',
    } as never)

    // Only the reopened session's marker is cleared.
    expect(useSessionsStore.getState().suspendedPaths).toEqual(['/sessions/b.jsonl'])
  })

  it('reactivates an already-live session instead of respawning it', async () => {
    const { useSessionsStore } = await import('./sessions')
    useSessionsStore.setState({
      live: { s1: { phosphorId: 's1', workspacePath: '/w', diskPath: '/sessions/a.jsonl' } },
    })

    const id = await useSessionsStore
      .getState()
      .openDiskSession('/w', { path: '/sessions/a.jsonl', cwd: '/w' } as never)

    expect(id).toBe('s1')
    expect(invoke).not.toHaveBeenCalledWith('pi:createSession', expect.anything())
  })
})
