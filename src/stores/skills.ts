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

export const useSkillsStore = create<SkillsState>((set, get) => ({
  byWorkspace: {},
  loading: {},
  error: {},
  tab: 'yours',
  selectedDir: null,
  refresh: async (workspacePath) => {
    set((state) => ({ loading: { ...state.loading, [workspacePath]: true } }))
    try {
      const result = await window.phosphor.invoke('skills:list', workspacePath)
      set((state) => ({
        byWorkspace: { ...state.byWorkspace, [workspacePath]: result },
        loading: { ...state.loading, [workspacePath]: false },
        error: { ...state.error, [workspacePath]: undefined },
      }))
      const { selectedDir } = get()
      if (selectedDir && !result.skills.some((skill) => skill.dir === selectedDir)) {
        set({ selectedDir: null })
      }
    } catch (cause) {
      set((state) => ({
        loading: { ...state.loading, [workspacePath]: false },
        error: {
          ...state.error,
          [workspacePath]: cause instanceof Error ? cause.message : String(cause),
        },
      }))
    }
  },
  setTab: (tab) => set({ tab, selectedDir: null }),
  select: (dir) => set({ selectedDir: dir }),
}))
