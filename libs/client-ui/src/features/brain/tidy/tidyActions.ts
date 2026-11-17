import { ipcErrorText } from '@shared/errors'
import type { BrainTidyMutation } from '@shared/brain-tidy'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { brainToast, mutateBrain, useBrain } from '../useBrain'

/** The toast's labelled action uses a fresh revision, never an old pre-change revision. */
export function tidyChangeToast(result: BrainTidyMutation, message: string): void {
  const id = result.operationId
  useExtensionUiStore.getState().notify({
    message,
    kind: 'success',
    ...(id
      ? {
          openLabel: 'Undo',
          onOpen: async () => {
            try {
              await useBrain.getState().refresh()
              const status = useBrain.getState().status
              if (!status) throw new Error('Load Brain before undoing.')
              await mutateBrain(() => window.phosphor.invoke('brain:tidyUndo', id, status.revision))
              brainToast('Change undone')
            } catch (cause) {
              brainToast(ipcErrorText(cause), 'error')
              await useBrain.getState().refresh()
            }
          },
        }
      : {}),
  })
}
