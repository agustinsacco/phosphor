import { ipcErrorText } from '@shared/errors'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { openFileInWorkspace } from '@/stores/layout'

/**
 * Write an artifact's text into its lane's workspace, then open it in that lane's Files. A Host
 * write replaces only the revision it names (null: a new file); This Mac's write ignores it.
 * A failure is a toast.
 */
export function openArtifactInFiles(
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
