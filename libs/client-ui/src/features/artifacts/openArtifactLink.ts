import { openArtifact } from '@/stores/artifacts'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useSessionsStore } from '@/stores/sessions'
import { refreshRemoteArtifacts } from './remoteArtifactRefresh'

/**
 * Open an `artifact://<id>` link from chat in its session's pane.
 *
 * A Host lane's artifacts are a copy read from the Host, and that copy can
 * trail the chat that links them: the last read raced pi's write, or the Host
 * was unreachable then. So a miss on a Host lane reads once more before it says
 * the artifact is not there. A local session's store is filled live, so its
 * miss is final.
 */
export async function openArtifactLink(
  sessionId: string | null,
  id: string,
  version?: number,
): Promise<void> {
  if (sessionId && openArtifact(sessionId, id, version)) return
  if (sessionId && useSessionsStore.getState().live[sessionId]?.target?.kind === 'remote') {
    await refreshRemoteArtifacts(sessionId)
    if (openArtifact(sessionId, id, version)) return
  }
  useExtensionUiStore.getState().pushToast(`No artifact "${id}" in this session`, 'error')
}
