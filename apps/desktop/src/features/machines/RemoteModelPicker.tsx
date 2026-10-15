import { machineReadGeneration } from '@/stores/machineReadGeneration'
import { useMachinesStore } from '@/stores/machines'
import { Button } from '@/components/form'
import { useEffect, useState } from 'react'
import { useRemoteModelPicks, rememberRemoteModel } from '@/stores/remoteModelPicks'
import type { ThinkingLevel } from '@shared/rpc'
import { supportedThinkingLevels, clampThinkingLevel } from '@shared/thinking'
import {
  useMachineCataloguesStore,
  machineCatalogueKey,
  EMPTY_MACHINE_CATALOGUE,
} from '@/stores/machineCatalogues'
import {
  useRemoteLanesStore,
  REMOTE_NOT_READY,
  REMOTE_UNAVAILABLE,
  machineLabel,
} from '@/stores/remoteLanes'
import { ChoiceMenu } from '@/components/ChoiceMenu'
import { defaultRemoteModel, type ModelChoice } from './remoteModel'

export function useRemoteModel(hostId: string) {
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const generation = useRemoteLanesStore(() => machineReadGeneration(hostId))
  const catalogue = useMachineCataloguesStore(
    (s) => s.catalogues[machineCatalogueKey(hostId, generation)] ?? EMPTY_MACHINE_CATALOGUE,
  )
  const last = useRemoteModelPicks((s) => s.last[hostId])
  const [desktop, setDesktop] = useState<ModelChoice>()
  const [level, setLevel] = useState<{ hostId: string; thinking: ThinkingLevel }>({
    hostId,
    thinking: 'off',
  })
  const thinking = level.hostId === hostId ? level.thinking : 'off'
  const setThinking = (thinking: ThinkingLevel): void => setLevel({ hostId, thinking })
  useEffect(() => {
    if (!hostId) return
    void useMachineCataloguesStore.getState().load(hostId)
    void window.phosphor
      .invoke('pi:agentSettings')
      .then((s) => {
        if (typeof s.defaultProvider === 'string' && typeof s.defaultModel === 'string')
          setDesktop({ provider: s.defaultProvider, id: s.defaultModel })
      })
      .catch(() => undefined)
  }, [hostId, generation])
  const models = host?.capabilities.includes('skills.read') ? catalogue.models : []
  const providers = catalogue.providers
  const usable = models.filter((m) =>
    providers.some((p) => p.id === m.provider && p.status === 'ready'),
  )
  const model =
    host?.state === 'ready' ? defaultRemoteModel(models, providers, last, desktop) : undefined
  const missingModel = host?.state === 'ready' && catalogue.status === 'ready' && !model
  const hint =
    host?.state !== 'ready'
      ? REMOTE_NOT_READY
      : missingModel
        ? `No signed-in model on ${machineLabel(hostId)}.`
        : catalogue.status === 'loading'
          ? 'Loading models…'
          : REMOTE_UNAVAILABLE
  return {
    hostId,
    missingModel,
    hint,
    model,
    models: usable,
    thinking: model ? clampThinkingLevel(model, thinking) : ('off' as const),
    setThinking,
    choose: (choice: ModelChoice) => rememberRemoteModel(hostId, choice),
  }
}

export function RemoteModelPicker({
  selection,
}: {
  selection: ReturnType<typeof useRemoteModel>
}): React.JSX.Element {
  const { model, models, thinking, choose, setThinking } = selection
  const levels = model ? supportedThinkingLevels(model) : []
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <ChoiceMenu
        label="Model"
        value={model ? `${model.provider}/${model.id}` : ''}
        choices={models.map((m) => ({
          value: `${m.provider}/${m.id}`,
          label: `${m.name} · ${m.provider}`,
        }))}
        onChange={(key) => {
          const selected = models.find((m) => `${m.provider}/${m.id}` === key)
          if (selected) choose(selected)
        }}
      >
        {model?.name ?? selection.hint}
      </ChoiceMenu>
      {selection.missingModel && (
        <Button
          size="sm"
          onClick={() =>
            useMachinesStore.getState().show({ kind: 'machine', id: selection.hostId })
          }
        >
          Sign in on {machineLabel(selection.hostId)}
        </Button>
      )}
      {levels.length > 1 && (
        <ChoiceMenu
          label="Thinking"
          value={thinking}
          choices={levels.map((level) => ({
            value: level,
            label: level === 'off' ? 'No thinking' : level,
          }))}
          onChange={(value) => {
            const level = levels.find((level) => level === value)
            if (level) setThinking(level)
          }}
        >
          {thinking === 'off' ? 'No thinking' : thinking}
        </ChoiceMenu>
      )}
    </div>
  )
}
