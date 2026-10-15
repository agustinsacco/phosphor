import type { ImageContent } from '@shared/rpc'
import { bytesToBase64 } from '@/lib/base64'
import type { Scene } from './imageEditor/scene'

/**
 * Composer attachments.
 *
 * pi's protocol carries IMAGES ONLY — `UserContentBlock = TextContent |
 * ImageContent`, and pi's own MIME sniffer (dist/utils/mime.js) accepts just
 * jpeg/png/gif/webp/bmp. There is no document or file content type, so a PDF
 * cannot be inlined no matter how it is encoded.
 *
 * Anything that is not a supported image is therefore attached BY PATH: the
 * path is appended to the prompt and the agent opens the file with its own
 * tools (read, bash, or a document skill). That mirrors how pi's own `@file`
 * handling works for non-images, and it means the feature works for any file
 * type rather than just the ones we could convert.
 */

/** MIME types pi will actually accept as an inline image. */
const PI_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'])

export function isInlineableImage(mimeType: string): boolean {
  return PI_IMAGE_MIME.has(mimeType)
}

export interface PendingImage {
  /** Memory-only identity for concurrent remote sends. */
  draftAttachmentId?: string
  kind: 'image'
  data: string
  mimeType: string
  name: string
  /**
   * Where the bytes were persisted for a saved draft (`userData/drafts/`).
   * In-memory bookkeeping only: it never reaches pi, and an image that has not
   * been saved does not have one. See `src/stores/drafts.ts`.
   */
  blobId?: string
  /**
   * The annotator's layers, kept so reopening the editor can still move or
   * delete a shape. `data` is always the flattened PNG and is all pi sees.
   * Memory only: a restored draft comes back flattened.
   */
  annotation?: Scene
}

export interface PendingFile {
  /** Memory-only identity for concurrent remote sends. */
  draftAttachmentId?: string
  kind: 'file'
  /** Absolute path — this is what the agent is told to open. */
  path: string
  name: string
  size: number
  /** Remote picks keep bytes in memory, never a Host path in a draft. */
  data?: string
  mime?: string
}

export type PendingAttachment = PendingImage | PendingFile

/** Human-readable size for the attachment chip. */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Turn a dropped/picked File into an attachment.
 *
 * Images are read into base64 and travel inline. Everything else needs a real
 * path; when the path is unavailable (a File constructed in JS, or a browser
 * harness with no Electron) the file is rejected rather than silently attached
 * as something the agent cannot open.
 */
export async function toAttachment(
  file: File,
  pathForFile: (file: File) => string,
  remote = false,
): Promise<PendingAttachment | null> {
  if (isInlineableImage(file.type)) {
    return {
      kind: 'image',
      data: bytesToBase64(await file.arrayBuffer()),
      mimeType: file.type,
      name: file.name,
    }
  }
  if (remote)
    return {
      kind: 'file',
      path: '',
      name: file.name,
      size: file.size,
      data: bytesToBase64(await file.arrayBuffer()),
      mime: file.type,
    }
  const path = pathForFile(file)
  if (!path) return null
  return { kind: 'file', path, name: file.name, size: file.size }
}

/** Inline image blocks for the RPC `images` field. */
export function toImageContents(attachments: PendingAttachment[]): ImageContent[] {
  return attachments
    .filter((a): a is PendingImage => a.kind === 'image')
    .map((a) => ({ type: 'image', data: a.data, mimeType: a.mimeType }))
}

/**
 * Path block appended to the prompt for non-image attachments.
 *
 * One path per line inside a named block so the agent can spot it
 * unambiguously; returns '' when there are no file attachments so callers can
 * concatenate unconditionally.
 */
export function buildAttachmentBlock(attachments: PendingAttachment[]): string {
  const paths = attachments.filter((a): a is PendingFile => a.kind === 'file').map((a) => a.path)
  if (paths.length === 0) return ''
  return `\n\n<attached-files>\n${paths.join('\n')}\n</attached-files>`
}

/** Full prompt text: what the user typed plus any attached file paths. */
export function composePrompt(text: string, attachments: PendingAttachment[]): string {
  return `${text}${buildAttachmentBlock(attachments)}`
}

/**
 * Rebuild composer attachments from a message's persisted images.
 *
 * The inverse of `toImageContents`, used when a rewind hands a sent message
 * back for editing. pi's protocol keeps no filename for an inline image, so
 * the chip gets a positional one — it is display-only and never reaches pi.
 */
export function fromImageContents(images: ImageContent[]): PendingImage[] {
  return images.map((image, index) => ({
    kind: 'image',
    data: image.data,
    mimeType: image.mimeType,
    name: `image-${index + 1}`,
  }))
}

/** `shot.png` stays `shot.png` in place; a kept-alongside copy is `shot-annotated.png`. */
export function annotatedName(name: string, replace: boolean): string {
  const stem = name.replace(/\.[^./]+$/, '')
  if (replace || stem.endsWith('-annotated')) return `${stem}.png`
  return `${stem}-annotated.png`
}

/**
 * Where an annotated image lands: in place of the one it was made from, or
 * right after it so both stay attached and the user removes either.
 */
export function placeAnnotated(
  attachments: PendingAttachment[],
  index: number,
  image: PendingImage,
  replace: boolean,
): PendingAttachment[] {
  if (!attachments[index]) return attachments
  return replace
    ? attachments.map((a, i) => (i === index ? image : a))
    : [...attachments.slice(0, index + 1), image, ...attachments.slice(index + 1)]
}

/** Upload every document before allowing the caller to send or clear its draft. */
export async function remotePromptAttachments(
  attachments: PendingAttachment[],
  upload: (files: { name: string; mime: string; data: string }[]) => Promise<string[]>,
): Promise<PendingAttachment[]> {
  if (attachments.length > 10) throw new Error('At most 10 attachments per message.')
  const files = attachments.filter((a) => a.kind === 'file')
  if (files.some((a) => a.data === undefined)) throw new Error('Pick the attachment again.')
  if (!files.length) return attachments
  const paths = await upload(
    files.map((a) => ({ name: a.name, mime: a.mime ?? '', data: a.data ?? '' })),
  )
  if (paths.length !== files.length) throw new Error('Attachment upload not confirmed.')
  let index = 0
  return attachments.map((a) => (a.kind === 'file' ? { ...a, path: paths[index++] ?? '' } : a))
}
