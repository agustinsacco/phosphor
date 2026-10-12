import { TooltipButton } from '@/components/Tooltip'
import { useState } from 'react'
import clsx from 'clsx'
import { CheckIcon } from '@/components/icons'

export function CopyButton({
  text,
  label,
  size = 'md',
  title = 'Copy',
  className,
}: {
  text: string
  label?: string
  /**
   * 'sm' matches the compact hover-popover rows (message meta rows).
   * 'icon' is a square hit target for a lone, label-less button — the message
   * hover affordance, which has to be small enough to sit in the transcript's
   * side gutter rather than on top of the prose.
   */
  size?: 'sm' | 'md' | 'icon'
  /** Overrides the tooltip, e.g. to carry a timestamp with no visible chrome. */
  title?: string
  className?: string
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  const copy = (): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    })
  }

  const iconSize = size === 'md' ? 13 : 11

  return (
    <TooltipButton
      onClick={copy}
      title={title}
      className={clsx(
        'text-text-tertiary hover:text-text flex items-center gap-1 transition-colors',
        size === 'sm' && 'h-4 text-sm',
        size === 'md' && 'hover:bg-bg-secondary h-6 rounded-md px-1.5 text-sm',
        size === 'icon' && 'hover:bg-bg-secondary hover:text-text h-5 w-5 justify-center rounded',
        className,
      )}
    >
      {copied ? <CheckIcon size={iconSize} /> : <CopyIcon size={iconSize} />}
      {label && <span>{copied ? 'Copied' : label}</span>}
    </TooltipButton>
  )
}

function CopyIcon({ size = 13 }: { size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  )
}
