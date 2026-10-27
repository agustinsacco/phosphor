import { promptChoice } from '@/stores/prompt'
import type { MachineModel } from '@shared/host-protocol-machine'
import type { ThinkingLevel } from '@shared/rpc'
import { useEffect, useState } from 'react'
import { useMachineAgentDraft } from './machineSettingsDrafts'
import { machineAgentModel } from './machineAgentModel'
import type { HostSettingsState } from './useHostSettings'

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
  const draft = useMachineAgentDraft(hostId, repositoryId, settings)
  const { model, thinking, budget, naming } = draft.fields
  const setModel = (value: string) => draft.set('model', value)
  const setThinking = (value: ThinkingLevel) => draft.set('thinking', value)
  const setBudget = (value: string) => draft.set('budget', value)
  const setNaming = (value: boolean) => draft.set('naming', value)
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
  const busy = settings.loading || settings.saving || draft.stale
  const saveModel = async () => {
    const selected = models?.find((m) => JSON.stringify([m.provider, m.id]) === model)
    const chosen = machineAgentModel(model)
    if (model && !chosen) return
    if (
      (await promptChoice({
        title: `Save agent defaults on ${label}?`,
        message: `${selected?.name ?? chosen?.[1] ?? 'Keep the existing/inherited model'}${chosen ? ` (${chosen[0]})` : ''}, thinking ${thinking}. ${repositoryId ? 'This folder only; machine defaults stay unchanged.' : 'Machine defaults for new lanes.'} Existing lanes are not restarted.`,
        choices: [{ value: 'save', label: `Save on ${label}`, primary: true }],
      })) === 'save'
    )
      await draft.save({
        type: 'agent.patch',
        patch: {
          ...(chosen ? { defaultProvider: chosen[0], defaultModel: chosen[1] } : {}),
          defaultThinkingLevel: thinking,
        },
      })
  }
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
    setModel,
    setThinking,
    setBudget,
    setNaming,
    busy,
    saveModel,
    knownModel,
    validModel: !model || machineAgentModel(model) !== null,
  }
}
export type MachineAgentController = ReturnType<typeof useMachineAgentSettings>
