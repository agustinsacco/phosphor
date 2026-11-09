import { useExtensionUiStore } from '@/stores/extensionUi'
import { basename } from '@/lib/path'
import { revealLabel } from '@/lib/reveal'

export function toastError(message: string): void {
  useExtensionUiStore.getState().pushToast(message, 'error')
}

/** Hand a file on this device to the OS; main refuses anything it would run, and says why here. */
export async function openInDefaultApp(path: string): Promise<void> {
  const result = await window.phosphor
    .invoke('fs:openInDefaultApp', path)
    .catch((e) => ({ ok: false as const, reason: 'failed' as const, message: String(e) }))
  if (result.ok) return
  if (result.reason === 'launchable') {
    toastError(
      `${basename(path)} would run a program if opened, so Phosphor will not open it. ` +
        `Use ${revealLabel()} instead.`,
    )
  } else if (result.reason === 'not-a-file') {
    toastError(`${basename(path)} is not a regular file.`)
  } else {
    toastError(result.message)
  }
}
