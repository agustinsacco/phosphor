import { useSessionsStore, sessionIsOpen } from '@/stores/sessions'
import { applySessionModels, readSessionModels } from '@/stores/sessionModels'
import { useSignInAction } from '../useSignInAction'
import type { SettingsMachine } from '@/features/settings/settingsUiStore'
import type { ModelAction } from './ModelActionButtons'

/** A live lane's machine and its start picker actions: read its models again, or sign in there. */
export function useSessionModelActions(sessionId: string): {
  machine: SettingsMachine
  actions: ModelAction[]
} {
  const target = useSessionsStore((s) => s.live[sessionId]?.target)
  const machine = target?.kind === 'remote' ? target.hostId : 'local'
  const signIn = useSignInAction(machine)
  return {
    machine,
    actions: [{ label: 'Retry models', run: () => void retrySessionModels(sessionId) }, signIn],
  }
}

async function retrySessionModels(sessionId: string): Promise<void> {
  const models = await readSessionModels(sessionId)
  if (sessionIsOpen(sessionId)) applySessionModels(sessionId, models)
}
