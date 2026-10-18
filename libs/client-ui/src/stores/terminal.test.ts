import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.stubGlobal('window', {
  phosphor: { invoke },
})

// sessions/layout stores pull in window.phosphor at import in some paths; the
// stub above must exist before the store module loads.
const { useTerminalStore, sessionTerminals, runningCount, runInTerminal, ensureTerminalTab } =
  await import('./terminal')
const { useSessionsStore } = await import('./sessions')
const { useLayoutStore } = await import('./layout')

let nextPty = 1

beforeEach(() => {
  useTerminalStore.setState({ bySession: {}, pendingPaste: null })
  useSessionsStore.setState({
    activeSessionId: 'session-a',
    live: { 'session-a': { phosphorId: 'session-a', workspacePath: '/repo/lane' } },
  })
  useLayoutStore.setState({ bySession: {} })
  nextPty = 1
  invoke.mockReset()
  invoke.mockImplementation((channel: string) => {
    if (channel === 'pty:create') return Promise.resolve({ ptyId: `pty-${nextPty++}` })
    return Promise.resolve(undefined)
  })
})

describe('terminal store (per-session)', () => {
  it('keys tabs by session id', async () => {
    const store = useTerminalStore.getState()
    await store.createTab('session-a', '/repo')
    await store.createTab('session-b', '/repo')
    const state = useTerminalStore.getState()
    expect(sessionTerminals(state, 'session-a').tabs).toHaveLength(1)
    expect(sessionTerminals(state, 'session-b').tabs).toHaveLength(1)
    expect(sessionTerminals(state, 'session-c')).toBe(sessionTerminals(state, 'session-d'))
  })

  it('markExited finds the owning session by ptyId alone', async () => {
    await useTerminalStore.getState().createTab('session-a', '/repo')
    const ptyId = sessionTerminals(useTerminalStore.getState(), 'session-a').tabs[0]!.ptyId
    useTerminalStore.getState().markExited(ptyId)
    const tab = sessionTerminals(useTerminalStore.getState(), 'session-a').tabs[0]!
    expect(tab.exited).toBe(true)
    expect(tab.running).toBe(false)
  })

  it('applyStatus updates running flags and runningCount', async () => {
    await useTerminalStore.getState().createTab('session-a', '/repo')
    await useTerminalStore.getState().createTab('session-a', '/repo')
    const tabs = sessionTerminals(useTerminalStore.getState(), 'session-a').tabs
    useTerminalStore.getState().applyStatus({ [tabs[0]!.ptyId]: true })
    expect(runningCount(useTerminalStore.getState(), 'session-a')).toBe(1)
    useTerminalStore.getState().applyStatus({ [tabs[0]!.ptyId]: false })
    expect(runningCount(useTerminalStore.getState(), 'session-a')).toBe(0)
  })

  it('removeSession kills every pty and drops the slice', async () => {
    await useTerminalStore.getState().createTab('session-a', '/repo')
    await useTerminalStore.getState().createTab('session-a', '/repo')
    invoke.mockClear()
    await useTerminalStore.getState().removeSession('session-a')
    expect(invoke.mock.calls.filter(([c]) => c === 'pty:kill')).toHaveLength(2)
    expect(useTerminalStore.getState().bySession['session-a']).toBeUndefined()
  })

  it('closeTab moves activeId to the remaining tab', async () => {
    const store = useTerminalStore.getState()
    await store.createTab('session-a', '/repo')
    await store.createTab('session-a', '/repo')
    const [first, second] = sessionTerminals(useTerminalStore.getState(), 'session-a').tabs
    await useTerminalStore.getState().closeTab('session-a', second!.ptyId)
    expect(sessionTerminals(useTerminalStore.getState(), 'session-a').activeId).toBe(first!.ptyId)
  })
})

