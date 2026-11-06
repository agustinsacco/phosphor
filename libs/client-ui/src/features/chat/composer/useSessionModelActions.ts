import { useSessionsStore, sessionIsOpen } from '@/stores/sessions'
import { useChatStore } from '@/stores/chat'
import { readSessionModels } from '@/stores/sessionModels'
import { useSignInAction } from '../useSignInAction'
import type { ModelAction } from './ModelActionButtons'

/** A live lane's start picker actions: read its models again, or sign in on its machine. */
export function useSessionModelActions(sessionId: string): ModelAction[] {
  const target = useSessionsStore((s) => s.live[sessionId]?.target)
  const signIn = useSignInAction(target?.kind === 'remote' ? target.hostId : 'local')
  return [{ label: 'Retry models', run: () => void retrySessionModels(sessionId) }, signIn]
}

async function retrySessionModels(sessionId: string): Promise<void> {
  const models = await readSessionModels(sessionId)
  if (sessionIsOpen(sessionId)) useChatStore.getState().setModels(sessionId, models)
}
