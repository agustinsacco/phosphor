import { usePlatform } from '@/platform/Platform'
import { TooltipButton } from '@/components/Tooltip'
import { useState } from 'react'
import { ChatImage } from '../ChatImage'
import { formatFileSize, type PendingAttachment, type PendingImage } from '../attachments'
import { ImageEditor } from '../imageEditor/ImageEditor'

/**
 * The pending-attachment chip row, shared by both composers.
 *
 * Images render as the same copyable `ChatImage` the transcript uses, but a
 * click opens the annotator rather than the lightbox: a pending image is still
 * editable. Everything else is a path chip, because pi's protocol has no
 * document type.
 */
export function AttachmentChips({
  attachments,
  onRemove,
  onEdit,
}: {
  attachments: PendingAttachment[]
  onRemove: (index: number) => void
  onEdit: (index: number, image: PendingImage, replace: boolean) => boolean
}): React.JSX.Element | null {
  const platform = usePlatform()
  const [editing, setEditing] = useState<number | null>(null)
  if (attachments.length === 0) return null
  const edited = editing === null ? undefined : attachments[editing]
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-3" data-testid="attachment-chips">
      {attachments.map((attachment, index) => (
        <div key={index} className="group/img relative">
          {attachment.kind === 'image' ? (
            <ChatImage
              image={{ type: 'image', data: attachment.data, mimeType: attachment.mimeType }}
              className="border-border h-16 w-16 rounded-lg border object-cover"
              onOpen={platform.fileEditing ? () => setEditing(index) : undefined}
            />
          ) : (
            <div
              data-tooltip={attachment.path}
              className="border-border bg-bg-secondary flex h-16 max-w-48 flex-col justify-center gap-0.5 rounded-lg border px-2.5"
            >
              <span className="text-text truncate text-sm font-medium">{attachment.name}</span>
              <span className="text-text-tertiary font-mono text-xs">
                {formatFileSize(attachment.size)} · sent as path
              </span>
            </div>
          )}
          <TooltipButton
            onClick={() => onRemove(index)}
            aria-label={`Remove ${attachment.name}`}
            className="bg-text text-bg absolute -right-1.5 -top-1.5 hidden h-4.5 w-4.5 items-center justify-center rounded-full text-xs group-hover/img:flex"
          >
            ✕
          </TooltipButton>
        </div>
      ))}
      {editing !== null && edited?.kind === 'image' && (
        <ImageEditor
          image={edited}
          onCancel={() => setEditing(null)}
          onSave={(image, replace) => {
            const accepted = onEdit(editing, image, replace)
            if (accepted) setEditing(null)
            return accepted
          }}
        />
      )}
    </div>
  )
}

/** Overlay shown while a file drag is over a composer. */
export function DropOverlay({ visible }: { visible: boolean }): React.JSX.Element | null {
  if (!visible) return null
  return (
    <div className="bg-surface/85 pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl">
      <span className="text-text text-base font-medium">
        Drop to attach — images inline, other files by path
      </span>
    </div>
  )
}
