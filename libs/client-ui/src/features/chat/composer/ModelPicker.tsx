import { rememberRemoteThinking } from '@/stores/remoteModelPicks'
import { useSessionHostLane } from '@/stores/remoteLanes'
import { useState } from 'react'
import type { Model, ThinkingLevel } from '@shared/rpc'
import { supportedThinkingLevels } from '@shared/thinking'
import { useChatStore } from '@/stores/chat'
import { piCallOk } from '@/lib/rpc'
import { useSessionsStore } from '@/stores/sessions'
import { MODELS_READ_FAILED } from '@/stores/machineCatalogues'
import { ModelActionButtons } from './ModelActionButtons'
import { useSessionModelActions } from './useSessionModelActions'
import { useSessionModelSwitch } from './useSessionModelSwitch'
import { ModelMenu } from './ModelMenu'
import { ThinkingMenu, thinkingLabel } from './ThinkingMenu'
import { ModelChip, ModelChipSkeleton, ThinkingChip } from './ModelChip'
import { useHostModelUnavailability } from '@/features/settings/machine/useHostModelUnavailability'

/**
 * Model + thinking-level pickers in the composer footer.
 *
 * The thinking chip only appears when the model has more than one level to
 * choose from. The levels rendered are:
 *   - pi's authoritative answer (`get_available_thinking_levels`) when available
 *   - local derivation (`supportedThinkingLevels`) otherwise — same algorithm,
 *     just computed client-side to match rather than a hardcoded list that was
 *     wrong for most models.
 */
const NO_MODELS: Model[] = []

export function ModelPicker({ sessionId }: { sessionId: string }): React.JSX.Element {
  // Menu and in-flight selection feedback belong to the lane, too.
  return <SessionModelPicker key={sessionId} sessionId={sessionId} />
}

function SessionModelPicker({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const hostLane = useSessionHostLane(sessionId)
  const hostId = hostLane?.hostId ?? null
  const remote = hostId !== null
  const summaryModel = hostLane?.lane?.model
  const meta = useChatStore((s) => s.sessions[sessionId]?.meta)
  const models = useChatStore((s) => s.sessions[sessionId]?.models) ?? NO_MODELS
  const modelsLoaded = useChatStore((s) => s.sessions[sessionId]?.modelsLoaded ?? false)
  const thinkingLevels = useChatStore((s) => s.sessions[sessionId]?.thinkingLevels)
  const [open, setOpen] = useState<'model' | 'thinking' | null>(null)
  const unavailable = useHostModelUnavailability(hostId, models, open === 'model')
  const currentModel =
    !summaryModel ||
    (meta?.model?.provider === summaryModel.provider && meta.model?.id === summaryModel.id)
      ? meta?.model
      : undefined
  const { switchingTo, switchTo } = useSessionModelSwitch(sessionId, currentModel, remote)
  const actions = useSessionModelActions(sessionId)
  const failed = useChatStore((s) => s.sessions[sessionId]?.modelsFailed ?? false)

  if (!meta) {
    return summaryModel ? (
      <ModelChip
        testId="model-chip"
        name={summaryModel.id}
        active={false}
        onClick={() => {}}
        disabled
      />
    ) : null
  }
  /**
   * Levels to render. Prefer pi's answer; derive locally when missing.
   */
  const levelsToRender: ThinkingLevel[] =
    thinkingLevels ?? (currentModel ? supportedThinkingLevels(currentModel) : [])

  const setThinking = async (level: ThinkingLevel): Promise<void> => {
    setOpen(null)
    const ok = await piCallOk(sessionId, { type: 'set_thinking_level', level })
    if (ok) {
      useChatStore.getState().patchMeta(sessionId, { thinkingLevel: level })
      const target = useSessionsStore.getState().live[sessionId]?.target
      if (target?.kind === 'remote') rememberRemoteThinking(target.hostId, level)
    }
  }

  return (
    <div className="relative flex min-w-0 max-w-full flex-1 items-center">
      <ModelChip
        testId="model-chip"
        grouped={levelsToRender.length > 1}
        active={open === 'model'}
        // Inert while switching: a second pick against a session that is being
        // disposed and respawned races the restart it would be re-entering.
        disabled={switchingTo !== null}
        loading={switchingTo !== null}
        onClick={() => setOpen(open === 'model' ? null : 'model')}
        title={
          switchingTo
            ? `Switching to ${switchingTo}…`
            : currentModel
              ? `${currentModel.name} · served by ${currentModel.provider}`
              : undefined
        }
        name={
          switchingTo
            ? `Switching to ${switchingTo}…`
            : (currentModel?.name ??
              summaryModel?.id ??
              (failed ? MODELS_READ_FAILED : modelsLoaded ? 'No model' : <ModelChipSkeleton />))
        }
      />

      {/* Gate on what the menu will actually render (pi's answer when
          present), not the local guess — if the two ever disagree, a chip
          opening a one-item menu (or a hidden chip over real choices) is the
          bug this avoids. */}
      {levelsToRender.length > 1 && (
        // Its own anchor: the picker spans the footer's free width, so a
        // menu placed against it opens under the model chip, not this one.
        <div className="relative shrink-0">
          <ThinkingChip
            testId="thinking-chip"
            active={open === 'thinking'}
            onClick={() => setOpen(open === 'thinking' ? null : 'thinking')}
            label={thinkingLabel(meta.thinkingLevel)}
          />
          {open === 'thinking' && (
            <ThinkingMenu
              levels={levelsToRender}
              current={meta.thinkingLevel}
              onPick={(level) => void setThinking(level)}
              onClose={() => setOpen(null)}
            />
          )}
        </div>
      )}

      {open === 'model' && (
        <ModelMenu
          models={models}
          isCurrent={(m) => currentModel?.id === m.id && currentModel.provider === m.provider}
          onPick={(m) => {
            const model = models.find((x) => x.id === m.id && x.provider === m.provider)
            if (!model) return
            setOpen(null)
            void switchTo(model)
          }}
          onClose={() => setOpen(null)}
          loading={!modelsLoaded}
          emptyText={failed ? MODELS_READ_FAILED : 'No models configured.'}
          unavailable={unavailable}
          className="w-[30rem] max-w-[92vw]"
        />
      )}
      {(failed || (modelsLoaded && models.length === 0)) && (
        <ModelActionButtons actions={actions} />
      )}
    </div>
  )
}
