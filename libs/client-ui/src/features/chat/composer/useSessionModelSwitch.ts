import { useState } from 'react'
import type { Model } from '@shared/rpc'
import { ipcErrorText } from '@shared/errors'
import { piCall } from '@/lib/rpc'
import { useChatStore } from '@/stores/chat'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { rememberRemoteModel } from '@/stores/remoteModelPicks'
import { refreshThinkingLevels, useSessionsStore } from '@/stores/sessions'

/**
 * Choosing a live lane's model: `set_model` over RPC, a restart when This Mac's lane crosses
 * providers, and the name of the model being switched to while that runs.
 */
export function useSessionModelSwitch(
  sessionId: string,
  currentModel: Model | null | undefined,
  remote: boolean,
): { switchingTo: string | null; switchTo: (model: Model) => Promise<void> } {
  const [switchingTo, setSwitchingTo] = useState<string | null>(null)
  const switchTo = async (model: Model): Promise<void> => {
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
      const target = useSessionsStore.getState().live[sessionId]?.target
      if (target?.kind === 'remote') rememberRemoteModel(target.hostId, selected)
      const chat = useChatStore.getState()
      // A provider quota failure is recorded on the session-wide error surface.
      // Once pi confirms a different model, that error is no longer actionable;
      // leaving it set makes a successful Claude → Bedrock recovery look broken.
      chat.setError(sessionId, null)
      // Use pi's response rather than the menu row: pi may normalize or enrich
      // the model record, and it is the authority for the live session.
      const crossedProvider = currentModel?.provider !== selected.provider
      if (crossedProvider && !remote) {
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
  return { switchingTo, switchTo }
}
