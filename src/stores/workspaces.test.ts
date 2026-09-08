import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SandboxInfo, WorkspaceInfo } from '@shared/models'

const invoke = vi.fn().mockResolvedValue(undefined)

const sandbox = (path: string): SandboxInfo => ({
  path,
  name: path.split('/').pop()!,
  itemCount: 0,
  lastUsedAt: 0,
})

const workspaces = (paths: string[]): WorkspaceInfo[] =>
  paths.map((path, index) => ({ path, name: path.slice(1), lastOpenedAt: index }))

beforeEach(async () => {
  invoke.mockClear()
  vi.stubGlobal('window', { phosphor: { invoke } })
  const { useWorkspacesStore } = await import('./workspaces')
  useWorkspacesStore.setState({
    homePath: null,
    recents: workspaces(['/a', '/b', '/c']),
    sandboxes: [],
    hydrated: false,
  })
})

describe('workspace hydration', () => {
  it('does not treat the empty default list as loaded', async () => {
    const { useWorkspacesStore } = await import('./workspaces')
    invoke.mockImplementation((channel: string) => {
      if (channel === 'app:getPrefs')
        return Promise.resolve({ recentWorkspaces: workspaces(['/a']) })
      if (channel === 'app:listSandboxes') return Promise.resolve([sandbox('/s/sandbox-1')])
      return Promise.resolve(undefined)
    })

    const hydrating = useWorkspacesStore.getState().hydrate()
    expect(useWorkspacesStore.getState().hydrated).toBe(false)

    await hydrating

    expect(useWorkspacesStore.getState()).toMatchObject({
      hydrated: true,
      recents: workspaces(['/a']),
      sandboxes: [sandbox('/s/sandbox-1')],
    })
  })

  it('settles loading when persisted state cannot be read', async () => {
    const { useWorkspacesStore } = await import('./workspaces')
    invoke.mockRejectedValueOnce(new Error('unavailable'))

    await expect(useWorkspacesStore.getState().hydrate()).rejects.toThrow('unavailable')

    expect(useWorkspacesStore.getState().hydrated).toBe(true)
  })
})

describe('workspace ordering', () => {
  it('keeps an existing workspace in place when it is opened', async () => {
    const { useWorkspacesStore } = await import('./workspaces')

    useWorkspacesStore.getState().openWorkspace('/b')

    expect(useWorkspacesStore.getState().recents.map((workspace) => workspace.path)).toEqual([
      '/a',
      '/b',
      '/c',
    ])
    expect(invoke).toHaveBeenCalledWith('app:recordWorkspace', '/b')
  })

  it('moves a workspace only when the user asks to move it', async () => {
    const { useWorkspacesStore } = await import('./workspaces')

    useWorkspacesStore.getState().moveWorkspace('/b', 'up')

    expect(useWorkspacesStore.getState().recents.map((workspace) => workspace.path)).toEqual([
      '/b',
      '/a',
      '/c',
    ])
    expect(invoke).toHaveBeenCalledWith('app:setRecentWorkspaces', [
      expect.objectContaining({ path: '/b' }),
      expect.objectContaining({ path: '/a' }),
      expect.objectContaining({ path: '/c' }),
    ])
  })

  it('does not add a worktree folder as a workspace (a branch, not a project)', async () => {
    const { useWorkspacesStore } = await import('./workspaces')
    const wt = '/a/.phosphor/worktrees/my-task'

    useWorkspacesStore.getState().openWorkspace(wt)

    expect(useWorkspacesStore.getState().recents.map((workspace) => workspace.path)).toEqual([
      '/a',
      '/b',
      '/c',
    ])
    // The screen does point at it (resume target / top bar), and the main
    // process is told so it can remember `lastWorkspacePath`.
    expect(useWorkspacesStore.getState().homePath).toBe(wt)
    expect(invoke).toHaveBeenCalledWith('app:recordWorkspace', wt)
  })
})

describe('deleting a sandbox', () => {
  const setUp = async (): Promise<void> => {
    const { useWorkspacesStore } = await import('./workspaces')
    useWorkspacesStore.setState({
      homePath: '/s/sandbox-1',
      recents: workspaces(['/a', '/s/sandbox-1']),
      sandboxes: [sandbox('/s/sandbox-1')],
    })
  }

  it('drops it from both lists and steps off it', async () => {
    const { useWorkspacesStore } = await import('./workspaces')
    await setUp()
    invoke.mockResolvedValueOnce({ ok: true })

    await useWorkspacesStore.getState().deleteSandbox('/s/sandbox-1')

    const state = useWorkspacesStore.getState()
    expect(state.recents.map((workspace) => workspace.path)).toEqual(['/a'])
    expect(state.sandboxes).toEqual([])
    // The home screen was pointing at the folder that just went to the Trash.
    expect(state.homePath).toBe('/a')
  })

  it('changes nothing when main refuses', async () => {
    const { useWorkspacesStore } = await import('./workspaces')
    await setUp()
    invoke.mockResolvedValueOnce({ ok: false, reason: 'in-use' })

    const result = await useWorkspacesStore.getState().deleteSandbox('/s/sandbox-1')

    expect(result).toEqual({ ok: false, reason: 'in-use' })
    const state = useWorkspacesStore.getState()
    expect(state.recents).toHaveLength(2)
    expect(state.sandboxes).toHaveLength(1)
    expect(state.homePath).toBe('/s/sandbox-1')
  })
})
