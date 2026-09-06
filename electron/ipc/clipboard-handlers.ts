import { clipboard, nativeImage } from 'electron'
import { handle } from './handle'
import { readFileClipboard, writeFilePaths } from '../fs/file-clipboard'

/**
 * System clipboard, image side.
 *
 * The renderer is sandboxed, and the web `ClipboardItem` API accepts
 * png/jpeg only, while pi's image set also carries gif/webp/bmp. Writing in
 * main lets `nativeImage` sniff the buffer and accept every type the chat
 * can display, so "copy" works for any dropped image.
 */
export function registerClipboardHandlers(): void {
  handle('clipboard:readFiles', () => readFileClipboard())
  handle('clipboard:writeFiles', (_event, paths, cut) => writeFilePaths(paths, cut))
  handle('clipboard:writeImage', (_event, image) => {
    const img = nativeImage.createFromBuffer(Buffer.from(image.data, 'base64'))
    if (img.isEmpty()) throw new Error(`Unreadable image data (${image.mimeType})`)
    clipboard.writeImage(img)
  })
}
