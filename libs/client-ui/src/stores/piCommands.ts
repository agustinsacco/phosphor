import { create } from 'zustand'
import type { RpcSlashCommand } from '@shared/rpc'

/**
 * Slash commands resolved per workspace, for composers with no session.
 *
 * A live session's list arrives over RPC at bootstrap and lives on the chat
 * store; this is the same list for a folder nobody has started a session in
 * yet, so the home composer can offer `/` before the first prompt. Loaded
 * lazily — the first `/` keystroke, not app boot — because main answers it by
 * spawning a throwaway pi.
 *
 * `status` is what the menu shows while `byWorkspace` has nothing: that spawn
 * takes hundreds of milliseconds to seconds, and an empty list during it used
 * to render as no menu at all — indistinguishable from "pi is not installed",
 * which is the other reason the list can be empty and is reported the same
 * way, as `error`.
 */
export type PiCommandsStatus = 'loading' | 'ready' | 'error'

interface PiCommandsState {
  byWorkspace: Record<string, RpcSlashCommand[]>
  /** Absent = never asked (idle). */
  status: Record<string, PiCommandsStatus>
  error: Record<string, string | undefined>
  load: (workspacePath: string) => Promise<void>
  /**
   * Forget every folder's list so the next `/` asks again. Main broadcasts
   * `pi:commandsChanged` after anything that changes the answer — a package
   * installed, an MCP server added, a skill written.
   */
  invalidateAll: () => void
}

/** Shared frozen empty list: selectors must never return a fresh `[]`. */
export const NO_COMMANDS: readonly RpcSlashCommand[] = Object.freeze([])

export const usePiCommandsStore = create<PiCommandsState>((set, get) => ({
  byWorkspace: {},
  status: {},
  error: {},
  load: async (workspacePath) => {
    const state = get()
    if (state.byWorkspace[workspacePath] || state.status[workspacePath] === 'loading') return
    set((s) => ({ status: { ...s.status, [workspacePath]: 'loading' } }))
    try {
      const result = await window.phosphor.invoke('pi:commands', workspacePath)
      if (result.error !== undefined) {
        // Leave the folder unresolved so the next `/` tries again rather than
        // caching an empty menu forever — but say what went wrong meanwhile.
        set((s) => ({
          status: { ...s.status, [workspacePath]: 'error' },
          error: { ...s.error, [workspacePath]: result.error },
        }))
        return
      }
      set((s) => ({
        byWorkspace: { ...s.byWorkspace, [workspacePath]: result.commands },
        status: { ...s.status, [workspacePath]: 'ready' },
        error: { ...s.error, [workspacePath]: undefined },
      }))
    } catch (cause) {
      set((s) => ({
        status: { ...s.status, [workspacePath]: 'error' },
        error: {
          ...s.error,
          [workspacePath]: cause instanceof Error ? cause.message : String(cause),
        },
      }))
    }
  },
  invalidateAll: () => set({ byWorkspace: {}, status: {}, error: {} }),
}))
