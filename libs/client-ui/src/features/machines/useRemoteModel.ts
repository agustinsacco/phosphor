import { useEffect, useMemo, useState } from 'react'
import { usePlatform } from '@/platform/Platform'
import { machineReadGeneration } from '@/stores/machineReadGeneration'
import {
  useRemoteModelPicks,
  rememberRemoteModel,
  rememberRemoteThinking,
} from '@/stores/remoteModelPicks'
import type { ThinkingLevel } from '@shared/rpc'
import type { MachineModel } from '@shared/host-protocol-machine'
import { ALL_THINKING_LEVELS, clampThinkingLevel } from '@shared/thinking'
import {
  useMachineCataloguesStore,
  machineCatalogueKey,
  EMPTY_MACHINE_CATALOGUE,
} from '@/stores/machineCatalogues'
import {
  useRemoteLanesStore,
  REMOTE_NOT_READY,
  hostReconnecting,
  REMOTE_UNAVAILABLE,
  machineLabel,
} from '@/stores/remoteLanes'
import {
  defaultRemoteModel,
  hostModelUnavailability,
  remoteModelExplanation,
  type ModelChoice,
} from './remoteModel'

const NO_MODELS: MachineModel[] = []

export function useRemoteModel(hostId: string) {
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const generation = useRemoteLanesStore(() => machineReadGeneration(hostId))
  const catalogue = useMachineCataloguesStore(
    (s) => s.catalogues[machineCatalogueKey(hostId, generation)] ?? EMPTY_MACHINE_CATALOGUE,
  )
  const last = useRemoteModelPicks((s) => s.last[hostId])
  const rememberedThinking = useRemoteModelPicks((s) => s.thinking[hostId])
  const defaults = useDesktopDefaults(hostId, generation)
  useEffect(() => {
    if (hostId) void useMachineCataloguesStore.getState().load(hostId)
  }, [hostId, generation])
  const models = host?.capabilities.includes('skills.read') ? catalogue.models : NO_MODELS
  const providers = catalogue.providers
  const unavailable = useMemo(
    () => hostModelUnavailability(models, providers, machineLabel(hostId)),
    [models, providers, hostId],
  )
  const model =
    host?.state === 'ready'
      ? defaultRemoteModel(models, providers, last, defaults.model)
      : undefined
  const missingModel = host?.state === 'ready' && catalogue.status === 'ready' && !model
  const hint = hostReconnecting(host?.state)
    ? 'Connecting…'
    : host?.state !== 'ready'
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
    models,
    unavailable,
    explanation: model ? remoteModelExplanation(model, last, defaults.model) : hint,
    canRetry:
      host?.state === 'ready' &&
      host.capabilities.includes('skills.read') &&
      catalogue.status !== 'loading' &&
      !model,
    retry: () => useMachineCataloguesStore.getState().load(hostId, undefined, true),
    thinking: model
      ? clampThinkingLevel(model, rememberedThinking ?? defaults.thinking)
      : ('off' as const),
    setThinking: (level: ThinkingLevel) => rememberRemoteThinking(hostId, level),
    choose: (choice: ModelChoice) => rememberRemoteModel(hostId, choice),
  }
}

/** Native defaults are only a validated candidate, never a new Host wire contract. */
function useDesktopDefaults(hostId: string, generation: number) {
  const { localLanes } = usePlatform()
  const [defaults, setDefaults] = useState<{ model?: ModelChoice; thinking: ThinkingLevel }>({
    thinking: 'off',
  })
  useEffect(() => {
    let current = true
    setDefaults({ thinking: 'off' })
    if (!hostId || !localLanes) return
    void window.phosphor
      .invoke('pi:agentSettings')
      .then((settings) => {
        if (!current) return
        const thinking =
          ALL_THINKING_LEVELS.find((level) => level === settings.defaultThinkingLevel) ?? 'off'
        const model =
          typeof settings.defaultProvider === 'string' && typeof settings.defaultModel === 'string'
            ? { provider: settings.defaultProvider, id: settings.defaultModel }
            : undefined
        setDefaults({ model, thinking })
      })
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [hostId, generation, localLanes])
  return defaults
}
