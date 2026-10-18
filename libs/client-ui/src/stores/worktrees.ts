import { create } from 'zustand'
import type {
  AddWorktreeBranch,
  BranchInfo,
  CheckoutResult,
  PullResult,
  UpdateFromMainResult,
  WorktreeInfo,
} from '@shared/models'
import { DEFAULT_WORKTREE_PREFS } from '@shared/models'
import { keyedSlice } from './keyedSlice'

interface RepoWorktrees {
  worktrees: WorktreeInfo[]
  branches: BranchInfo[]
  defaultBranch: string
  loadedAt: number
  /** True while a `git fetch` is in flight, so the chip can show a spinner. */
  fetching: boolean
  /** When the remote was last successfully fetched; 0 when never this session. */
  fetchedAt: number
}

/**
 * Stable empty value so selectors don't allocate a new object per render, and
 * the base a failed listing resets to.
 */
const EMPTY_REPO: RepoWorktrees = {
  worktrees: [],
  branches: [],
  defaultBranch: '',
  loadedAt: 0,
  fetching: false,
  fetchedAt: 0,
}
// Freezes EMPTY_REPO in place; the const stays readable as a spread source.
const repos = keyedSlice(EMPTY_REPO)

interface WorktreesState {
  byRepo: Record<string, RepoWorktrees>
  /**
   * Whether work should be isolated in a worktree: picking a branch gives it
   * its own checkout, and a new chat gets its own branch. Global rather than
   * per-repo — it tracks how the user likes to work, not a property of any one
   * checkout — and persisted, because a preference that reset to the default
   * on every launch was one the user could not actually turn off.
   */
  preferWorktree: boolean
  /** Prepended to auto-created session branches; `''` means no prefix. */
  branchPrefix: string
  /** Load the persisted worktree preferences. Called once at app boot. */
  hydratePrefs: () => Promise<void>
  setPreferWorktree: (value: boolean) => void
  setBranchPrefix: (value: string) => void
  refresh: (repoPath: string) => Promise<void>
  addWorktree: (repoPath: string, name: string, branch: AddWorktreeBranch) => Promise<WorktreeInfo>
  removeWorktree: (
    repoPath: string,
    worktreePath: string,
    options: { force?: boolean; deleteBranch?: boolean },
  ) => Promise<
    | { removed: true; branchDeleted: boolean; branchError?: string }
    | { removed: false; dirtyCount: number }
  >
  /**
   * Retitle a branch in place. Used once a chat's generated name arrives, to
   * bring the branch cut at send time into agreement with it.
   */
  renameBranch: (repoPath: string, from: string, to: string) => Promise<string>
  prune: (repoPath: string) => Promise<string[]>
  /**
   * Fetch the remote, then reload branches so the new `behind` counts land.
   * Main throttles per repo, so calling this on every menu open is cheap.
   */
  syncRemote: (repoPath: string, options?: { force?: boolean }) => Promise<void>
  pull: (repoPath: string, cwd: string) => Promise<PullResult>
  updateFromMain: (repoPath: string, worktreePath: string) => Promise<UpdateFromMainResult>
  checkout: (repoPath: string, branch: string) => Promise<CheckoutResult>
}

/** Worktree/branch state for a repo; shared frozen empty value. */
export function repoWorktrees(state: WorktreesState, repoPath: string): RepoWorktrees {
  return repos.read(state.byRepo, repoPath)
}

/** Apply a patch to one repo's slice, creating it if absent. */
function patchRepo(
  state: WorktreesState,
  repoPath: string,
  update: (current: RepoWorktrees) => RepoWorktrees,
): Pick<WorktreesState, 'byRepo'> {
  return { byRepo: repos.patch(state.byRepo, repoPath, update) }
}

