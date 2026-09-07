import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Moving a lane to another Claude account is a respawn, not a mutation: the
 * credential is fixed by the environment pi was spawned with, and the CLI
 * process is parked for the lane's whole life. So the order matters — the
 * binding has to be written BEFORE the new spawn reads it, or the lane comes
 * back on the account it was trying to leave.
 */
const invoke = vi.fn()

beforeEach(async () => {
  invoke.mockReset()
  invoke.mockImplementation((channel: string) =>
    channel === 'pi:createSession'
      ? Promise.resolve({ sessionId: 'moved', workspacePath: '/w' })
      : Promise.resolve(undefined),
  )
  vi.stubGlobal('window', {
    pidex: {
      invoke,
      onSessionPush: vi.fn(() => () => {}),
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

describe('moveSessionToAccount', () => {
  it('binds the file, drops the old process, and resumes the same file', async () => {
    const { useSessionsStore } = await import('./sessions')
    useSessionsStore.setState({
      live: { s1: { pidexId: 's1', workspacePath: '/w', diskPath: '/sessions/a.jsonl' } },
      activeSessionId: 's1',
    })

    const id = await useSessionsStore.getState().moveSessionToAccount('s1', 'work')

    expect(id).toBe('moved')
    const channels = invoke.mock.calls.map((call) => call[0])
    expect(channels.indexOf('claude:assignSession')).toBeLessThan(
      channels.indexOf('pi:createSession'),
    )
    expect(invoke).toHaveBeenCalledWith('claude:assignSession', '/sessions/a.jsonl', 'work')
    expect(invoke).toHaveBeenCalledWith('pi:disposeSession', 's1')
    expect(invoke).toHaveBeenCalledWith(
      'pi:createSession',
      expect.objectContaining({ workspacePath: '/w', sessionPath: '/sessions/a.jsonl' }),
    )
    expect(useSessionsStore.getState().live).not.toHaveProperty('s1')
  })

  it('refuses a lane with no session file, rather than losing it', async () => {
    // pi writes the file when the first turn ENDS, so a lane mid-first-turn has
    // nothing to resume from: disposing it would throw the thread away.
    const { useSessionsStore } = await import('./sessions')
    useSessionsStore.setState({ live: { s2: { pidexId: 's2', workspacePath: '/w' } } })

    expect(await useSessionsStore.getState().moveSessionToAccount('s2', 'work')).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('pi:disposeSession', 's2')
  })

  it('keeps the lane when the binding cannot be written', async () => {
    const { useSessionsStore } = await import('./sessions')
    useSessionsStore.setState({
      live: { s1: { pidexId: 's1', workspacePath: '/w', diskPath: '/sessions/a.jsonl' } },
    })
    invoke.mockImplementation((channel: string) =>
      channel === 'claude:assignSession'
        ? Promise.reject(new Error('no such account'))
        : Promise.resolve(undefined),
    )

    await expect(useSessionsStore.getState().moveSessionToAccount('s1', 'gone')).rejects.toThrow(
      'no such account',
    )
    expect(invoke).not.toHaveBeenCalledWith('pi:disposeSession', 's1')
    expect(useSessionsStore.getState().live).toHaveProperty('s1')
  })
})
