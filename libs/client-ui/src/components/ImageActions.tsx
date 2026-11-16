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

/** Reserve room for browser actions without changing Desktop's image-only layout. */
export function ImageLightboxFrame({
  children,
  onCopy,
  onSave,
}: ImageActions & { children: React.ReactNode }): React.JSX.Element {
  if (usePlatform().nativeImageClipboard) return <>{children}</>
  return (
    <div className="flex h-[92dvh] w-[92vw] flex-col items-center gap-3 pb-[env(safe-area-inset-bottom)] [&>img]:min-h-0 [&>img]:flex-1">
      {children}
      <ImageLightboxActions onCopy={onCopy} onSave={onSave} />
    </div>
  )
}

/** Browser-local copy/download; Desktop keeps its existing lightbox presentation. */
export function ImageLightboxActions({ onCopy, onSave }: ImageActions): React.JSX.Element | null {
  const platform = usePlatform()
  if (platform.nativeImageClipboard) return null
  return (
    <div role="group" aria-label="Image actions" className="flex shrink-0 justify-center gap-2">
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
