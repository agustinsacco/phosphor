/**
 * pi fits every image into this square before a model sees it (its
 * `images.autoResize` setting), so pixels beyond it are never used.
 */
export const MODEL_IMAGE_EDGE = 2000
/** A JPEG within the edge and at most this heavy is sent as it is. */
const KEEP_JPEG_BYTES = 1024 * 1024
const QUALITY = 0.85

interface DecodedImage {
  width: number
  height: number
  render(width: number, height: number, type: string, quality: number): Promise<Blob | null>
  close(): void
}

export interface ImagePorts {
  /** Null when this browser cannot decode the file. */
  decode(file: Blob): Promise<DecodedImage | null>
}

/** The browser's decoder, off the main thread where `createImageBitmap` allows. */
const browserPorts: ImagePorts = {
  async decode(file) {
    if (typeof createImageBitmap !== 'function') return null
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    return {
      width: bitmap.width,
      height: bitmap.height,
      render: (width, height, type, quality) => {
        if (typeof OffscreenCanvas === 'function') {
          const canvas = new OffscreenCanvas(width, height)
          canvas.getContext('2d')?.drawImage(bitmap, 0, 0, width, height)
          return canvas.convertToBlob({ type, quality })
        }
        const canvas = Object.assign(document.createElement('canvas'), { width, height })
        canvas.getContext('2d')?.drawImage(bitmap, 0, 0, width, height)
        return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
      },
      close: () => bitmap.close(),
    }
  },
}

/**
 * The image a Host-bound prompt should carry. A phone photo is 3 to 12 MB, sent
 * as base64 over what may be a weak link, and two of them overflow the Host's
 * prompt frame. Fitting it into `MODEL_IMAGE_EDGE` keeps everything the model
 * would see. Anything this cannot improve comes back unchanged: a GIF (redrawing
 * keeps one frame), an image that already fits, or one the browser cannot
 * decode or re-encode smaller.
 */
export async function shrinkImage(file: File, ports: ImagePorts = browserPorts): Promise<File> {
  if (file.type === 'image/gif') return file
  const image = await ports.decode(file).catch(() => null)
  if (!image) return file
  try {
    const edge = Math.max(image.width, image.height)
    const fits = edge <= MODEL_IMAGE_EDGE
    if (fits && (file.type !== 'image/jpeg' || file.size <= KEEP_JPEG_BYTES)) return file
    const scale = fits ? 1 : MODEL_IMAGE_EDGE / edge
    const width = Math.max(1, Math.round(image.width * scale))
    const height = Math.max(1, Math.round(image.height * scale))
    const blob = await image.render(width, height, file.type, QUALITY).catch(() => null)
    // A browser that cannot encode the type falls back to PNG; keep what it made.
    if (!blob || blob.size >= file.size) return file
    return new File([blob], file.name, {
      type: blob.type || file.type,
      lastModified: file.lastModified,
    })
  } finally {
    image.close()
  }
}
