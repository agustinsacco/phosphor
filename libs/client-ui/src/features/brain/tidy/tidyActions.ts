import { ipcErrorText } from '@shared/errors'
import type { BrainTidyMutation } from '@shared/brain-tidy'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { brainToast, mutateBrain, useBrain } from '../useBrain'
import { openTidy } from '../brainNavigation'

/** The toast's labelled action uses a fresh revision, never an old pre-change revision. */
export function tidyChangeToast(result: BrainTidyMutation, message: string): void {
  const id = result.operationId
  useExtensionUiStore.getState().notify({
    message,
    kind: 'success',
    ...(id ? { title: 'Brain', openLabel: 'Undo', onOpen: () => undoFromToast(id) } : {}),
  })
}
async function undoFromToast(id: string): Promise<void> {
  let revision: number | undefined
  try {
    await useBrain.getState().refresh()
    const { status, error } = useBrain.getState()
    if (!status || error) throw new Error(error || 'Load Brain before undoing.')
    revision = status.revision
    await mutateBrain(() => window.phosphor.invoke('brain:tidyUndo', id, status.revision))
    brainToast('Change undone')
  } catch (cause) {
    await useBrain.getState().refresh()
    const current = useBrain.getState().status?.revision
    brainToast(
      revision !== undefined && current !== undefined && revision !== current
        ? 'Brain changed. Check this again.'
        : ipcErrorText(cause),
      'error',
    )
    // Opening Recent changes explicitly reloads both its list and operation detail.
    openTidy(true)
  }
}
