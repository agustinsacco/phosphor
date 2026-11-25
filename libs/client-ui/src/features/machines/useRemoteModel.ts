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
import { piStartDefaults } from '@/features/home/useLocalStartModel'
import {
  useMachineCataloguesStore,
  useMachineCatalogue,
  MODELS_READ_FAILED,
} from '@/stores/machineCatalogues'
import { hostFeatureRefusal } from '@/stores/hostRefusals'
import { useRemoteLanesStore, hostReconnecting, machineLabel } from '@/stores/remoteLanes'
import {
  defaultRemoteModel,
  hostModelUnavailability,
  remoteModelExplanation,
  remoteStartThinking,
  type ModelChoice,
  type RemoteStartPreferences,
  type StartPreference,
} from './remoteModel'

const NO_MODELS: MachineModel[] = []

export function useRemoteModel(hostId: string) {
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const generation = useRemoteLanesStore(() => machineReadGeneration(hostId))
  const catalogue = useMachineCatalogue(hostId)
  const last = useRemoteModelPicks((s) => s.last[hostId])
  const rememberedThinking = useRemoteModelPicks((s) => s.thinking[hostId])
  const desktop = useDesktopDefaults(hostId, generation)
  const preferences: RemoteStartPreferences = {
    last: { model: last, thinking: rememberedThinking },
    host: { model: catalogue.defaults?.model, thinking: catalogue.defaults?.thinkingLevel },
    desktop,
  }
  const models = host?.capabilities.includes('skills.read') ? catalogue.models : NO_MODELS
  const providers = catalogue.providers
  const unavailable = useMemo(
    () => hostModelUnavailability(models, providers, machineLabel(hostId)),
    [models, providers, hostId],
  )
  const model =
    host?.state === 'ready' ? defaultRemoteModel(models, providers, preferences) : undefined
  const degraded = catalogue.source === 'config'
  const missingModel =
    host?.state === 'ready' && catalogue.status === 'ready' && !model && !degraded
  const hint = hostReconnecting(host?.state)
    ? 'Connecting…'
    : (hostFeatureRefusal(host, 'skills.read', 'models') ??
      (missingModel
        ? `No signed-in model on ${machineLabel(hostId)}.`
        : catalogue.status === 'idle' || catalogue.status === 'loading'
          ? 'Loading models…'
          : degraded
            ? 'Waiting for pi’s full model list…'
            : MODELS_READ_FAILED))
  return {
    hostId,
    missingModel,
    degraded,
    hint,
    model,
    models,
    unavailable,
    explanation:
      catalogue.source === 'config'
        ? 'Showing configured models while pi is unavailable.'
        : model
          ? remoteModelExplanation(model, preferences)
          : hint,
    canRetry:
      host?.state === 'ready' &&
      host.capabilities.includes('skills.read') &&
      catalogue.status !== 'loading' &&
      !model,
    retry: () => useMachineCataloguesStore.getState().load(hostId, 'retry'),
    thinking: model ? remoteStartThinking(model, preferences) : ('off' as const),
    setThinking: (level: ThinkingLevel) => rememberRemoteThinking(hostId, level),
    choose: (choice: ModelChoice) => rememberRemoteModel(hostId, choice),
  }
}

/** This Mac's pi defaults, a validated candidate after the Host's own; none in the browser. */
function useDesktopDefaults(hostId: string, generation: number): StartPreference {
  const { localLanes } = usePlatform()
  const [defaults, setDefaults] = useState<StartPreference>({})
  useEffect(() => {
    let current = true
    setDefaults({})
    if (!hostId || !localLanes) return
    void window.phosphor
      .invoke('pi:agentSettings')
      .then((settings) => {
        if (!current) return
        const { provider, model, thinking } = piStartDefaults(settings)
        const choice: ModelChoice | undefined =
          provider !== undefined && model !== undefined ? { provider, id: model } : undefined
        setDefaults({ model: choice, thinking })
      })
      .catch(() => undefined)
    return () => {
      current = false
    }
  }, [hostId, generation, localLanes])
  return defaults
}
