import { promptChoice } from '@/stores/prompt'
import type { MachineModel } from '@shared/host-protocol-machine'
import type { ThinkingLevel } from '@shared/rpc'
import { useEffect, useState } from 'react'
import { useMachineAgentDraft } from './machineSettingsDrafts'
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
  }, [hostId])
  const busy = settings.loading || settings.saving || draft.stale
  const saveModel = async () => {
    const selected = models?.find((m) => JSON.stringify([m.provider, m.id]) === model)
    if (!selected) return
    if (
      (await promptChoice({
        title: `Save agent defaults on ${label}?`,
        message: `${selected.name} (${selected.provider}), thinking ${thinking}. ${repositoryId ? 'This folder only; machine defaults stay unchanged.' : 'Machine defaults for new lanes.'} Existing lanes are not restarted.`,
        choices: [{ value: 'save', label: `Save on ${label}`, primary: true }],
      })) === 'save'
    )
      await draft.save({
        type: 'agent.patch',
        patch: {
          defaultProvider: selected.provider,
          defaultModel: selected.id,
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
  }
}
export type MachineAgentController = ReturnType<typeof useMachineAgentSettings>
