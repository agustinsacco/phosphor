import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('@/features/files/MonacoEditor', () => ({ releaseFileModel: vi.fn() }))

import { useSessionsStore } from './sessions'
import { useChatStore } from './chat'
import { useWorktreesStore } from './worktrees'

type Lane = Parameters<
  ReturnType<typeof useSessionsStore.getState>['deleteManySessions']
>[1][number]
type Handler = (channel: string, ...args: unknown[]) => unknown

const invoke = vi.fn()
const piCommand = vi.fn()
const realRefreshDisk = useSessionsStore.getState().refreshDisk
const keepWorktree = { removeWorktree: false, deleteBranch: false, discardChanges: false }
const removeWorktree = { removeWorktree: true, deleteBranch: true, discardChanges: false }
const laneA: Lane = { path: '/repo/a.jsonl', title: 'a' }
const laneB: Lane = { path: '/repo/b.jsonl', title: 'b' }
const worktreeLane: Lane = {
  path: '/repo/wt.jsonl',
  title: 'wt',
  worktreePath: '/repo-wt',
  mainRepoPath: '/repo',
}

/** IPC stub: `handle` answers first; anything it leaves undefined gets a list. */
function answer(handle: Handler = () => undefined): void {
  invoke.mockImplementation(async (channel: string, ...args: unknown[]) => {
    const handled = await handle(channel, ...args)
    if (handled !== undefined) return handled
    if (channel === 'sessions:list' || channel === 'pi:listLiveSessions') return []
    if (channel === 'sessions:delete') return []
    return undefined
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const ipcWrapped = (channel: string, message: string): Error =>
  new Error(`Error invoking remote method '${channel}': Error: ${message}`)

beforeEach(() => {
  invoke.mockReset()
  answer()
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
    refreshDisk: realRefreshDisk,
  })
  useChatStore.setState({ sessions: {} })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('deleteManySessions settlement', () => {
  it('unlocks and rejects when the worktrees store cannot be read', async () => {
    vi.spyOn(useWorktreesStore, 'getState').mockImplementation(() => {
      throw new Error('worktrees unavailable')
    })
    await expect(
      useSessionsStore.getState().deleteManySessions('/repo', [laneA], keepWorktree),
    ).rejects.toThrow('worktrees unavailable')
    expect(useSessionsStore.getState().bulkDelete).toMatchObject({
      running: false,
      done: 0,
      current: '',
      currentPath: '',
      results: [],
    })

    vi.mocked(useWorktreesStore.getState).mockRestore()
    await expect(
      useSessionsStore.getState().deleteManySessions('/repo', [laneA], keepWorktree),
    ).resolves.toMatchObject([{ path: laneA.path, ok: true }])
  })

  it('unlocks with every completed result when the final disk refresh rejects', async () => {
    useSessionsStore.setState({
      refreshDisk: async () => {
        const progress = useSessionsStore.getState().bulkDelete
        if (progress && progress.done === progress.total) throw new Error('scan failed')
      },
    })
    await expect(
      useSessionsStore.getState().deleteManySessions('/repo', [laneA, laneB], keepWorktree),
    ).rejects.toThrow('scan failed')
    expect(useSessionsStore.getState().bulkDelete).toMatchObject({
      running: false,
      done: 2,
      current: '',
      currentPath: '',
      results: [
        { path: laneA.path, ok: true },
        { path: laneB.path, ok: true },
      ],
    })
  })

  it('reports a per-lane IPC failure without Electron’s wrapper', async () => {
    answer((channel, path) => {
      if (channel === 'sessions:delete' && path === laneA.path)
        throw ipcWrapped('sessions:delete', 'Trash unavailable')
      return undefined
    })
    const results = await useSessionsStore
      .getState()
      .deleteManySessions('/repo', [laneA, laneB], keepWorktree)
    expect(results).toEqual([
      { path: laneA.path, title: 'a', ok: false, error: 'Trash unavailable' },
      { path: laneB.path, title: 'b', ok: true },
    ])
    expect(useSessionsStore.getState().bulkDelete?.results).toEqual(results)
  })

  it('reports a disposal IPC failure without Electron’s wrapper', async () => {
    useSessionsStore.setState({
      live: { wt: { phosphorId: 'wt', workspacePath: '/repo', diskPath: worktreeLane.path } },
    })
    answer((channel) => {
      if (channel === 'pi:disposeSession')
        throw ipcWrapped('pi:disposeSession', 'Cannot stop process')
      return undefined
    })
    const results = await useSessionsStore
      .getState()
      .deleteManySessions('/repo', [worktreeLane], removeWorktree)
    expect(results).toEqual([
      { path: worktreeLane.path, title: 'wt', ok: false, error: 'Cannot stop process' },
    ])
  })

  it('keeps a lane whose worktree is dirty and still deletes the rest', async () => {
    answer((channel) =>
      channel === 'git:removeWorktree' ? { removed: false, dirtyCount: 2 } : undefined,
    )
    const results = await useSessionsStore
      .getState()
      .deleteManySessions('/repo', [worktreeLane, laneA], removeWorktree)
    expect(results).toMatchObject([
      { path: worktreeLane.path, ok: false },
      { path: laneA.path, ok: true },
    ])
    expect(results[0]?.error).toContain('worktree kept, 2 uncommitted changes')
    expect(invoke).not.toHaveBeenCalledWith('sessions:delete', worktreeLane.path, undefined)
    expect(useSessionsStore.getState().bulkDelete).toMatchObject({ running: false, done: 2 })
  })

  it('keeps a branch-removal warning on a lane that was deleted', async () => {
    answer((channel) =>
      channel === 'git:removeWorktree'
        ? { removed: true, dirtyCount: 0, branchError: 'branch is checked out elsewhere' }
        : undefined,
    )
    const results = await useSessionsStore
      .getState()
      .deleteManySessions('/repo', [worktreeLane], removeWorktree)
    expect(results).toEqual([
      {
        path: worktreeLane.path,
        title: 'wt',
        ok: true,
        error: 'branch is checked out elsewhere',
      },
    ])
  })

  it('stops after the lane in flight when cancelled and keeps its result', async () => {
    const trash = deferred<string[]>()
    answer((channel, path) =>
      channel === 'sessions:delete' && path === laneA.path ? trash.promise : undefined,
    )
    const run = useSessionsStore
      .getState()
      .deleteManySessions('/repo', [laneA, laneB], keepWorktree)
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('sessions:delete', laneA.path, undefined),
    )
    useSessionsStore.getState().cancelBulkDelete()
    trash.resolve([])
    expect(await run).toEqual([{ path: laneA.path, title: 'a', ok: true }])
    expect(invoke).not.toHaveBeenCalledWith('sessions:delete', laneB.path, undefined)
    expect(useSessionsStore.getState().bulkDelete).toMatchObject({
      running: false,
      cancelled: true,
      done: 1,
      current: '',
      currentPath: '',
      results: [{ path: laneA.path, ok: true }],
    })
  })

  it('refuses a second run while one is in flight', async () => {
    const trash = deferred<string[]>()
    answer((channel) => (channel === 'sessions:delete' ? trash.promise : undefined))
    const first = useSessionsStore.getState().deleteManySessions('/repo', [laneA], keepWorktree)
    await expect(
      useSessionsStore.getState().deleteManySessions('/repo', [laneB], keepWorktree),
    ).rejects.toThrow('Another delete is running.')
    trash.resolve([])
    await expect(first).resolves.toMatchObject([{ path: laneA.path, ok: true }])
  })
})
