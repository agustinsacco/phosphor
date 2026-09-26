import { useState } from 'react'
import type { Model, ThinkingLevel } from '@shared/rpc'
import { supportedThinkingLevels } from '@shared/thinking'
import { ipcErrorText } from '@shared/errors'
import { useChatStore } from '@/stores/chat'
import { piCall, piCallOk } from '@/lib/rpc'
import { refreshThinkingLevels, useSessionsStore } from '@/stores/sessions'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { ModelMenu } from './ModelMenu'
import { ThinkingMenu, thinkingLabel } from './ThinkingMenu'
import { ModelChip, ModelChipSkeleton, ThinkingChip } from './ModelChip'

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
export function ModelPicker({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const meta = useChatStore((s) => s.sessions[sessionId]?.meta)
  const models = useChatStore((s) => s.sessions[sessionId]?.models) ?? []
  const modelsLoaded = useChatStore((s) => s.sessions[sessionId]?.modelsLoaded ?? false)
  const thinkingLevels = useChatStore((s) => s.sessions[sessionId]?.thinkingLevels)
  const [open, setOpen] = useState<'model' | 'thinking' | null>(null)
  /** Model name the chip is switching to, or null when settled. */
  const [switchingTo, setSwitchingTo] = useState<string | null>(null)

  if (!meta) return null
  const currentModel = meta.model

  /**
   * Levels to render. Prefer pi's answer; derive locally when missing.
   */
  const levelsToRender: ThinkingLevel[] =
    thinkingLevels ?? (currentModel ? supportedThinkingLevels(currentModel) : [])

  const setModel = async (model: Model): Promise<void> => {
    setOpen(null)
    // The chip reports the switch for its whole duration. `set_model` is a
    // round trip, and a cross-provider one restarts the lane on top of that;
    // until this existed the menu simply closed and the old model name sat
    // there, so the click read as ignored and users clicked again.
    setSwitchingTo(model.name)
    try {
      const selected = await piCall(sessionId, {
        type: 'set_model',
        provider: model.provider,
        modelId: model.id,
      })
      if (!selected) return
      const chat = useChatStore.getState()
      // A provider quota failure is recorded on the session-wide error surface.
      // Once pi confirms a different model, that error is no longer actionable;
      // leaving it set makes a successful Claude → Bedrock recovery look broken.
      chat.setError(sessionId, null)
      // Use pi's response rather than the menu row: pi may normalize or enrich
      // the model record, and it is the authority for the live session.
      const crossedProvider = currentModel?.provider !== selected.provider
      if (crossedProvider) {
        // A provider switch changes more than the model record: provider
        // runtimes may have different context/message contracts. Rebind pi
        // from disk so the next turn starts with the persisted model change,
        // rather than asking the old process to reinterpret its in-memory
        // provider state (Claude CLI → Bedrock was the observed failure).
        //
        // Through `restartSession` so the lane keeps the screen and says it is
        // restarting: disposing clears `activeSessionId`, which used to drop
        // the user on the greeting screen until the new process answered.
        const restarted = await useSessionsStore
          .getState()
          .restartSession(sessionId, { label: selected.name })
        useExtensionUiStore
          .getState()
          .pushToast(
            restarted
              ? `Now running ${selected.name} via ${selected.provider}`
              : `Switched to ${selected.name}. It takes effect on the next turn.`,
            'info',
          )
        return
      }
      chat.patchMeta(sessionId, { model: selected })
      // Supported levels are per-model. Clear the previous model's list
      // synchronously so the ?? fallback derives from the NEW model during
      // the refresh gap (and permanently, if the refresh fails) — a stale
      // list offered levels the new model silently clamps away.
      chat.setThinkingLevels(sessionId, null)
      void refreshThinkingLevels(sessionId)
      // pi's set_model re-clamps the session's thinking level (e.g. max →
      // high on a 5-level model). Re-read state so the chip reports the
      // level the session actually runs at, not the pre-switch setting.
      void piCall(sessionId, { type: 'get_state' }).then((state) => {
        if (state?.thinkingLevel) {
          useChatStore.getState().patchMeta(sessionId, { thinkingLevel: state.thinkingLevel })
        }
      })
    } catch (error) {
      // A rejection rather than a failed envelope: main refuses a switch to
      // Claude on an outdated provider before pi sees it, and that refusal
      // says what to update. Unreported, the chip just snapped back.
      useChatStore.getState().setError(sessionId, ipcErrorText(error))
    } finally {
      setSwitchingTo(null)
    }
  }

  const setThinking = async (level: ThinkingLevel): Promise<void> => {
    setOpen(null)
    const ok = await piCallOk(sessionId, { type: 'set_thinking_level', level })
    if (ok) useChatStore.getState().patchMeta(sessionId, { thinkingLevel: level })
  }

  return (
    <div className="relative flex min-w-0 max-w-full flex-1 items-center gap-1">
      <ModelChip
        testId="model-chip"
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
            : (currentModel?.name ?? (modelsLoaded ? 'No model' : <ModelChipSkeleton />))
        }
        provider={switchingTo ? undefined : currentModel?.provider}
      />

      {/* Gate on what the menu will actually render (pi's answer when
          present), not the local guess — if the two ever disagree, a chip
          opening a one-item menu (or a hidden chip over real choices) is the
          bug this avoids. */}
      {levelsToRender.length > 1 && (
        <ThinkingChip
          testId="thinking-chip"
          active={open === 'thinking'}
          onClick={() => setOpen(open === 'thinking' ? null : 'thinking')}
          label={thinkingLabel(meta.thinkingLevel)}
        />
      )}

      {open === 'model' && (
        <ModelMenu
          models={models}
          isCurrent={(m) => currentModel?.id === m.id && currentModel.provider === m.provider}
          onPick={(m) => {
            const model = models.find((x) => x.id === m.id && x.provider === m.provider)
            if (model) void setModel(model)
          }}
          onClose={() => setOpen(null)}
          loading={!modelsLoaded}
          emptyText="No models configured — sign in via the terminal (`pi /login`) or add API keys."
          className="w-[30rem] max-w-[92vw]"
        />
      )}

      {open === 'thinking' && (
        <ThinkingMenu
          levels={levelsToRender}
          current={meta.thinkingLevel}
          onPick={(level) => void setThinking(level)}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  )
}