describe('run in terminal', () => {
  it('spawns once in the lane cwd and targets that PTY without executing', async () => {
    await Promise.all([
      runInTerminal('/repo', 'echo hello\n'),
      ensureTerminalTab('session-a', '/repo/lane'),
    ])
    expect(invoke.mock.calls.filter(([c]) => c === 'pty:create')).toHaveLength(1)
    expect(invoke).toHaveBeenCalledWith('pty:create', '/repo/lane', 80, 24, 'session-a')
    expect(useTerminalStore.getState().pendingPaste).toEqual({
      ptyId: 'pty-1',
      text: 'echo hello',
      execute: false,
    })
    expect(invoke.mock.calls.filter(([c]) => c === 'pty:write')).toHaveLength(0)
  })

  it('only the target PTY can consume the paste, including identical repeats', async () => {
    await runInTerminal('/repo', 'echo hello')
    const store = useTerminalStore.getState()
    expect(store.consumePaste('login-pty')).toBeNull()
    const first = store.consumePaste('pty-1')
    expect(first?.text).toBe('echo hello')
    expect(store.consumePaste('pty-1')).toBeNull()
    await runInTerminal('/repo', 'echo hello')
    expect(store.consumePaste('pty-1')).toEqual(first)
    expect(invoke.mock.calls.filter(([c]) => c === 'pty:create')).toHaveLength(1)
  })

  it('keeps multiline paste separate from the explicit Enter request', async () => {
    await runInTerminal('/repo', 'echo one\necho two\r\n', { execute: true })
    expect(useTerminalStore.getState().pendingPaste).toEqual({
      ptyId: 'pty-1',
      text: 'echo one\necho two',
      execute: true,
    })
  })

  it.each(['exited', 'running'] as const)('does not paste into a %s tab', async (state) => {
    await useTerminalStore.getState().createTab('session-a', '/repo/lane')
    if (state === 'exited') useTerminalStore.getState().markExited('pty-1')
    else useTerminalStore.getState().applyStatus({ 'pty-1': true })
    await runInTerminal('/repo', 'echo hello')
    expect(useTerminalStore.getState().pendingPaste?.ptyId).toBe('pty-2')
  })

  it('does not queue a command when spawning fails', async () => {
    invoke.mockRejectedValueOnce(new Error('cannot start'))
    await runInTerminal('/repo', 'echo hello')
    expect(useTerminalStore.getState().pendingPaste).toBeNull()
    expect(sessionTerminals(useTerminalStore.getState(), 'session-a').error).toBe('cannot start')
  })
})

describe('terminal store — spawn failures', () => {
  it('surfaces the spawn error instead of rejecting, so the pane can react', async () => {
    // The bug: `void createTab(...)` on first open meant a rejected pty:create
    // produced an unhandled rejection, no tab, and no error — the pane sat on
    // "Starting shell…" forever with no way to retry.
    invoke.mockImplementation((channel: string) =>
      channel === 'pty:create'
        ? Promise.reject(
            new Error("Error invoking remote method 'pty:create': Error: posix_spawnp failed."),
          )
        : Promise.resolve(undefined),
    )

    const ptyId = await useTerminalStore.getState().createTab('session-a', '/repo')

    expect(ptyId).toBeNull()
    const state = sessionTerminals(useTerminalStore.getState(), 'session-a')
    expect(state.tabs).toHaveLength(0)
    // Electron's "Error invoking remote method" wrapper is noise to a user.
    expect(state.error).toBe('posix_spawnp failed.')
  })

  it('clearError lets the pane arm a retry', async () => {
    invoke.mockImplementation((channel: string) =>
      channel === 'pty:create' ? Promise.reject(new Error('boom')) : Promise.resolve(undefined),
    )
    await useTerminalStore.getState().createTab('session-a', '/repo')
    expect(sessionTerminals(useTerminalStore.getState(), 'session-a').error).toBe('boom')

    useTerminalStore.getState().clearError('session-a')
    expect(sessionTerminals(useTerminalStore.getState(), 'session-a').error).toBeNull()
  })

  it('a successful spawn clears a previous error', async () => {
    invoke.mockImplementationOnce(() => Promise.reject(new Error('boom')))
    await useTerminalStore.getState().createTab('session-a', '/repo')
    expect(sessionTerminals(useTerminalStore.getState(), 'session-a').error).toBe('boom')

    invoke.mockImplementation((channel: string) =>
      channel === 'pty:create' ? Promise.resolve({ ptyId: 'pty-ok' }) : Promise.resolve(undefined),
    )
    await useTerminalStore.getState().createTab('session-a', '/repo')
    const state = sessionTerminals(useTerminalStore.getState(), 'session-a')
    expect(state.error).toBeNull()
    expect(state.activeId).toBe('pty-ok')
  })

  it('closeTab keeps the error field (patches must not drop slice state)', async () => {
    await useTerminalStore.getState().createTab('session-a', '/repo')
    const ptyId = sessionTerminals(useTerminalStore.getState(), 'session-a').tabs[0]!.ptyId
    await useTerminalStore.getState().closeTab('session-a', ptyId)
    expect(sessionTerminals(useTerminalStore.getState(), 'session-a').error).toBeNull()
  })
})
