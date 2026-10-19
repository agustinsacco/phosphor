import { useId, useEffect, useRef, useState, type RefObject } from 'react'
import type { MachineView } from '@shared/control-api'
import { TooltipButton } from '@/components/Tooltip'
import { MoreIcon } from '@/components/icons'
import { PopupMenu, MenuRow } from '@/components/PopupMenu'
import { useMachinesStore } from '@/stores/machines'
import { MachineLabel } from './MachineLabel'
import { StatusPill } from './MachineUi'
import { platformName, relativeTime } from './machinePresentation'
import type { machineHeadline } from './machineReachability'

/** Identity first; maintenance is the same secondary menu at every viewport width. */
export function MachineDetailHeader({
  machine,
  headline,
  version,
  now,
  checking,
  reconnecting,
  onCheck,
  onReconnect,
}: {
  machine: MachineView
  headline: ReturnType<typeof machineHeadline>
  version?: string | null
  now: number
  checking: boolean
  reconnecting: boolean
  onCheck: () => void
  onReconnect: () => void
}): React.JSX.Element {
  return (
    <header className="machine-detail-header">
      <div className="machine-detail-identity">
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
        <MachineHeaderActions
          endpoint={!!machine.endpoint}
          checking={checking}
          reconnecting={reconnecting}
          onCheck={onCheck}
          onReconnect={onReconnect}
        />
      </div>
      <div className="machine-detail-metadata">
        <StatusPill tone={headline.tone} hint={headline.detail}>
          {headline.label}
        </StatusPill>
        <p>
          {platformName(machine.platform)} {machine.arch}
          {version ? ` · Host ${version}` : ''}
          <span className="machine-detail-history">
            {machine.hostname !== machine.label ? ` · ${machine.hostname}` : ''}
            {machine.lastSeenAt
              ? ` · Last heartbeat ${relativeTime(machine.lastSeenAt, now)}`
              : ' · No heartbeat yet'}
          </span>
        </p>
      </div>
    </header>
  )
}

function MachineHeaderActions({
  endpoint,
  checking,
  reconnecting,
  onCheck,
  onReconnect,
}: {
  endpoint: boolean
  checking: boolean
  reconnecting: boolean
  onCheck: () => void
  onReconnect: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const popupId = useId()
  useActionFocus(open, popupId, trigger)
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
          {endpoint && (
            <MenuRow
              active={false}
              disabled={reconnecting}
              onClick={() => {
                setOpen(false)
                onReconnect()
              }}
            >
              {reconnecting ? 'Reconnecting…' : 'Reconnect'}
            </MenuRow>
          )}
          <MenuRow
            active={false}
            disabled={checking}
            onClick={() => {
              setOpen(false)
              onCheck()
            }}
          >
            {checking ? 'Checking…' : 'Check again'}
          </MenuRow>
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
