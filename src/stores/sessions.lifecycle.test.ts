import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('@/features/files/MonacoEditor', () => ({ releaseFileModel: vi.fn() }))

import type { SessionMeta } from '@shared/models'
import { bootstrapSession, useSessionsStore } from './sessions'
import { useChatStore } from './chat'

const meta = { path: '/repo/yo.jsonl', cwd: '/repo' } as SessionMeta
const invoke = vi.fn()
const piCommand = vi.fn()
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  invoke.mockReset().mockImplementation(async (channel: string) => {
    if (
      channel === 'sessions:list' ||
      channel === 'pi:listLiveSessions' ||
      channel === 'sessions:delete'
    )
      return []
    if (channel === 'pi:createSession') return { sessionId: 'new', workspacePath: '/repo' }
    return undefined
  })
  piCommand.mockReset().mockResolvedValue({ success: false })
  vi.stubGlobal('window', { phosphor: { invoke, piCommand, onSessionPush: () => () => {} } })
  useSessionsStore.setState({
    live: {},
    disk: {},
    unread: {},
    baselines: {},
    activeSessionId: null,
    deletingSessionKeys: [],
    bulkDelete: null,
  })
  useChatStore.setState({ sessions: {} })
})
afterEach(() => vi.unstubAllGlobals())

function live(id: string, diskPath?: string) {
  return { phosphorId: id, workspacePath: '/repo', diskPath }
}

describe('lane lifecycle races', () => {
  it('coalesces overlapping opens before main has returned a handle', async () => {
    const gate = deferred<void>()
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'pi:createSession') {
        await gate.promise
        return { sessionId: 'one-writer', workspacePath: '/repo' }
      }
      return []
    })
    const a = useSessionsStore.getState().openDiskSession('/repo', meta)
    const b = useSessionsStore.getState().openDiskSession('/repo', meta)
    gate.resolve()
    expect(await Promise.all([a, b])).toEqual(['one-writer', 'one-writer'])
    expect(invoke.mock.calls.filter(([c]) => c === 'pi:createSession')).toHaveLength(1)
    await useSessionsStore.getState().disposeSession('one-writer')
  })

  it('cleans every duplicate and any main-only orphan returned by delete', async () => {
    useSessionsStore.setState({
      live: { a: live('a', meta.path), b: live('b', meta.path), other: live('other', '/other') },
      activeSessionId: 'b',
    })
    useChatStore.getState().ensure('a')
    useChatStore.getState().ensure('b')
    invoke.mockImplementation(async (channel: string) =>
      channel === 'sessions:delete' ? ['a', 'b', 'unadopted'] : [],
    )
    await useSessionsStore.getState().deleteDiskSession('/repo', meta)
    expect(Object.keys(useSessionsStore.getState().live)).toEqual(['other'])
    expect(useChatStore.getState().sessions).toEqual({})
    expect(useSessionsStore.getState().activeSessionId).toBeNull()
  })

  it('deletes a live-only lane without requiring a transcript', async () => {
    useSessionsStore.setState({ live: { pending: live('pending') }, activeSessionId: 'pending' })
    await useSessionsStore.getState().deleteSession('/repo', { sessionId: 'pending' })
    expect(invoke).toHaveBeenCalledWith('sessions:delete', undefined, 'pending')
    expect(useSessionsStore.getState().live).toEqual({})
  })

  it('does not resurrect a deleted lane when bootstrap resolves late', async () => {
    const state = deferred<unknown>()
    const rest = deferred<unknown>()
    piCommand.mockImplementation((_id, cmd) =>
      cmd.type === 'get_state' ? state.promise : rest.promise,
    )
    useSessionsStore.setState({ live: { pending: live('pending') } })
    useChatStore.getState().ensure('pending')
    const boot = bootstrapSession('pending')
    await useSessionsStore.getState().deleteSession('/repo', { sessionId: 'pending' })
    state.resolve({ success: true, data: { sessionFile: meta.path } })
    rest.resolve({ success: true, data: { models: [], commands: [], levels: [] } })
    await boot
    expect(useSessionsStore.getState().live).toEqual({})
    expect(useChatStore.getState().sessions).toEqual({})
    expect(invoke).not.toHaveBeenCalledWith('claude:bindSession', meta.path, 'pending')
  })

  it('can delete a resumed lane while history replay is hung', async () => {
    const history = deferred<unknown>()
    piCommand.mockImplementation((_id, cmd) =>
      cmd.type === 'get_messages' ? history.promise : Promise.resolve({ success: false }),
    )
    const opening = useSessionsStore.getState().openDiskSession('/repo', meta)
    await vi.waitFor(() => expect(useSessionsStore.getState().live.new).toBeDefined())
    const deletion = deferred<string[]>()
    invoke.mockImplementation(async (channel: string) =>
      channel === 'sessions:delete' ? deletion.promise : [],
    )
    const deleting = useSessionsStore.getState().deleteDiskSession('/repo', meta)
    await expect(useSessionsStore.getState().openDiskSession('/repo', meta)).rejects.toThrow(
      'being deleted',
    )
    deletion.resolve(['new'])
    await deleting
    expect(useSessionsStore.getState().live).toEqual({})
    history.resolve({ success: true, data: { messages: [] } })
    await opening
    expect(useSessionsStore.getState().live).toEqual({})
    expect(useChatStore.getState().sessions).toEqual({})
  })

  it('reports deletion failure and releases the row for retry', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'sessions:delete') throw new Error('Trash unavailable')
      return []
    })
    useSessionsStore.setState({ live: { pending: live('pending') } })
    await expect(
      useSessionsStore.getState().deleteSession('/repo', { sessionId: 'pending' }),
    ).rejects.toThrow('Trash unavailable')
    expect(useSessionsStore.getState().deletingSessionKeys).toEqual([])
    expect(useSessionsStore.getState().live.pending).toBeDefined()
  })

  it('records bulk disposal failures and continues instead of leaving progress stuck', async () => {
    useSessionsStore.setState({ live: { a: live('a', meta.path) } })
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'pi:disposeSession') throw new Error('Cannot stop process')
      return []
    })
    const results = await useSessionsStore.getState().deleteManySessions(
      '/repo',
      [
        { path: meta.path, title: 'a', worktreePath: '/repo/wt', mainRepoPath: '/repo' },
        { path: '/other', title: 'b' },
      ],
      { removeWorktree: true, deleteBranch: false, discardChanges: false },
    )
    expect(results).toMatchObject([
      { ok: false, error: 'Error: Cannot stop process' },
      { ok: true },
    ])
    expect(useSessionsStore.getState().bulkDelete?.running).toBe(false)
  })
})
