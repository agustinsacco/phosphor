import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('@/features/files/MonacoEditor', () => ({ releaseFileModel: vi.fn() }))

import { startChat, newChatBranchName } from './startChat'
import { useSessionsStore } from '@/stores/sessions'
import { useWorktreesStore } from '@/stores/worktrees'
import { useWorkspacesStore } from '@/stores/workspaces'
import { useLanePrefsStore } from '@/stores/lanePrefs'

const createSession = vi.fn()
const invoke = vi.fn()
const tree = '/repo/.phosphor/worktrees/task'
beforeEach(() => {
  createSession.mockReset().mockResolvedValue('new')
  vi.spyOn(useSessionsStore.getState(), 'createSession').mockImplementation(createSession)
  useSessionsStore.setState({ navSeq: 1 })
  useWorktreesStore.setState({ byRepo: {}, preferWorktree: true })
  useWorkspacesStore.setState({ homePath: '/repo', recents: [] })
  useLanePrefsStore.getState().applyLanePrefs({ autoName: false })
  invoke.mockReset().mockImplementation(async (channel: string) => {
    if (channel === 'git:info') return { isRepo: true }
    if (channel === 'git:startPoint') return { base: 'main', fromRemote: false }
    if (channel === 'git:listWorktrees') return []
    if (channel === 'git:listBranches') return { branches: [], defaultBranch: 'main' }
    if (channel === 'git:addWorktree') return { path: tree, realPath: tree, branch: 'task' }
    return undefined
  })
  vi.stubGlobal('window', { phosphor: { invoke } })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each(['plain', 'worktree', 'fallback'])(
  'carries the draft Swarm choice through %s creation',
  async (mode) => {
    if (mode === 'plain') useWorktreesStore.setState({ preferWorktree: false })
    if (mode === 'fallback') {
      vi.spyOn(useWorktreesStore.getState(), 'addWorktree').mockRejectedValue(
        new Error('git refused'),
      )
    }
    await startChat({ workspacePath: '/repo', prompt: 'task', swarm: true, nav: 1 })
    expect(createSession).toHaveBeenCalledWith(
      mode === 'worktree' ? tree : '/repo',
      expect.objectContaining({ firstPrompt: 'task', swarm: true, nav: 1 }),
    )
  },
)

it.each([false, true])(
  'restores the source workspace on startup failure unless navigation moved: %s',
  async (moved) => {
    createSession.mockImplementation(async () => {
      if (moved) {
        useSessionsStore.setState({ navSeq: 2 })
        useWorkspacesStore.getState().openWorkspace('/elsewhere')
      }
      throw new Error('Swarm requires pi-subagents')
    })
    await expect(
      startChat({ workspacePath: '/repo', prompt: 'task', swarm: true, nav: 1 }),
    ).rejects.toThrow('pi-subagents')
    expect(useWorkspacesStore.getState().homePath).toBe(moved ? '/elsewhere' : '/repo')
  },
)

it('shares prompt slug, branch prefix and collision rules with Host creation', async () => {
  useWorktreesStore.setState({ branchPrefix: 'custom/' })
  const name = newChatBranchName('Fix the café composer', { takenBranches: [], takenFolders: [] })
  expect(name.branch).toBe('custom/fix-the-cafe-composer')
  const add = vi.spyOn(useWorktreesStore.getState(), 'addWorktree').mockResolvedValue({
    path: tree,
    realPath: tree,
    branch: name.branch,
    isMain: false,
    head: 'head',
    locked: false,
    prunable: false,
    dirtyCount: 0,
  })
  await startChat({ workspacePath: '/repo', prompt: 'Fix the café composer' })
  expect(add).toHaveBeenCalledWith(
    '/repo',
    name.folder,
    expect.objectContaining({ branch: name.branch }),
  )
  expect(
    newChatBranchName('Fix the café composer', { takenBranches: [name.branch], takenFolders: [] })
      .branch,
  ).toBe('custom/fix-the-cafe-composer-2')
})
