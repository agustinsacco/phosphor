import { machineReadGeneration } from './machineReadGeneration'
import { useRemoteLanesStore, REMOTE_UNAVAILABLE } from './remoteLanes'
import { create } from 'zustand'
import type { SkillsListResult } from '@shared/skills'

/**
 * Skills page state: the last resolution per workspace, plus which tab and
 * skill the pane is showing. Pure projection of `skills:list` — every
 * mutation calls back into main and then refreshes, so this store never
 * guesses at filesystem state.
 */
interface SkillsState {
  byWorkspace: Record<string, SkillsListResult>
  loading: Record<string, boolean>
  error: Record<string, string | undefined>
  tab: 'discover' | 'yours'
  selectedDir: string | null
  refresh: (workspacePath: string) => Promise<void>
  setTab: (tab: 'discover' | 'yours') => void
  select: (dir: string | null) => void
}

let selectionGeneration = 0

export const useSkillsStore = create<SkillsState>((set, get) => ({
  byWorkspace: {},
  loading: {},
  error: {},
  tab: 'yours',
  selectedDir: null,
  refresh: async (workspacePath) => {
    const hostId = workspacePath.startsWith('host:')
      ? workspacePath.slice(5).split('/')[0]
      : undefined
    const host = hostId ? useRemoteLanesStore.getState().hosts[hostId] : undefined
    const generation = hostId ? machineReadGeneration(hostId) : undefined
    const selection = selectionGeneration
    const current = () => !hostId || machineReadGeneration(hostId) === generation
    if (hostId && (host?.state !== 'ready' || !host.capabilities.includes('skills.read'))) {
      set((s) => ({ error: { ...s.error, [workspacePath]: REMOTE_UNAVAILABLE } }))
      return
    }
    set((state) => ({ loading: { ...state.loading, [workspacePath]: true } }))
    try {
      const result = await window.phosphor.invoke('skills:list', workspacePath)
      if (!current()) return
      set((state) => ({
        byWorkspace: { ...state.byWorkspace, [workspacePath]: result },
        loading: { ...state.loading, [workspacePath]: false },
        error: { ...state.error, [workspacePath]: undefined },
      }))
      const { selectedDir } = get()
      if (
        selection === selectionGeneration &&
        selectedDir &&
        (hostId ? selectedDir.startsWith(`${workspacePath}/`) : !selectedDir.startsWith('host:')) &&
        !result.skills.some((skill) => skill.dir === selectedDir)
      ) {
        set({ selectedDir: null })
      }
    } catch (cause) {
      if (!current()) return
      set((state) => ({
        loading: { ...state.loading, [workspacePath]: false },
        error: {
          ...state.error,
          [workspacePath]: cause instanceof Error ? cause.message : String(cause),
        },
      }))
    }
  },
  setTab: (tab) => {
    selectionGeneration++
    set({ tab, selectedDir: null })
  },
  select: (dir) => {
    selectionGeneration++
    set({ selectedDir: dir })
  },
}))
