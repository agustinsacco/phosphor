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
 */
interface PiCommandsState {
  byWorkspace: Record<string, RpcSlashCommand[]>
  /** In-flight keys, so a burst of keystrokes makes one IPC call. */
  loading: Record<string, boolean>
  load: (workspacePath: string) => Promise<void>
}

/** Shared frozen empty list: selectors must never return a fresh `[]`. */
export const NO_COMMANDS: readonly RpcSlashCommand[] = Object.freeze([])

export const usePiCommandsStore = create<PiCommandsState>((set, get) => ({
  byWorkspace: {},
  loading: {},
  load: async (workspacePath) => {
    const state = get()
    if (state.byWorkspace[workspacePath] || state.loading[workspacePath]) return
    set((s) => ({ loading: { ...s.loading, [workspacePath]: true } }))
    try {
      const result = await window.phosphor.invoke('pi:commands', workspacePath)
      set((s) => ({ byWorkspace: { ...s.byWorkspace, [workspacePath]: result.commands } }))
    } catch {
      // pi missing or the probe timed out. Leave the folder unresolved so the
      // next `/` tries again rather than caching an empty menu forever.
    } finally {
      set((s) => ({ loading: { ...s.loading, [workspacePath]: false } }))
    }
  },
}))
