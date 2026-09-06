import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import type { ThinkingLevel } from '@shared/rpc'
import { ALL_THINKING_LEVELS, clampThinkingLevel, supportedThinkingLevels } from '@shared/thinking'
import { ModelMenu } from '@/features/chat/composer/ModelMenu'
import { ThinkingMenu, thinkingLabel } from '@/features/chat/composer/ThinkingMenu'
import {
  catalogueEmptyText,
  modelChipLabel,
  useModelCatalogueStore,
  type CatalogueModel,
} from '@/stores/modelCatalogue'

/**
 * Model + thinking pickers for the home screen, where no session exists yet.
 *
 * The session composer's picker drives a live pi process over RPC. Here there
 * is nothing to talk to, so these read and write pi's own defaults
 * (`defaultProvider` / `defaultModel` / `defaultThinkingLevel` in
 * settings.json). That is the same surface pi itself uses to pick a model on
 * startup, so whatever is shown here is genuinely what the next session will
 * run with — not a pidex-local preference that silently disagrees.
 *
 * Supported thinking levels are derived locally via `supportedThinkingLevels`
 * (shared/thinking.ts), which implements pi's per-model rules over the
 * `thinkingLevelMap` the catalogue now carries. A live session still prefers
 * pi's own `get_available_thinking_levels` answer; this derivation is what a
 * new session will get, computed from the same data pi computes it from.
 */
export function HomeModelPicker({
  override,
  onPick,
}: {
  /**
   * The model this workspace's saved draft was composed against. It wins over
   * pi's global default: coming back to a draft should restore the model you
   * chose for it, not whatever some later session set globally.
   */
  override?: { provider: string; id: string } | undefined
  onPick?: (model: { provider: string; id: string }) => void
} = {}): React.JSX.Element | null {
  const status = useModelCatalogueStore((s) => s.status)
  const models = useModelCatalogueStore((s) => s.models)
  const providers = useModelCatalogueStore((s) => s.providers)
  const [provider, setProvider] = useState<string | null>(null)
  const [modelId, setModelId] = useState<string | null>(null)
  const [thinking, setThinking] = useState<ThinkingLevel>('off')
  const [open, setOpen] = useState<'model' | 'thinking' | null>(null)

  useEffect(() => {
    if (!override) return
    setProvider(override.provider)
    setModelId(override.id)
  }, [override])

  useEffect(() => {
    // Usually a no-op — App hydrates this at boot, well before the home
    // screen renders. It stays here so the picker still works if it does not.
    void useModelCatalogueStore.getState().hydrate()
    void window.pidex.invoke('pi:agentSettings').then((settings) => {
      const defaultProvider = settings.defaultProvider
      const defaultModel = settings.defaultModel
      const defaultThinking = settings.defaultThinkingLevel
      // An override (a restored draft's model) has already been applied.
      if (!override) {
        if (typeof defaultProvider === 'string') setProvider(defaultProvider)
        if (typeof defaultModel === 'string') setModelId(defaultModel)
      }
      if (
        typeof defaultThinking === 'string' &&
        ALL_THINKING_LEVELS.includes(defaultThinking as ThinkingLevel)
      ) {
        setThinking(defaultThinking as ThinkingLevel)
      }
    })
  }, [])

  const current = models.find((m) => m.id === modelId && m.provider === provider)
  const chip = modelChipLabel(status, current, modelId)
  const busy = status === 'idle' || status === 'loading'

  /** Levels to render, derived per-model — including xhigh/max when mapped. */
  const levelsToRender: ThinkingLevel[] = useMemo(
    () => (current ? supportedThinkingLevels(current) : []),
    [current],
  )

  /**
   * The chip shows what the next session will RUN at, not the raw persisted
   * value: pi writes defaultThinkingLevel on every in-session change, so a
   * 'max' persisted from another model must display as this model's clamp
   * (pi applies the same clamp on startup).
   */
  const displayedThinking = current ? clampThinkingLevel(current, thinking) : thinking

  const chooseModel = (model: CatalogueModel): void => {
    setOpen(null)
    setProvider(model.provider)
    setModelId(model.id)
    onPick?.({ provider: model.provider, id: model.id })
    void window.pidex.invoke('pi:patchAgentSettings', 'global', undefined, {
      defaultProvider: model.provider,
      defaultModel: model.id,
    })
  }

  const chooseThinking = (level: ThinkingLevel): void => {
    setOpen(null)
    setThinking(level)
    void window.pidex.invoke('pi:patchAgentSettings', 'global', undefined, {
      defaultThinkingLevel: level,
    })
  }

  return (
    <div className="relative flex min-w-0 max-w-full flex-1 items-center gap-0.5">
      {/* Disabled until the catalogue lands: picking writes pi's global
          default, so a click on a half-known list is a real mis-set, not a
          cosmetic one. */}
      <button
        onClick={() => setOpen(open === 'model' ? null : 'model')}
        disabled={busy}
        data-testid="home-model-picker"
        data-loading={busy ? 'true' : undefined}
        title={
          chip.unavailable
            ? `${chip.text} is not in pi's catalogue`
            : `${chip.text}${current ? ` · via ${current.provider}` : ''}`
        }
        className={clsx(
          'min-h-8 min-w-0 flex-1 rounded-md px-2 py-1 text-left text-lg font-medium transition-colors',
          busy ? 'cursor-default' : 'cursor-pointer',
          open === 'model'
            ? 'bg-bg-secondary text-text'
            : 'text-text-secondary hover:bg-bg-secondary hover:text-text',
        )}
      >
        {chip.loading ? (
          <span className="bg-bg-secondary inline-block h-3.5 w-24 animate-pulse rounded align-middle" />
        ) : (
          <span className={clsx('block truncate', chip.unavailable && 'text-warning')}>
            {chip.text}
            {chip.unavailable && ' · unavailable'}
          </span>
        )}
        {current && (
          <span className="text-text-secondary block truncate font-mono text-base">
            via {current.provider}
          </span>
        )}
      </button>

      {levelsToRender.length > 1 && (
        <button
          onClick={() => setOpen(open === 'thinking' ? null : 'thinking')}
          data-testid="home-thinking-picker"
          className={clsx(
            'min-h-8 shrink-0 cursor-pointer rounded-md px-2 py-1 text-lg transition-colors',
            open === 'thinking'
              ? 'bg-bg-secondary text-text'
              : 'text-text-secondary hover:bg-bg-secondary hover:text-text',
          )}
        >
          {thinkingLabel(displayedThinking)}
        </button>
      )}

      {open === 'model' && (
        <ModelMenu
          models={models}
          isCurrent={(m) => m.id === modelId && m.provider === provider}
          onPick={(m) => {
            const model = models.find((x) => x.id === m.id && x.provider === m.provider)
            if (model) chooseModel(model)
          }}
          onClose={() => setOpen(null)}
          loading={busy}
          emptyText={catalogueEmptyText(status, providers)}
          className="w-[30rem] max-w-[92vw]"
        />
      )}

      {open === 'thinking' && (
        <ThinkingMenu
          levels={levelsToRender}
          current={displayedThinking}
          onPick={chooseThinking}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  )
}
