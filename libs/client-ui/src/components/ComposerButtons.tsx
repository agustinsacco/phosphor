import { TooltipButton } from '@/components/Tooltip'
import { PlusIcon } from './icons'

/**
 * Quiet icon controls shared by the chat composer and the home composer.
 *
 * The reference composer never shows a filled "Send" pill: attachments live
 * behind a "+" on the left, and submit is a small ⏎ glyph on the far right
 * that only reads as active once there is something to send.
 */

/** Also the image annotator's toolbar buttons, so the two read as one family. */
export const iconButtonClass =
  'text-text-secondary hover:text-text hover:bg-bg-secondary flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-30'

export function AttachButton({ onFiles }: { onFiles: (files: File[]) => void }): React.JSX.Element {
  const pick = (): void => {
    const input = document.createElement('input')
    input.type = 'file'
    // Any file: images inline, everything else is attached by path.
    input.multiple = true
    input.onchange = () => {
      onFiles([...(input.files ?? [])])
    }
    input.click()
  }

  return (
    <TooltipButton
      onClick={pick}
      aria-label="Attach files"
      tooltip="Attach files"
      className={iconButtonClass}
    >
      <PlusIcon size={16} />
    </TooltipButton>
  )
}

export function SubmitIconButton({
  busy,
  disabled,
  onClick,
  label,
}: {
  busy?: boolean
  disabled: boolean
  onClick: () => void
  label: string
}): React.JSX.Element {
  return (
    <TooltipButton
      onClick={onClick}
      disabled={disabled || busy}
      aria-label={label}
      tooltip={{ label, shortcut: ['Enter'] }}
      className={iconButtonClass}
    >
      {busy ? (
        <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="3"
          />
          <path
            className="opacity-90"
            fill="currentColor"
            d="M12 2a10 10 0 0 1 10 10h-3a7 7 0 0 0-7-7V2z"
          />
        </svg>
      ) : (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M9 10 4 15l5 5" />
          <path d="M20 4v7a4 4 0 0 1-4 4H4" />
        </svg>
      )}
    </TooltipButton>
  )
}

/** Stop control while streaming. Esc does the same; this is the visible way. */
export function StopIconButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <TooltipButton
      onClick={onClick}
      aria-label="Stop"
      tooltip={{ label: 'Stop response', shortcut: ['Esc'] }}
      className="border-border text-text-secondary hover:border-danger hover:text-danger flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors"
    >
      <span className="h-2.5 w-2.5 rounded-[3px] bg-current" />
    </TooltipButton>
  )
}
