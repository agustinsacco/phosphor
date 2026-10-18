import { useFilesStore, workspaceFiles } from '@/stores/files'
import { promptChoice } from '@/stores/prompt'
import { useExtensionUiStore } from '@/stores/extensionUi'

const closing = new Map<string, Promise<boolean>>()

/** All user-initiated tab closing goes here, including future bulk/keyboard actions. */
export function closeEditorFile(workspace: string, path: string): Promise<boolean> {
  const key = JSON.stringify([workspace, path])
  const pending = closing.get(key)
  if (pending) return pending
  const close = async (): Promise<boolean> => {
    const store = useFilesStore.getState()
    const current = () =>
      workspaceFiles(useFilesStore.getState(), workspace).openFiles.find((f) => f.path === path)
    const file = current()
    if (!file) return true
    if (file.dirty) {
      const choice = await promptChoice({
        title: `Save changes to ${file.relativePath}?`,
        message: 'Your changes will be lost if you close without saving.',
        choices: [
          { value: 'discard', label: 'Don’t Save' },
          { value: 'save', label: 'Save', primary: true },
        ],
      })
      if (!choice) return false
      // Never apply an old dialog's decision to a different tab or revision.
      if (current()?.instanceId !== file.instanceId || current()?.content !== file.content) {
        useExtensionUiStore
          .getState()
          .pushToast(
            'The file changed while the dialog was open. Review it before closing.',
            'info',
          )
        return false
      }
      if (choice === 'save') {
        await store.saveFile(workspace, path)
        if (current()?.instanceId !== file.instanceId || current()?.dirty) return false
      }
    }
    store.closeFile(workspace, path)
    return true
  }
  const request = close().finally(() => closing.delete(key))
  closing.set(key, request)
  return request
}
