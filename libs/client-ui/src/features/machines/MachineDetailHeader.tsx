import { useId, useEffect, useRef, useState, type RefObject } from 'react'
import { TooltipButton } from '@/components/Tooltip'
import { MoreIcon } from '@/components/icons'
import { PopupMenu, MenuRow } from '@/components/PopupMenu'
import { useMachinesStore } from '@/stores/machines'
import { MachineLabel } from './MachineLabel'
import type { MachineOverview } from './machineOverview'
import { StatusPill } from './MachineUi'

/** Identity first; maintenance is the same secondary menu at every viewport width. */
export function MachineDetailHeader({
  overview,
}: {
  overview: MachineOverview
}): React.JSX.Element {
  const { machine, headline } = overview
  return (
    <header className="machine-detail-header">
      <div className="machine-detail-identity">
        {machine ? (
          <MachineLabel
            machine={machine}
            heading="h2"
            onSaved={(updated) => {
              useMachinesStore.setState((current) => ({
                machines: current.machines.map((entry) =>
                  entry.id === updated.id ? updated : entry,
                ),
              }))
              void useMachinesStore.getState().refresh()
            }}
          />
        ) : (
          <h2 className="machine-name">{overview.label}</h2>
        )}
        <MachineHeaderActions overview={overview} />
      </div>
      <div className="machine-detail-metadata">
        <StatusPill tone={headline.tone} hint={headline.detail}>
          {headline.label}
        </StatusPill>
        <p>
          {overview.about}
          {overview.history && <span className="machine-detail-history">{overview.history}</span>}
        </p>
      </div>
    </header>
  )
}

/** Reconnect and Update Host… only where the machine has an address to use them on. */
function MachineHeaderActions({
  overview: { check, reconnect, update },
}: {
  overview: MachineOverview
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const popupId = useId()
  useActionFocus(open, popupId, trigger)
  const row = (label: string, run: () => void, disabled = false): React.JSX.Element => (
    <MenuRow
      active={false}
      disabled={disabled}
      onClick={() => {
        setOpen(false)
        run()
      }}
    >
      {label}
    </MenuRow>
  )
  return (
    <div className="relative ml-auto">
      <TooltipButton
        ref={trigger}
        aria-label="Machine actions"
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        className="machine-actions-trigger"
        onClick={() => setOpen(!open)}
      >
        <MoreIcon size={18} />
      </TooltipButton>
      {open && (
        <PopupMenu
          triggerRef={trigger}
          id={popupId}
          fitViewport
          escapeContainer
          onClose={() => setOpen(false)}
          className="absolute right-0 top-full mt-1 w-52 py-1"
        >
          {reconnect &&
            row(reconnect.busy ? 'Reconnecting…' : 'Reconnect', reconnect.run, reconnect.busy)}
          {row(check.busy ? 'Checking…' : 'Check again', check.run, check.busy)}
          {update && row('Update Host…', update)}
        </PopupMenu>
      )}
    </div>
  )
}

function useActionFocus(
  open: boolean,
  id: string,
  trigger: RefObject<HTMLButtonElement | null>,
): void {
  useEffect(() => {
    if (!open) return
    const button = trigger.current
    document.getElementById(id)?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    return () => {
      if (button?.isConnected) button.focus()
    }
  }, [open, id, trigger])
}
