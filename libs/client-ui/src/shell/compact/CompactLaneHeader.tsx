import { useEffect, useId, useRef, useState } from 'react'
import clsx from 'clsx'
import { Button } from '@/components/form'
import { ModalOverlay } from '@/components/Modal'
import { TooltipButton } from '@/components/Tooltip'
import { ChevronDownIcon, ChevronIcon, PlusIcon, UserIcon } from '@/components/icons'
import { useLaneControl, type LaneControl } from '@/features/machines/useLaneControl'
import { useNavigation } from '@/navigation/Navigation'
import { SCREENS } from '@/navigation/screens'
import type { LanePane, Location } from '@/navigation/location'
import { useMachinesStore } from '@/stores/machines'
import { connectionLabel, machineLabel, useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'

type LaneLocation = Extract<Location, { to: 'lane' }>

/** The panes a phone can show for a remote lane, in the order the menu lists them. */
export const COMPACT_LANE_PANES = ['chat', 'files', 'changes', 'artifacts'] as const

/** The live session bound to a Host lane, once `openRemoteLane` has created it. */
export function useRemoteLaneSession(hostId: string, laneId: string) {
  return useSessionsStore((s) =>
    Object.values(s.live).find(
      (entry) =>
        entry.target?.kind === 'remote' &&
        entry.target.hostId === hostId &&
        entry.laneId === laneId,
    ),
  )
}

/**
 * A phone's lane header: Back, then the lane title as the one button that opens
 * the lane menu. Its second line names the Host and who controls the lane. The
 * menu switches panes and holds the lane actions, which used to be a tab strip
 * and a permanent control row stacked under a header with its own machine picker.
 */
export function CompactLaneHeader({ location }: { location: LaneLocation }): React.JSX.Element {
  const { navigate } = useNavigation()
  const hostId = 'hostId' in location.lane ? location.lane.hostId : ''
  const laneId = 'laneId' in location.lane ? location.lane.laneId : ''
  const pane = location.pane ?? 'chat'
  const title = useRemoteLanesStore(
    (s) => s.hosts[hostId]?.lanes.find((lane) => lane.laneId === laneId)?.title || 'Lane',
  )
  const session = useRemoteLaneSession(hostId, laneId)
  const control = useLaneControl(session?.phosphorId)
  const [open, setOpen] = useState(false)
  const statusId = useId()
  return (
    <header className="compact-header compact-lane-header">
      <Button aria-label="Back to lanes" onClick={() => navigate({ to: 'lanes', machine: hostId })}>
        <ChevronIcon size={18} strokeWidth={2} className="rotate-180" />
      </Button>
      <TooltipButton
        tooltip={false}
        className="compact-lane-title"
        aria-label={`Lane menu, ${title}`}
        aria-describedby={statusId}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span className="compact-lane-title-text">
          <span>{title}</span>
          <ChevronDownIcon size={13} />
        </span>
        <LaneStatus
          id={statusId}
          hostId={hostId}
          control={control}
          pane={pane === 'chat' ? undefined : SCREENS[pane].title}
        />
      </TooltipButton>
      {open && (
        <LaneSheet
          title={title}
          hostId={hostId}
          sessionId={session?.phosphorId}
          pane={pane}
          onPane={(next) => navigate({ ...location, pane: next })}
          onNewLane={() => navigate({ to: 'new', machine: hostId })}
          onClose={() => setOpen(false)}
        />
      )}
    </header>
  )
}

/** "● Host · Controlled by you · Files". The control state is its own node. */
function LaneStatus({
  id,
  hostId,
  control,
  pane,
}: {
  id?: string
  hostId: string
  control: LaneControl | null
  pane?: string
}): React.JSX.Element {
  useMachinesStore((s) => s.machines)
  const hostState = useRemoteLanesStore((s) => s.hosts[hostId]?.state)
  const ready = hostState === 'ready'
  return (
    <span id={id} className="compact-lane-status">
      <span
        aria-hidden
        className="compact-lane-dot"
        data-tone={!ready ? 'warning' : control?.controlling ? 'success' : 'idle'}
      />
      <span className="truncate">{machineLabel(hostId)}</span>
      <span aria-hidden>·</span>
      <span className="truncate">
        {ready && control ? control.status : connectionLabel(hostState)}
      </span>
      {pane && <span aria-hidden>·</span>}
      {pane && <span>{pane}</span>}
    </span>
  )
}

function LaneSheet({
  title,
  hostId,
  sessionId,
  pane,
  onPane,
  onNewLane,
  onClose,
}: {
  title: string
  hostId: string
  sessionId: string | undefined
  pane: LanePane
  onPane: (pane: LanePane) => void
  onNewLane: () => void
  onClose: () => void
}): React.JSX.Element {
  const control = useLaneControl(sessionId)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement
    ref.current?.querySelector<HTMLButtonElement>('[aria-current="page"]')?.focus()
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  return (
    <ModalOverlay onClose={onClose} backdrop="dim">
      <div ref={ref} role="dialog" aria-modal="true" aria-label="Lane menu" className="lane-sheet">
        <div className="lane-sheet-grab" aria-hidden />
        <div className="lane-sheet-head">
          <strong>{title}</strong>
          <LaneStatus hostId={hostId} control={control} />
        </div>
        <nav aria-label="Lane panes" className="lane-sheet-group">
          <p className="lane-sheet-label">View</p>
          {COMPACT_LANE_PANES.map((id) => {
            const Icon = SCREENS[id].icon
            return (
              <SheetItem
                key={id}
                icon={<Icon size={16} />}
                current={pane === id}
                onClick={() => {
                  onClose()
                  onPane(id)
                }}
              >
                {SCREENS[id].title}
              </SheetItem>
            )
          })}
        </nav>
        <LaneActions
          hostId={hostId}
          control={control}
          onClose={onClose}
          onNewLane={() => {
            onClose()
            onNewLane()
          }}
        />
      </div>
    </ModalOverlay>
  )
}

/** Control and lifecycle rows. A confirmed action closes the menu; a refusal stays to explain. */
function LaneActions({
  hostId,
  control,
  onClose,
  onNewLane,
}: {
  hostId: string
  control: LaneControl | null
  onClose: () => void
  onNewLane: () => void
}): React.JSX.Element {
  const run = (channel: Parameters<LaneControl['act']>[0]): void => {
    void control?.act(channel).then((ok) => {
      if (ok) onClose()
    })
  }
  return (
    <div role="group" aria-label="Lane actions" className="lane-sheet-group">
      <p className="lane-sheet-label">Lane</p>
      {control && !control.controlling && (
        <SheetItem
          icon={<UserIcon size={16} />}
          disabled={!control.enabled || control.busy}
          onClick={() => run('hosts:takeControl')}
        >
          Take control
        </SheetItem>
      )}
      {control?.controlling && (
        <SheetItem
          icon={<UserIcon size={16} />}
          disabled={control.busy}
          onClick={() => run('hosts:releaseControl')}
        >
          Release control
        </SheetItem>
      )}
      {control?.controlling && (
        <SheetItem
          icon={<span className="lane-sheet-stop" />}
          danger={!control.stopped}
          disabled={control.busy || control.stopBlocked !== null}
          hint={control.stopBlocked ?? undefined}
          onClick={() => run(control.stopped ? 'hosts:resumeLane' : 'hosts:stopLane')}
        >
          {control.stopped ? 'Resume lane' : 'Stop lane'}
        </SheetItem>
      )}
      <SheetItem icon={<PlusIcon size={16} />} onClick={onNewLane}>
        New lane on {machineLabel(hostId)}
      </SheetItem>
      {control?.error && (
        <p role="alert" className="lane-sheet-error">
          {control.error}
        </p>
      )}
    </div>
  )
}

function SheetItem({
  icon,
  current = false,
  danger = false,
  disabled = false,
  hint,
  onClick,
  children,
}: {
  icon: React.ReactNode
  current?: boolean
  danger?: boolean
  disabled?: boolean
  /** Why the row is disabled; shown under its label, where a phone can read it. */
  hint?: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <TooltipButton
      tooltip={false}
      className={clsx('lane-sheet-item', danger && 'lane-sheet-danger')}
      aria-current={current ? 'page' : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="lane-sheet-icon">{icon}</span>
      <span className="min-w-0">
        <span className="block truncate">{children}</span>
        {hint && <span className="lane-sheet-hint">{hint}</span>}
      </span>
    </TooltipButton>
  )
}
