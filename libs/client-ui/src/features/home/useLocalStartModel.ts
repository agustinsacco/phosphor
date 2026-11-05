import { useEffect, useMemo, useState } from 'react'
import type { ThinkingLevel } from '@shared/rpc'
import { ALL_THINKING_LEVELS, clampThinkingLevel, supportedThinkingLevels } from '@shared/thinking'
import { catalogueEmptyText, modelChipLabel, useModelCatalogueStore } from '@/stores/modelCatalogue'
import { useSignInAction } from '@/features/chat/useSignInAction'
import type { StartModelSource } from './StartModelPicker'

type ModelPick = { provider: string; id: string }

/**
 * This Mac's models for a new lane, where no session exists yet.
 *
 * The session composer's picker drives a live pi process over RPC. Here there
 * is nothing to talk to, so this reads and writes pi's own defaults
 * (`defaultProvider` / `defaultModel` / `defaultThinkingLevel` in
 * settings.json). That is the same surface pi itself uses to pick a model on
 * startup, so whatever is shown here is genuinely what the next session will
 * run with — not a phosphor-local preference that silently disagrees.
 *
 * Supported thinking levels are derived locally via `supportedThinkingLevels`
 * (shared/thinking.ts), which implements pi's per-model rules over the
 * `thinkingLevelMap` the catalogue carries. A live session still prefers pi's
 * own `get_available_thinking_levels` answer; this derivation is what a new
 * session will get, computed from the same data pi computes it from.
 */
export function useLocalStartModel({
  override,
  onPick,
}: {
  /**
   * The model this workspace's saved draft was composed against. It wins over
   * pi's global default: coming back to a draft should restore the model you
   * chose for it, not whatever some later session set globally.
   */
  override?: ModelPick | undefined
  onPick?: ((model: ModelPick) => void) | undefined
}): StartModelSource {
  const status = useModelCatalogueStore((s) => s.status)
  const models = useModelCatalogueStore((s) => s.models)
  const source = useModelCatalogueStore((s) => s.source)
  const providers = useModelCatalogueStore((s) => s.providers)
  const { provider, modelId, thinking, setProvider, setModelId, setThinking } =
    usePiDefaults(override)

  const current = models.find((m) => m.id === modelId && m.provider === provider)
  const levels = useMemo(() => (current ? supportedThinkingLevels(current) : []), [current])
  const loading = status === 'idle' || status === 'loading'
  const signIn = useSignInAction('local')

  return {
    testIdPrefix: 'home',
    models,
    current: provider && modelId ? { provider, id: modelId } : undefined,
    chip: localChip(modelChipLabel(status, current, modelId, source), current?.provider),
    loading,
    levels,
    // What the next session will RUN at, not the raw persisted value: pi writes
    // defaultThinkingLevel on every in-session change, so a 'max' persisted from
    // another model shows as this model's clamp (pi applies the same on startup).
    thinking: current ? clampThinkingLevel(current, thinking) : thinking,
    choose: (pick) => {
      const model = models.find((m) => m.id === pick.id && m.provider === pick.provider)
      if (!model) return
      setProvider(model.provider)
      setModelId(model.id)
      onPick?.({ provider: model.provider, id: model.id })
      void window.phosphor.invoke('pi:patchAgentSettings', 'global', undefined, {
        defaultProvider: model.provider,
        defaultModel: model.id,
      })
    },
    setThinking: (level) => {
      setThinking(level)
      void window.phosphor.invoke('pi:patchAgentSettings', 'global', undefined, {
        defaultThinkingLevel: level,
      })
    },
    // Opening the picker is when the list matters, so a degraded one gets one
    // more attempt at pi. Cheap: main serves a good answer from its cache and
    // only re-spawns pi when what it holds is the fallback.
    onOpen: () => {
      if (source === 'config') void useModelCatalogueStore.getState().refresh()
    },
    menu: {
      emptyText: catalogueEmptyText(status, providers),
      notice:
        source === 'config'
          ? 'pi’s catalogue could not be read — showing only what models.json declares. Retrying…'
          : undefined,
    },
    // The same actions as a Host's source: retry a failed read, sign in to get a model.
    actions:
      status === 'error'
        ? [{ label: 'Retry models', run: () => void useModelCatalogueStore.getState().refresh() }]
        : status === 'ready' && models.length === 0
          ? [signIn]
          : [],
  }
}

/** pi's global defaults, unless a restored draft's model wins. */
function usePiDefaults(override: ModelPick | undefined) {
  const [provider, setProvider] = useState<string | null>(null)
  const [modelId, setModelId] = useState<string | null>(null)
  const [thinking, setThinking] = useState<ThinkingLevel>('off')

  useEffect(() => {
    if (!override) return
    setProvider(override.provider)
    setModelId(override.id)
  }, [override])

  useEffect(() => {
    // Usually a no-op — App hydrates this at boot, well before the home
    // screen renders. It stays here so the picker still works if it does not.
    void useModelCatalogueStore.getState().hydrate()
    void window.phosphor.invoke('pi:agentSettings').then((settings) => {
      const defaultThinking = settings.defaultThinkingLevel
      // An override (a restored draft's model) has already been applied.
      if (!override) {
        if (typeof settings.defaultProvider === 'string') setProvider(settings.defaultProvider)
        if (typeof settings.defaultModel === 'string') setModelId(settings.defaultModel)
      }
      if (
        typeof defaultThinking === 'string' &&
        ALL_THINKING_LEVELS.includes(defaultThinking as ThinkingLevel)
      ) {
        setThinking(defaultThinking as ThinkingLevel)
      }
    })
  }, [])
  return { provider, modelId, thinking, setProvider, setModelId, setThinking }
}

/** The chip's words: a pick pi cannot run, or a catalogue only models.json fed, warns. */
function localChip(
  chip: ReturnType<typeof modelChipLabel>,
  provider: string | undefined,
): StartModelSource['chip'] {
  const suffix = `${chip.unavailable ? ' · unavailable' : ''}${chip.degraded ? ' · pi unreachable' : ''}`
  return {
    text: `${chip.text}${suffix}`,
    tone: chip.unavailable || chip.degraded ? 'warning' : 'normal',
    title: chip.degraded
      ? `${chip.text} · Only models.json available; open to retry the catalogue`
      : chip.unavailable
        ? `${chip.text} is not in pi's catalogue`
        : `${chip.text}${provider ? ` · served by ${provider}` : ''}`,
  }
}