export const useWorktreesStore = create<WorktreesState>((set, get) => ({
  byRepo: {},

  preferWorktree: DEFAULT_WORKTREE_PREFS.auto,
  branchPrefix: DEFAULT_WORKTREE_PREFS.branchPrefix,

  hydratePrefs: async () => {
    const { worktrees } = await window.phosphor.invoke('app:getPrefs')
    set({ preferWorktree: worktrees.auto, branchPrefix: worktrees.branchPrefix })
  },

  setPreferWorktree: (value) => {
    set({ preferWorktree: value })
    void window.phosphor.invoke('app:setWorktreePrefs', {
      auto: value,
      branchPrefix: get().branchPrefix,
    })
  },

  setBranchPrefix: (value) => {
    set({ branchPrefix: value })
    void window.phosphor.invoke('app:setWorktreePrefs', {
      auto: get().preferWorktree,
      branchPrefix: value,
    })
  },

  refresh: async (repoPath) => {
    try {
      const [worktrees, branchData] = await Promise.all([
        window.phosphor.invoke('git:listWorktrees', repoPath),
        window.phosphor.invoke('git:listBranches', repoPath),
      ])
      set((s) =>
        // Spread the previous entry so a refresh triggered mid-fetch does not
        // blank out `fetching`/`fetchedAt` and strand the spinner.
        patchRepo(s, repoPath, (repo) => ({
          ...repo,
          worktrees,
          branches: branchData.branches,
          defaultBranch: branchData.defaultBranch,
          loadedAt: Date.now(),
        })),
      )
    } catch {
      // Listing failed (not a repo, git missing): clear the lists as before,
      // but keep the fetch bookkeeping so an in-flight spinner still resolves.
      set((s) =>
        patchRepo(s, repoPath, (repo) => ({
          ...EMPTY_REPO,
          fetching: repo.fetching,
          fetchedAt: repo.fetchedAt,
          loadedAt: Date.now(),
        })),
      )
    }
  },

  addWorktree: async (repoPath, name, branch) => {
    const created = await window.phosphor.invoke('git:addWorktree', repoPath, name, branch)
    await get().refresh(repoPath)
    return created
  },

  removeWorktree: async (repoPath, worktreePath, options) => {
    const result = await window.phosphor.invoke(
      'git:removeWorktree',
      repoPath,
      worktreePath,
      options,
    )
    if (result.removed) await get().refresh(repoPath)
    return result
  },

  renameBranch: async (repoPath, from, to) => {
    const result = await window.phosphor.invoke('git:renameBranch', repoPath, from, to)
    if (result.renamed) await get().refresh(repoPath)
    return result.branch
  },

  prune: async (repoPath) => {
    const { pruned } = await window.phosphor.invoke('git:pruneWorktrees', repoPath)
    await get().refresh(repoPath)
    return pruned
  },

  syncRemote: async (repoPath, options = {}) => {
    const patch = (fields: Partial<RepoWorktrees>): void =>
      set((s) => patchRepo(s, repoPath, (repo) => ({ ...repo, ...fields })))

    patch({ fetching: true })
    try {
      const result = await window.phosphor.invoke('git:fetch', repoPath, options)
      if (result.fetched) {
        patch({ fetchedAt: result.at })
        // Only re-list when something could actually have moved. A throttled
        // or failed fetch leaves every ref where it was.
        await get().refresh(repoPath)
      } else if (result.reason === 'throttled') {
        patch({ fetchedAt: result.at })
      }
    } finally {
      patch({ fetching: false })
    }
  },

  pull: async (repoPath, cwd) => {
    const result = await window.phosphor.invoke('git:pull', cwd)
    if (result.pulled) await get().refresh(repoPath)
    return result
  },

  updateFromMain: async (repoPath, worktreePath) => {
    const mainBranch = repoWorktrees(get(), repoPath).defaultBranch
    const result = await window.phosphor.invoke('git:updateFromMain', worktreePath, mainBranch)
    if (result.updated) await get().refresh(repoPath)
    return result
  },

  checkout: async (repoPath, branch) => {
    const result = await window.phosphor.invoke('git:checkoutBranch', repoPath, branch)
    if (result.checkedOut) await get().refresh(repoPath)
    return result
  },
}))
