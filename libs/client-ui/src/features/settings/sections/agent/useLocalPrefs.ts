import { useCallback, useState } from 'react'
import { errorText } from '@shared/errors'
import type { AgentDirectivePrefs, AppPrefs } from '@shared/models'
import { useContextBudgetStore } from '@/stores/contextBudgetPref'
import { useExtensionUiStore } from '@/stores/extensionUi'

type AgentPrefs = Pick<
  AppPrefs,
  'contextBudget' | 'agentDirectives' | 'agentDirectivesByProject' | 'retiredDirectives'
>

const toast = (message: string, kind: 'info' | 'error'): void => {
  useExtensionUiStore.getState().pushToast(message, kind)
}

/**
 * This Mac's Phosphor prefs the Agent section edits: the context budget and
 * the directive switches, machine-wide or per folder. `load` is the section's
 * read; a failed budget save puts the old value back.
 */
export function useLocalAgentPrefs(folder: string | null) {
  const [prefs, setPrefs] = useState<AgentPrefs | null>(null)
  const load = useCallback(async (): Promise<void> => {
    const read = await window.phosphor.invoke('app:getPrefs')
    setPrefs({
      contextBudget: read.contextBudget ?? '',
      agentDirectives: read.agentDirectives,
      agentDirectivesByProject: read.agentDirectivesByProject,
      retiredDirectives: read.retiredDirectives,
    })
  }, [])
  const reload = (): void => {
    load().catch((error: unknown) => toast(errorText(error), 'error'))
  }

  const setBudget = async (next: string): Promise<void> => {
    const previous = prefs?.contextBudget ?? ''
    const apply = (value: string) => {
      setPrefs((p) => (p ? { ...p, contextBudget: value } : p))
      useContextBudgetStore.getState().applyContextBudget(value)
    }
    apply(next)
    try {
      await window.phosphor.invoke('app:setContextBudget', next)
    } catch (error) {
      apply(previous)
      toast(errorText(error), 'error')
    }
  }

  const setDirectives = async (next: AgentDirectivePrefs | null): Promise<void> => {
    try {
      await window.phosphor.invoke('app:setAgentDirectives', next, folder ?? undefined)
      toast('Saved. Applies to newly started lanes.', 'info')
    } catch (error) {
      toast(errorText(error), 'error')
    }
    reload()
  }

  const override = folder ? prefs?.agentDirectivesByProject[folder] : undefined
  return {
    prefs,
    load,
    budget: prefs?.contextBudget ?? '',
    setBudget: (next: string) => void setBudget(next),
    directives: override ?? prefs?.agentDirectives,
    override: folder
      ? { active: override !== undefined, clear: () => void setDirectives(null) }
      : undefined,
    setDirectives: (next: AgentDirectivePrefs) => void setDirectives(next),
    retired: prefs?.retiredDirectives ?? {},
    reload,
  }
}
