import type { HostLaneView } from '@shared/ipc'
import { useAgentHints } from '@/features/agent-control/useAgentHints'
import { rememberRemoteThinking } from '@/stores/remoteModelPicks'
import { useSessionHostLane } from '@/stores/remoteLanes'
import { laneWithoutPi } from '@/stores/hostLaneOf'
import { useState } from 'react'
import type { Model, ThinkingLevel } from '@shared/rpc'
import { supportedThinkingLevels } from '@shared/thinking'
import { useChatStore } from '@/stores/chat'
import { piCallOk } from '@/lib/rpc'
import { useSessionsStore } from '@/stores/sessions'
import { MODELS_READ_FAILED, useMachineCatalogue } from '@/stores/machineCatalogues'
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
  return <SessionModelPicker key={sessionId} sessionId={sessionId} />
}

/** One row for the live picker and a lane's recorded model, so pi coming up reuses it. */
const PICKER_ROW = 'relative flex min-w-0 max-w-full flex-1 items-center'

/**
 * A stopped or starting lane has no pi to ask, even when the chat store still
 * holds the last pi's state: the lane's recorded model holds the live chip's
 * place, so the bar keeps its shape when pi comes up. It is named from a
 * catalogue this client already read, and never reads one.
 */
function RecordedModelChip({
  hostId,
  model,
  level,
}: {
  hostId: string | null
  model: { provider: string; id: string } | null
  level?: ThinkingLevel | undefined
}): React.JSX.Element | null {
  const catalogue = useMachineCatalogue(hostId, false)
  const known = catalogue.models.find((m) => m.provider === model?.provider && m.id === model.id)
  if (!model) return null
  return (
    <ModelChip
      testId="model-chip"
      name={known?.name ?? model.id}
      grouped={level !== undefined}
      title="Starts with the lane"
      active={false}
      onClick={() => {}}
      disabled
    />
  )
}

function RecordedChips({
  hostId,
  lane,
}: {
  hostId: string | null
  lane: HostLaneView | undefined
}) {
  const saved = laneWithoutPi(lane) ? lane?.stoppedComposer : undefined
  return (
    <>
      <RecordedModelChip
        hostId={hostId}
        model={saved?.model ?? lane?.model ?? null}
        level={saved?.thinkingLevel}
      />
      {saved?.thinkingLevel && (
        <ThinkingChip
          testId="thinking-chip"
          active={false}
          disabled
          onClick={() => {}}
          label={thinkingLabel(saved.thinkingLevel)}
        />
      )}
    </>
  )
}

function SessionModelPicker({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const hints = useAgentHints(sessionId)
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
  const { switchingTo, switchTo } = useSessionModelSwitch(sessionId, currentModel, remote, () =>
    hints.clear('model'),
  )
  const { actions, retry } = useSessionModelActions(sessionId)
  const refreshing = useChatStore((s) => s.sessions[sessionId]?.modelsRefreshing ?? false)
  const failed = useChatStore((s) => s.sessions[sessionId]?.modelsFailed ?? false)

  if (!meta || laneWithoutPi(hostLane?.lane))
    return (
      <div className={PICKER_ROW}>
        <RecordedChips hostId={hostId} lane={hostLane?.lane} />
      </div>
    )

  const levelsToRender: ThinkingLevel[] =
    thinkingLevels ?? (currentModel ? supportedThinkingLevels(currentModel) : [])

  const setThinking = async (level: ThinkingLevel): Promise<void> => {
    setOpen(null)
    const ok = await piCallOk(sessionId, { type: 'set_thinking_level', level })
    if (ok) {
      hints.clear('thinking')
      useChatStore.getState().patchMeta(sessionId, { thinkingLevel: level })
      const target = useSessionsStore.getState().live[sessionId]?.target
      if (target?.kind === 'remote') rememberRemoteThinking(target.hostId, level)
    }
  }

  return (
    <div className={PICKER_ROW}>
      <ModelChip
        testId="model-chip"
        agentHint={hints.model}
        grouped={levelsToRender.length > 1}
        active={open === 'model'}
        // A second pick would race the first one’s cross-provider restart.
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

      {levelsToRender.length > 1 && (
        <div className="relative shrink-0">
          <ThinkingChip
            testId="thinking-chip"
            active={open === 'thinking'}
            onClick={() => setOpen(open === 'thinking' ? null : 'thinking')}
            agentHint={hints.thinking}
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
          loading={!modelsLoaded || refreshing}
          emptyText="No models configured."
          error={failed ? MODELS_READ_FAILED : null}
          onRetry={retry}
          unavailable={unavailable}
          className="w-[30rem] max-w-[92vw]"
        />
      )}
      {!refreshing && (failed || (modelsLoaded && models.length === 0)) && (
        <ModelActionButtons actions={actions} />
      )}
    </div>
  )
}
