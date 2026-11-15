import { base64ToBytes, bytesToBase64 } from './base64'
import { ipcErrorText } from './errors'

interface ClipboardImage {
  data: string
  mimeType: string
}

/** API availability only: browsers still decide permission at the user's gesture. */
export function canWriteBrowserImage(): boolean {
  return typeof navigator.clipboard?.write === 'function' && typeof ClipboardItem !== 'undefined'
}

/** PNG is the portable ClipboardItem image format (including JPEG sources). */
async function imagePng(image: ClipboardImage): Promise<Blob> {
  if (image.mimeType === 'image/png')
    return new Blob([base64ToBytes(image.data)], { type: 'image/png' })
  const decoded = new Image()
  decoded.src = `data:${image.mimeType};base64,${image.data}`
  await decoded.decode()
  const canvas = document.createElement('canvas')
  canvas.width = decoded.naturalWidth
  canvas.height = decoded.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Image conversion is unavailable.')
  ctx.drawImage(decoded, 0, 0)
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('PNG conversion failed.'))),
      'image/png',
    ),
  )
}

export async function writeBrowserImage(image: ClipboardImage): Promise<void> {
  if (!canWriteBrowserImage())
    throw new Error('This browser cannot copy images. Save the image instead.')
  try {
    // Keep write() inside the gesture: WebKit expires activation while decoding.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': imagePng(image) })])
  } catch (error) {
    throw new Error(`The browser could not copy the image: ${ipcErrorText(error)}`, {
      cause: error,
    })
  }
}

export async function readBrowserImage(): Promise<ClipboardImage | null> {
  if (typeof navigator.clipboard?.read !== 'function')
    throw new Error('This browser cannot read clipboard images. Paste or attach an image instead.')
  try {
    for (const item of await navigator.clipboard.read()) {
      const mimeType = item.types.find((type) => type.startsWith('image/'))
      if (!mimeType) continue
      const blob = await item.getType(mimeType)
      return { data: bytesToBase64(await blob.arrayBuffer()), mimeType }
    }
    return null
  } catch (error) {
    throw new Error(`The browser could not read the clipboard: ${ipcErrorText(error)}`, {
      cause: error,
    })
  }
}
