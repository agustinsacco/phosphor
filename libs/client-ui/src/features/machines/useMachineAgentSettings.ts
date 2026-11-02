import type { MachineModel } from '@shared/host-protocol-machine'
import type { ThinkingLevel } from '@shared/rpc'
import { useEffect, useState } from 'react'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useMachineAgentDraft } from './machineSettingsDrafts'
import { needsServiceRestart, type AgentPatch } from './machineAgentPatch'
import type { HostSettingsState } from './useHostSettings'

/** One "Saved" notice at a time: a run of edits replaces it rather than stacking cards. */
let savedToast = 0
function announceSave(label: string, patch: AgentPatch, saved: boolean): void {
  const toasts = useExtensionUiStore.getState()
  if (savedToast) toasts.dismissToast(savedToast)
  savedToast = 0
  if (!saved) {
    toasts.pushToast(`Couldn’t save on ${label}. Your change is kept in Agent defaults.`, 'error')
    return
  }
  savedToast = toasts.pushToast(
    needsServiceRestart(patch)
      ? `Saved on ${label} — applies after the Host service restarts`
      : `Saved on ${label} — applies to new lanes`,
    'info',
  )
}

export function useMachineAgentSettings(
  hostId: string,
  repositoryId: string | undefined,
  settings: HostSettingsState,
  label: string,
) {
  const state = settings.data?.agent
  const [models, setModels] = useState<MachineModel[] | null>(null)
  const [catalogueFailed, setCatalogueFailed] = useState(false)
  const [catalogueAttempt, setCatalogueAttempt] = useState(0)
  const draft = useMachineAgentDraft(hostId, repositoryId, settings, (patch, saved) =>
    announceSave(label, patch, saved),
  )
  const { model, thinking, budget, naming } = draft.fields
  useEffect(() => {
    let live = true
    setModels(null)
    setCatalogueFailed(false)
    void window.phosphor.invoke('hosts:models', hostId).then(
      (rows) => {
        if (live) setModels(rows)
      },
      () => {
        if (live) setCatalogueFailed(true)
      },
    )
    return () => {
      live = false
    }
  }, [hostId, catalogueAttempt])
  // Saving does not lock the form: autosave queues the next edit behind it.
  const busy = settings.loading || draft.stale
  const knownModel = models?.some((m) => JSON.stringify([m.provider, m.id]) === model)
  return {
    state,
    draft,
    models,
    catalogueFailed,
    retryCatalogue: () => setCatalogueAttempt((n) => n + 1),
    model,
    thinking,
    budget,
    naming,
    setModel: (value: string) => draft.set('model', value),
    setThinking: (value: ThinkingLevel) => draft.set('thinking', value),
    setBudget: (value: string) => draft.set('budget', value),
    setNaming: (value: boolean) => draft.set('naming', value),
    busy,
    saving: draft.saving,
    knownModel,
  }
}
export type MachineAgentController = ReturnType<typeof useMachineAgentSettings>
