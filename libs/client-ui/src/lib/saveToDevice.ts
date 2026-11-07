import { downloadBytes } from '@phosphor/shared/download'
import type { SaveDialogOptions } from '@shared/models'

export interface DeviceFile {
  /** The suggested file name, for the save dialog and the download alike. */
  name: string
  title: string
  filters?: SaveDialogOptions['filters']
  /** Read after the save dialog, so a cancelled dialog costs nothing. */
  content: () => string | Promise<string>
}

/**
 * Keep a file on this device: with `nativeFiles`, the save dialog, a write and
 * a reveal; otherwise a download. Failures reach the caller.
 */
export async function saveToDevice(file: DeviceFile, nativeFiles: boolean): Promise<void> {
  if (!nativeFiles) return downloadBytes(file.name, await file.content())
  const path = await window.phosphor.invoke('app:saveDialog', {
    title: file.title,
    defaultPath: file.name,
    ...(file.filters ? { filters: file.filters } : {}),
  })
  if (!path) return
  await window.phosphor.invoke('fs:writeFile', path, await file.content())
  await window.phosphor.invoke('app:revealPath', path)
}
