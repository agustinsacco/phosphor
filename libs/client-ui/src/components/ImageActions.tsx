import { canWriteBrowserImage } from '@phosphor/shared/browser-image-clipboard'
import { usePlatform } from '@/platform/Platform'
import { useMenuTriggers } from './ContextMenu'
import { TooltipButton } from './Tooltip'

interface ImageActions {
  onCopy: () => void
  onSave: () => void
}

/** Phone images use the shared long-press sheet, not a desktop-only copy hint. */
export function ImageButton({
  onCopy,
  onSave,
  annotate,
  ...props
}: ImageActions &
  React.ComponentProps<typeof TooltipButton> & { annotate: boolean }): React.JSX.Element {
  const platform = usePlatform()
  const compact = platform.formFactor === 'compact'
  const canCopy = platform.nativeImageClipboard || canWriteBrowserImage()
  const menu = useMenuTriggers(
    () => [
      ...(canCopy ? [{ label: 'Copy image', onClick: onCopy }] : []),
      { label: 'Save image', onClick: onSave },
    ],
    { title: 'Image', disabled: !compact },
  )
  return (
    <TooltipButton
      {...props}
      {...menu}
      onContextMenu={(event) => {
        if (compact) menu.onContextMenu(event)
        else {
          event.preventDefault()
          event.stopPropagation()
          onCopy()
        }
      }}
      tooltip={{
        label: annotate ? 'Annotate image' : 'Open image',
        description: compact ? undefined : 'Right-click to copy',
      }}
    />
  )
}

/** Browser-local copy/download; Desktop keeps its existing lightbox presentation. */
export function ImageLightboxActions({ onCopy, onSave }: ImageActions): React.JSX.Element | null {
  const platform = usePlatform()
  if (platform.nativeImageClipboard) return null
  return (
    <div className="absolute bottom-4 left-0 flex w-full justify-center gap-2 pb-[env(safe-area-inset-bottom)]">
      {canWriteBrowserImage() && (
        <TooltipButton
          onClick={onCopy}
          className="bg-surface-raised text-text rounded-lg px-4 py-3"
        >
          Copy image
        </TooltipButton>
      )}
      <TooltipButton onClick={onSave} className="bg-surface-raised text-text rounded-lg px-4 py-3">
        Save image
      </TooltipButton>
    </div>
  )
}
