import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('window', { phosphor: { invoke: vi.fn().mockResolvedValue(undefined) } })

const { useLayoutStore, sessionPanes, sanitizePersistedPanes } = await import('./layout')
const { useSessionsStore } = await import('./sessions')

const A = 'session-a'
const B = 'session-b'

beforeEach(() => {
  useLayoutStore.setState({ bySession: {}, sidebarVisible: true, page: null })
  useSessionsStore.setState({ activeSessionId: A })
})

describe('layout store — global pages', () => {
  it('toggles a page open and closed, and swaps between pages', () => {
    useLayoutStore.getState().togglePage('skills')
    expect(useLayoutStore.getState().page).toBe('skills')

    useLayoutStore.getState().togglePage('artifacts')
    expect(useLayoutStore.getState().page).toBe('artifacts')

    useLayoutStore.getState().togglePage('artifacts')
    expect(useLayoutStore.getState().page).toBeNull()
  })

  it('opens with no active session — pages are global, unlike right panes', () => {
    // The old sidebar rows toggled a per-session pane, which silently no-oped
    // on the home screen. The page must not need a session.
    useSessionsStore.setState({ activeSessionId: null })
    useLayoutStore.getState().togglePage('skills')
    expect(useLayoutStore.getState().page).toBe('skills')
  })

  it('closes on session activation, including re-activating the current one', () => {
    useLayoutStore.getState().setPage('artifacts')
    useSessionsStore.getState().activate(A)
    expect(useLayoutStore.getState().page).toBeNull()

    // Clicking the ALREADY-active session's row means "show me the chat" too;
    // no observable session state changes, so only a direct call covers it.
    useLayoutStore.getState().setPage('skills')
    useSessionsStore.getState().activate(A)
    expect(useLayoutStore.getState().page).toBeNull()

    // "New" (activate null) from the home screen closes it as well.
    useSessionsStore.setState({ activeSessionId: null })
    useLayoutStore.getState().setPage('skills')
    useSessionsStore.getState().activate(null)
    expect(useLayoutStore.getState().page).toBeNull()
  })
})

describe('layout store — right pane is per session', () => {
  it('does not leak an open pane into another session', () => {
    // The bug: rightPane was global, so opening a terminal in one session
    // showed the terminal pane in every session you switched to — and since
    // the pane auto-spawns a shell on first open, merely visiting another
    // session forked a login shell there.
    useLayoutStore.getState().toggleRightPane('terminal')

    expect(sessionPanes(useLayoutStore.getState(), A).pane).toBe('terminal')
    expect(sessionPanes(useLayoutStore.getState(), B).pane).toBeNull()
  })

  it('remembers each session\u2019s own pane across switches', () => {
    useLayoutStore.getState().setRightPane('terminal', A)
    useLayoutStore.getState().setRightPane('files', B)

    expect(sessionPanes(useLayoutStore.getState(), A).pane).toBe('terminal')
    expect(sessionPanes(useLayoutStore.getState(), B).pane).toBe('files')
  })

  it('defaults actions to the active session', () => {
    useSessionsStore.setState({ activeSessionId: B })
    useLayoutStore.getState().toggleRightPane('artifacts')

    expect(sessionPanes(useLayoutStore.getState(), B).pane).toBe('artifacts')
    expect(sessionPanes(useLayoutStore.getState(), A).pane).toBeNull()
  })

  it('toggling the open pane closes it', () => {
    useLayoutStore.getState().toggleRightPane('files')
    useLayoutStore.getState().toggleRightPane('files')
    expect(sessionPanes(useLayoutStore.getState(), A).pane).toBeNull()
  })

  it('switching panes replaces rather than closes', () => {
    useLayoutStore.getState().toggleRightPane('files')
    useLayoutStore.getState().toggleRightPane('terminal')
    expect(sessionPanes(useLayoutStore.getState(), A).pane).toBe('terminal')
  })

  it('scopes expand (\u2197) per session too', () => {
    useLayoutStore.getState().setRightPane('files', A)
    useLayoutStore.getState().toggleRightExpanded(A)

    expect(sessionPanes(useLayoutStore.getState(), A).expanded).toBe(true)
    expect(sessionPanes(useLayoutStore.getState(), B).expanded).toBe(false)
  })

  it('is a no-op with no active session (workspace home has no right pane)', () => {
    useSessionsStore.setState({ activeSessionId: null })
    useLayoutStore.getState().toggleRightPane('terminal')
    expect(useLayoutStore.getState().bySession).toEqual({})
  })

  it('removeSession drops the slice so the map cannot grow forever', () => {
    useLayoutStore.getState().setRightPane('terminal', A)
    useLayoutStore.getState().removeSession(A)
    expect(useLayoutStore.getState().bySession[A]).toBeUndefined()
  })

  it('returns one shared frozen value for unknown sessions', () => {
    const state = useLayoutStore.getState()
    expect(sessionPanes(state, 'nope')).toBe(sessionPanes(state, 'also-nope'))
    expect(sessionPanes(state, null)).toBe(sessionPanes(state, undefined))
    expect(Object.isFrozen(sessionPanes(state, 'nope'))).toBe(true)
  })

  it('defaults to a closed pane on the right at 45%', () => {
    const slice = sessionPanes(useLayoutStore.getState(), 'unknown')
    expect(slice).toMatchObject({ pane: null, expanded: false, side: 'right', size: 45 })
  })

  it('scopes side and size per session', () => {
    useLayoutStore.getState().togglePaneSide(A)
    useLayoutStore.getState().setPaneSize(60, A)

    expect(sessionPanes(useLayoutStore.getState(), A)).toMatchObject({ side: 'left', size: 60 })
    expect(sessionPanes(useLayoutStore.getState(), B)).toMatchObject({ side: 'right', size: 45 })

    useLayoutStore.getState().togglePaneSide(A)
    expect(sessionPanes(useLayoutStore.getState(), A).side).toBe('right')
  })
})

describe('layout store — persisted layout sanitizing', () => {
  it('keeps well-formed entries and defaults every bad field', () => {
    const restored = sanitizePersistedPanes({
      [A]: { pane: 'artifacts', expanded: true, side: 'left', size: 60 },
      [B]: { pane: 'not-a-pane', expanded: 'yes', side: 'up', size: 9001 },
    })

    expect(restored[A]).toEqual({ pane: 'artifacts', expanded: true, side: 'left', size: 60 })
    expect(restored[B]).toEqual({ pane: null, expanded: false, side: 'right', size: 45 })
  })

  it('rejects non-object payloads outright', () => {
    expect(sanitizePersistedPanes(null)).toEqual({})
    expect(sanitizePersistedPanes('corrupt')).toEqual({})
    expect(sanitizePersistedPanes([1, 2])).toEqual({})
    expect(sanitizePersistedPanes({ [A]: 'corrupt' })).toEqual({})
  })

  it('drops a persisted skills pane from before skills became a page', () => {
    const restored = sanitizePersistedPanes({
      [A]: { pane: 'skills', expanded: false, side: 'right', size: 45 },
    })
    expect(restored[A]!.pane).toBeNull()
  })
})
