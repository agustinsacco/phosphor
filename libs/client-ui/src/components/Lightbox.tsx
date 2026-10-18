import { TooltipButton } from '@/components/Tooltip'
import { ModalOverlay } from '@/components/Modal'
import { CloseIcon } from '@/components/icons'

/** Full-screen image viewer: click anywhere or press Escape to dismiss. */
export function Lightbox({
  children,
  onClose,
}: {
  children: React.ReactNode
  onClose: () => void
}): React.JSX.Element {
  return (
    <ModalOverlay onClose={onClose} backdrop="photo">
      <div>{children}</div>
      <TooltipButton
        onClick={onClose}
        className="absolute right-4 top-4 flex h-9 w-9 items-center justify-center rounded-full bg-black/50 text-white transition-colors hover:bg-black/70"
        aria-label="Close"
      >
        <CloseIcon size={16} />
      </TooltipButton>
    </ModalOverlay>
  )
}
