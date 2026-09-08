import { create } from 'zustand'
import type { SandboxInfo, WorkspaceInfo } from '@shared/models'
import { isWorktreeFolder } from '@/lib/path'
import { useExtensionUiStore } from './extensionUi'
import { useSessionsStore } from './sessions'

/**
 * Known workspaces, plus the folder the **home screen** is composing against.
 *
 * Deliberately NOT an app-wide "current workspace": once a session is open,
 * the answer to "which folder am I in?" is that session's own
 * `workspacePath` (sessions can span several projects at once). This store
 * only owns the list and the home-screen target — use `useActiveWorkspace()`
 * for the derived answer.
 */
interface WorkspacesState {
  /** Folder the home screen composes against when no session is active. */
  homePath: string | null
  recents: WorkspaceInfo[]
  /**
   * Scratch folders main has minted. Two surfaces need it: Settings lists
   * them, and the sidebar asks whether a group is one before offering to
   * delete it.
   */
  sandboxes: SandboxInfo[]
  /** True once persisted workspaces and sandboxes have been read for this launch. */
  hydrated: boolean
  /** Point the home screen at a workspace (adds it to recents if new). */
  openWorkspace: (path: string) => void
  /** Native folder picker; adds the chosen folder rather than replacing. */
  pickAndOpen: () => Promise<string | null>
  /** "No folder": open a sandbox folder (an empty one is reused) from main. */
  openSandbox: () => Promise<string>
  /** Re-read the sandbox list from disk. */
  refreshSandboxes: () => Promise<void>
  /** Trash a sandbox (folder + transcripts) and drop it from every list. */
  deleteSandbox: (path: string) => Promise<{ ok: boolean; reason?: string }>
  /** Move a workspace in the user-defined sidebar/switcher order. */
  moveWorkspace: (path: string, direction: 'up' | 'down') => void
  hydrate: () => Promise<void>
}

/** A `WorkspaceInfo` for `path`, its name derived from the basename. */
const entryFor = (path: string): WorkspaceInfo => {
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
  return { path, name, lastOpenedAt: Date.now() }
}

export const useWorkspacesStore = create<WorkspacesState>((set, get) => ({
  homePath: null,
  recents: [],
  sandboxes: [],
  hydrated: false,

  openWorkspace: (path) => {
    // A worktree folder is a *branch* of a workspace, not a workspace of its
    // own. The screen should still point at it (top bar, file tree, home
    // target) — that's `homePath` plus the persisted `lastWorkspacePath` — but
    // it must never enter `recents`, or the sidebar/switcher would list a
    // header per chat instead of one per project.
    set((s) =>
      isWorktreeFolder(path)
        ? { homePath: path, recents: s.recents }
        : {
            homePath: path,
            // Opening records recency for launch recovery, but never changes the
            // user's explicit workspace order. New folders join at the end.
            recents: s.recents.some((w) => w.path === path)
              ? s.recents.map((w) => (w.path === path ? entryFor(path) : w))
              : [...s.recents, entryFor(path)],
          },
    )
    // Persist immediately (recents + lastWorkspacePath). The main process
    // prunes worktree folders from the persisted list; the in-memory list
    // above has already excluded them.
    void window.pidex.invoke('app:recordWorkspace', path)
  },

  pickAndOpen: async () => {
    const path = await window.pidex.invoke('app:selectFolder')
    if (path) get().openWorkspace(path)
    return path
  },

  openSandbox: async () => {
    const path = await window.pidex.invoke('app:createSandbox')
    get().openWorkspace(path)
    // Main may have minted a new one, and its item count changes the moment a
    // session writes anything — so re-read rather than patching the list.
    await get().refreshSandboxes()
    return path
  },

  refreshSandboxes: async () => {
    set({ sandboxes: await window.pidex.invoke('app:listSandboxes') })
  },

  deleteSandbox: async (path) => {
    const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path
    const result = await window.pidex.invoke('app:deleteSandbox', path)
    // Reported here rather than at each call site: main refuses for reasons
    // (a live session) the sidebar and Settings would both have to explain.
    if (!result.ok) {
      useExtensionUiStore
        .getState()
        .pushToast(
          result.reason === 'in-use'
            ? `${name} has a session running in it`
            : `Could not delete ${name}`,
          'error',
        )
      return result
    }
    useExtensionUiStore.getState().pushToast(`${name} moved to the Trash`, 'info')
    // Main already pruned recents on its side; mirror it here rather than
    // re-hydrating.
    const wasHome = get().homePath === path
    set((s) => ({
      recents: s.recents.filter((w) => w.path !== path),
      sandboxes: s.sandboxes.filter((sandbox) => sandbox.path !== path),
    }))
    if (wasHome) {
      // Step off the folder that just went to the Trash. Through
      // `openWorkspace`, so `lastWorkspacePath` stops naming it too — otherwise
      // the next launch resumes into a path that no longer exists.
      const next = get().recents.at(-1)?.path
      if (next) get().openWorkspace(next)
      else set({ homePath: null })
    }
    return result
  },

  moveWorkspace: (path, direction) => {
    const recents = get().recents
    const index = recents.findIndex((workspace) => workspace.path === path)
    const target = index + (direction === 'up' ? -1 : 1)
    if (index < 0 || target < 0 || target >= recents.length) return

    const next = [...recents]
    const [workspace] = next.splice(index, 1)
    next.splice(target, 0, workspace!)
    set({ recents: next })
    void window.pidex.invoke('app:setRecentWorkspaces', next)
  },

  hydrate: async () => {
    try {
      const [prefs, sandboxes] = await Promise.all([
        window.pidex.invoke('app:getPrefs'),
        window.pidex.invoke('app:listSandboxes'),
      ])
      set({ recents: prefs.recentWorkspaces, sandboxes })
    } finally {
      // The sidebar must distinguish an empty list from the moment before
      // prefs arrive. Also settle on a transient IPC failure: a later folder
      // open can still recover the screen, while an endless skeleton cannot.
      set({ hydrated: true })
    }
  },
}))

/**
 * The workspace the UI should act on: the active session's folder, or the
 * home-screen target when no session is open.
 *
 * Hook form for components; `getActiveWorkspace()` for imperative callers.
 */
export function useActiveWorkspace(): string | null {
  const activeSessionId = useSessionsStore((s) => s.activeSessionId)
  const sessionWorkspace = useSessionsStore((s) =>
    s.activeSessionId ? (s.live[s.activeSessionId]?.workspacePath ?? null) : null,
  )
  const homePath = useWorkspacesStore((s) => s.homePath)
  return activeSessionId ? sessionWorkspace : homePath
}

export function getActiveWorkspace(): string | null {
  const { activeSessionId, live } = useSessionsStore.getState()
  if (activeSessionId) return live[activeSessionId]?.workspacePath ?? null
  return useWorkspacesStore.getState().homePath
}
