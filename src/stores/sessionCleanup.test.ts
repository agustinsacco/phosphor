import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useArtifactsStore } from './artifacts'
import { useExtensionUiStore } from './extensionUi'

/**
 * Per-session state must be released when a session is disposed. Every record
 * keyed by session id is a leak if `remove`/`clearSession` misses it — with
 * each pi subprocess costing ~200MB, long-lived sessions are exactly the
 * scenario where retained renderer state also adds up.
 */
describe('artifacts store cleanup', () => {
  beforeEach(() => {
    useArtifactsStore.setState({ bySession: {}, selected: {}, selectedVersion: {}, unseen: {} })
  })

  it('removes every record keyed by the session, not just bySession', () => {
    // Regression: `remove` cleaned `bySession` and left `selected`,
    // `selectedVersion` and `unseen` behind for every disposed session.
    useArtifactsStore.setState({
      bySession: { s1: {}, s2: {} },
      selected: { s1: 'a1', s2: 'a2' },
      selectedVersion: { s1: 3, s2: 1 },
      unseen: { s1: 2, s2: 5 },
    })

    useArtifactsStore.getState().remove('s1')
    const state = useArtifactsStore.getState()

    expect(state.bySession).not.toHaveProperty('s1')
    expect(state.selected).not.toHaveProperty('s1')
    expect(state.selectedVersion).not.toHaveProperty('s1')
    expect(state.unseen).not.toHaveProperty('s1')

    // The surviving session is untouched.
    expect(state.bySession).toHaveProperty('s2')
    expect(state.selected.s2).toBe('a2')
    expect(state.selectedVersion.s2).toBe(1)
    expect(state.unseen.s2).toBe(5)
  })

  it('is a no-op for an unknown session', () => {
    useArtifactsStore.setState({ bySession: { keep: {} }, selected: { keep: 'x' } })
    useArtifactsStore.getState().remove('never-existed')
    expect(useArtifactsStore.getState().bySession).toHaveProperty('keep')
    expect(useArtifactsStore.getState().selected.keep).toBe('x')
  })
})

describe('extension UI store cleanup', () => {
  it('clears both statuses and widgets for the session', () => {
    // Regression: `clearSession` existed but had NO call sites, so extension
    // statuses and widgets (which hold extension-supplied line arrays)
    // accumulated for every session until quit. It is now called from
    // disposeSession.
    useExtensionUiStore.setState({
      statuses: { s1: { a: 'busy' }, s2: { b: 'idle' } },
      widgets: { s1: [{ id: 'w', lines: ['x'] }], s2: [] },
    } as never)

    useExtensionUiStore.getState().clearSession('s1')
    const state = useExtensionUiStore.getState()

    expect(state.statuses).not.toHaveProperty('s1')
    expect(state.widgets).not.toHaveProperty('s1')
    expect(state.statuses).toHaveProperty('s2')
  })
})

describe('disposeSession wiring', () => {
  it('releases baselines, and calls the artifact/extension/terminal cleanups', async () => {
    // The store's dispose path is what ties the per-session records together;
    // a missing line here is a silent leak, so assert the wiring itself.
    vi.stubGlobal('window', {
      phosphor: {
        invoke: vi.fn().mockResolvedValue(undefined),
        onSessionPush: vi.fn(() => () => {}),
      },
    })

    const { useSessionsStore } = await import('./sessions')
    useSessionsStore.setState({
      live: { s1: { phosphorId: 's1', workspacePath: '/w' } },
      unread: { s1: 3 },
      baselines: { s1: 'ref-abc' },
      activeSessionId: 's1',
    })
    useArtifactsStore.setState({ bySession: { s1: {} }, selected: { s1: 'a' } })
    useExtensionUiStore.setState({ statuses: { s1: {} }, widgets: { s1: [] } } as never)

    await useSessionsStore.getState().disposeSession('s1')

    const state = useSessionsStore.getState()
    expect(state.live).not.toHaveProperty('s1')
    expect(state.unread).not.toHaveProperty('s1')
    // Was missing: every disposed session left a permanent baselines entry.
    expect(state.baselines).not.toHaveProperty('s1')
    expect(state.activeSessionId).toBeNull()

    // Lazy-imported cleanups are fire-and-forget; let their microtasks settle.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(useArtifactsStore.getState().bySession).not.toHaveProperty('s1')
    expect(useArtifactsStore.getState().selected).not.toHaveProperty('s1')
    expect(useExtensionUiStore.getState().statuses).not.toHaveProperty('s1')

    vi.unstubAllGlobals()
  })
})
