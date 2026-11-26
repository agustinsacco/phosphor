import { useSessionsStore, sessionIsOpen } from '@/stores/sessions'
import { loadSessionModels } from '@/stores/sessionModels'
import { useSignInAction } from '../useSignInAction'
import type { SettingsMachine } from '@/features/settings/settingsUiStore'
import type { ModelAction } from './ModelActionButtons'

/** A live lane's machine and its start picker actions: read its models again, or sign in there. */
export function useSessionModelActions(sessionId: string): {
  machine: SettingsMachine
  actions: ModelAction[]
  retry: () => void
} {
  const target = useSessionsStore((s) => s.live[sessionId]?.target)
  const machine = target?.kind === 'remote' ? target.hostId : 'local'
  const signIn = useSignInAction(machine)
  const retry = () => void loadSessionModels(sessionId, () => sessionIsOpen(sessionId))
  return {
    machine,
    actions: [{ label: 'Retry models', run: retry }, signIn],
    retry,
  }
}
