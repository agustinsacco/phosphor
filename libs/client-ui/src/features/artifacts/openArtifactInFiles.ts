import { ipcErrorText } from '@shared/errors'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { openFileInWorkspace } from '@/stores/layout'
import type { Artifact } from '@/stores/artifacts'
import { useLaneWriteRefusal } from '@/features/files/laneWriteRefusal'
import { suggestedFileName } from './artifactKinds'

/**
 * Write an artifact's text into its lane's workspace, then open it in that lane's Files. A Host
 * write replaces only the revision it names (null: a new file); This Mac's write ignores it.
 * A failure is a toast.
 */
function openArtifactInFiles(
  workspacePath: string,
  fileName: string,
  content: string,
  sessionId?: string,
): Promise<void> {
  const target = `${workspacePath}/${fileName}`
  return window.phosphor
    .invoke('fs:readFile', target)
    .catch(() => null)
    .then((existing) =>
      window.phosphor.invoke('fs:writeFile', target, content, existing?.revision ?? null),
    )
    .then(() => openFileInWorkspace(workspacePath, target, undefined, sessionId))
    .catch((error: unknown) => {
      useExtensionUiStore.getState().pushToast(ipcErrorText(error), 'error')
    })
}

/**
 * The artifact pane's "Write into workspace and open in Files": why this client cannot write
 * into the lane now (the same rule as the Host Files pane), and the write.
 */
export function useOpenArtifactInFiles(workspacePath: string, sessionId?: string) {
  const refusal = useLaneWriteRefusal(sessionId ?? '')
  const open = (artifact: Artifact, content: string) =>
    openArtifactInFiles(workspacePath, suggestedFileName(artifact), content, sessionId)
  return { refusal, open }
}
