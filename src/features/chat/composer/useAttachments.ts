import { useCallback, useRef, useState } from 'react'
import { toAttachment, type PendingAttachment } from '../attachments'

/**
 * Paste / drag-drop / pick plumbing shared by the chat composer and the home
 * composer.
 *
 * The list itself is CONTROLLED by the caller. Both composers used to own it as
 * local `useState`, which is exactly why a session switch threw pending images
 * away — the subtree unmounts. Keeping the value outside lets the drafts store
 * hold it instead (see `src/stores/drafts.ts`), without this hook caring which.
 */

/** Refuse a single image bigger than this; it would dwarf the draft store. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** Refuse a paste that would push the pending set past this. */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024

export interface AttachmentsApi {
  /** True while a file drag is over the drop zone. */
  dragging: boolean
  addFiles: (files: File[]) => void
  remove: (index: number) => void
  handlePaste: (event: React.ClipboardEvent) => void
  handleDragOver: (event: React.DragEvent) => void
  handleDragLeave: (event: React.DragEvent) => void
  handleDrop: (event: React.DragEvent) => void
}

/** Bytes a pending attachment costs us to keep. Paths cost nothing. */
export function attachmentBytes(attachment: PendingAttachment): number {
  // base64 is 4 chars per 3 bytes; the string itself is what we store.
  return attachment.kind === 'image' ? attachment.data.length : 0
}

export function totalAttachmentBytes(attachments: PendingAttachment[]): number {
  return attachments.reduce((sum, a) => sum + attachmentBytes(a), 0)
}

export function useAttachments({
  attachments,
  onChange,
  onReject,
}: {
  attachments: PendingAttachment[]
  onChange: (next: PendingAttachment[]) => void
  /** Told why a file was refused, so the composer can say so out loud. */
  onReject?: (message: string) => void
}): AttachmentsApi {
  const [dragging, setDragging] = useState(false)
  // The handlers are created fresh every render but a drop can add several
  // files at once; a ref keeps the appends from racing each other.
  const latest = useRef(attachments)
  latest.current = attachments

  const addFiles = useCallback(
    (files: File[]) => {
      for (const file of files) {
        void (async () => {
          if (file.size > MAX_IMAGE_BYTES) {
            onReject?.(`${file.name} is too large to attach (limit 10 MB).`)
            return
          }
          const attachment = await toAttachment(file, (f) => window.phosphor.pathForFile(f))
          if (!attachment) return
          const next = [...latest.current, attachment]
          if (totalAttachmentBytes(next) > MAX_ATTACHMENT_BYTES) {
            onReject?.('Too many images attached — send some before adding more.')
            return
          }
          latest.current = next
          onChange(next)
        })()
      }
    },
    [onChange, onReject],
  )

  const remove = useCallback(
    (index: number) => {
      const next = latest.current.filter((_, i) => i !== index)
      latest.current = next
      onChange(next)
    },
    [onChange],
  )

  const handlePaste = useCallback(
    (event: React.ClipboardEvent) => {
      const files = [...event.clipboardData.items]
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null)
      if (files.length === 0) return
      event.preventDefault()
      addFiles(files)
    },
    [addFiles],
  )

  /**
   * `dragover` must preventDefault or the element is never a valid drop
   * target: the drop then either never fires or Electron navigates the window
   * to the dropped file. This was the whole reason drag-and-drop appeared
   * broken even though the drop handler existed.
   */
  const handleDragOver = useCallback((event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDragging(true)
  }, [])

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    // Only clear when the pointer leaves the drop zone itself, not when it
    // crosses between children.
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setDragging(false)
  }, [])

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      const files = [...event.dataTransfer.files]
      setDragging(false)
      if (files.length === 0) return
      event.preventDefault()
      addFiles(files)
    },
    [addFiles],
  )

  return { dragging, addFiles, remove, handlePaste, handleDragOver, handleDragLeave, handleDrop }
}
