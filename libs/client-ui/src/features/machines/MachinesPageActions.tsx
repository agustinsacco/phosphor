import { Button } from '@/components/form'
import { TerminalIcon } from '@/components/icons'
import { TooltipButton, tooltipProps } from '@/components/Tooltip'
import { usePlatform } from '@/platform/Platform'
import { HealthBadge } from './HealthBadge'

export function MachinesPageActions({
  signedIn,
  onAdd,
  logOpen,
  onToggleLog,
  onOpenLog,
}: {
  signedIn: boolean
  onAdd: () => void
  logOpen: boolean
  onToggleLog: () => void
  onOpenLog: () => void
}): React.JSX.Element {
  const { localLanes } = usePlatform()
  return (
    <>
      <span {...tooltipProps(signedIn ? undefined : 'Sign in with GitHub to add machines')}>
        <Button size="sm" variant="primary" disabled={!signedIn} onClick={onAdd}>
          Add a machine
        </Button>
      </span>
      {localLanes && <HealthBadge signedIn={signedIn} onOpenLog={onOpenLog} />}
      <TooltipButton
        tooltip={logOpen ? 'Hide debug log' : 'Show debug log'}
        aria-label="Debug log"
        aria-pressed={logOpen}
        onClick={onToggleLog}
        className={`hover:bg-bg-secondary flex h-8 w-8 items-center justify-center rounded-sm transition-colors ${logOpen ? 'text-accent' : 'text-text-secondary hover:text-text'}`}
      >
        <TerminalIcon size={14} />
      </TooltipButton>
    </>
  )
}
