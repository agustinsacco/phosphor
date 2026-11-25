import { TooltipButton } from '@/components/Tooltip'
import { formatShortcut } from '@/lib/shortcuts'

const buttonClass =
  'text-text-secondary hover:bg-bg-secondary hover:text-text min-h-7 rounded-md px-2 text-base'

export function BusyPromptButtons({
  onSend,
}: {
  onSend: (behavior: 'steer' | 'followUp') => void
}): React.JSX.Element {
  return (
    <div
      className="flex flex-wrap justify-end gap-1 px-2.5 pb-1"
      role="group"
      aria-label="Send to running agent"
    >
      <TooltipButton
        type="button"
        onClick={() => onSend('steer')}
        title="Steer the current turn (Enter)"
        className={buttonClass}
      >
        Steer now
      </TooltipButton>
      <TooltipButton
        type="button"
        onClick={() => onSend('followUp')}
        title={`Queue after this turn (${formatShortcut('alt', 'Enter')})`}
        className={buttonClass}
      >
        Queue follow-up
      </TooltipButton>
    </div>
  )
}
