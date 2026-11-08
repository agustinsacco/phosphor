import { create } from 'zustand'
import type { RpcSlashCommand } from '@shared/rpc'

/**
 * Slash commands resolved per machine folder, for composers with no session.
 *
 * A live session's list arrives over RPC at bootstrap and lives on the chat
 * store; this is the same list for a folder nobody has started a session in
 * yet, so the home composer can offer `/` before the first prompt — on This
 * Mac (`pi:commands`) and on a Host (`hosts:commands`, one of its configured
 * repositories) alike. Loaded lazily — the first `/` keystroke, not app boot —
 * because every machine answers it by spawning a throwaway pi.
 *
 * `status` is what the menu shows while `byWorkspace` has nothing: that spawn
 * takes hundreds of milliseconds to seconds, and an empty list during it used
 * to render as no menu at all — indistinguishable from "pi is not installed",
 * which is the other reason the list can be empty and is reported the same
 * way, as `error`.
 */
export type PiCommandsStatus = 'loading' | 'ready' | 'error'

/** Where one composer's list comes from; `key` is its slot here. */
export interface CommandSource {
  key: string
  read: () => Promise<RpcSlashCommand[]>
}

export function workspaceCommandSource(workspacePath: string): CommandSource {
  return {
    key: workspacePath,
    read: async () => {
      const result = await window.phosphor.invoke('pi:commands', workspacePath)
      if (result.error !== undefined) throw new Error(result.error)
      return result.commands
    },
  }
}

export function hostCommandSource(hostId: string, repositoryId: string): CommandSource {
  return {
    key: `host:${hostId}/repository:${repositoryId}`,
    read: () => window.phosphor.invoke('hosts:commands', hostId, repositoryId),
  }
}

interface PiCommandsState {
  byWorkspace: Record<string, RpcSlashCommand[]>
  /** Absent = never asked (idle). */
  status: Record<string, PiCommandsStatus>
  error: Record<string, string | undefined>
  load: (source: CommandSource) => Promise<void>
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
  load: async ({ key, read }) => {
    const state = get()
    if (state.byWorkspace[key] || state.status[key] === 'loading') return
    set((s) => ({ status: { ...s.status, [key]: 'loading' } }))
    try {
      const commands = await read()
      set((s) => ({
        byWorkspace: { ...s.byWorkspace, [key]: commands },
        status: { ...s.status, [key]: 'ready' },
        error: { ...s.error, [key]: undefined },
      }))
    } catch (cause) {
      // Leave the folder unresolved so the next `/` tries again rather than
      // caching an empty menu forever — but say what went wrong meanwhile.
      set((s) => ({
        status: { ...s.status, [key]: 'error' },
        error: { ...s.error, [key]: cause instanceof Error ? cause.message : String(cause) },
      }))
    }
  },
  invalidateAll: () => set({ byWorkspace: {}, status: {}, error: {} }),
}))
