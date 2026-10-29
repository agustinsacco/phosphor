import { useId, useState } from 'react'
import type { HostLaneView } from '@shared/ipc'
import { ActionSheet, ActionSheetItem } from '@/components/ActionSheet'
import type { ContextMenuItem } from '@/components/ContextMenu'
import { Button } from '@/components/form'
import { TooltipButton } from '@/components/Tooltip'
import { ChevronDownIcon, ChevronIcon, PlusIcon } from '@/components/icons'
import { currentSessionMenuItems, SESSION_OPTIONS } from '@/features/chat/sessionMenuItems'
import {
  useRemoteLaneActions,
  useRemoteLaneSession,
} from '@/features/sessions/useRemoteLaneActions'
import { promptText } from '@/stores/prompt'
import { useLaneControl, type LaneControl } from '@/features/machines/useLaneControl'
import { useNavigation } from '@/navigation/Navigation'
import { SCREENS } from '@/navigation/screens'
import type { LanePane, Location } from '@/navigation/location'
import { useChatStore } from '@/stores/chat'
import { useMachinesStore } from '@/stores/machines'
import { connectionLabel, machineLabel, useRemoteLanesStore } from '@/stores/remoteLanes'

type LaneLocation = Extract<Location, { to: 'lane' }>

/** The panes a phone can show for a remote lane, in the order the menu lists them. */
export const COMPACT_LANE_PANES = ['chat', 'files', 'changes', 'artifacts', 'terminal'] as const

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
  const lane = useRemoteLanesStore((s) =>
    s.hosts[hostId]?.lanes.find((item) => item.laneId === laneId),
  )
  const title = lane?.title || 'Lane'
  const session = useRemoteLaneSession(hostId, laneId)
  const control = useLaneControl(session?.phosphorId)
  const [open, setOpen] = useState(false)
  const statusId = useId()
  const sheet = (actions: ContextMenuItem[], error: string | null): React.JSX.Element => (
    <LaneSheet
      title={title}
      hostId={hostId}
      sessionId={session?.phosphorId}
      pane={pane}
      actions={actions}
      error={error}
      onPane={(next) => navigate({ ...location, pane: next })}
      onNewLane={() => navigate({ to: 'new', machine: hostId })}
      onClose={() => setOpen(false)}
    />
  )
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
      {lane ? (
        <HostLaneMenu hostId={hostId} lane={lane} open={open} onClose={() => setOpen(false)}>
          {({ items, error }) => sheet(items, error)}
        </HostLaneMenu>
      ) : (
        open && sheet([], null)
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

/** The lane's menu: the shared lane actions, presented as a phone sheet, and their dialogs. */
function HostLaneMenu({
  hostId,
  lane,
  open,
  onClose,
  children,
}: {
  hostId: string
  lane: HostLaneView
  open: boolean
  onClose: () => void
  children: (actions: { items: ContextMenuItem[]; error: string | null }) => React.ReactNode
}): React.JSX.Element {
  const ready = useRemoteLanesStore((s) => s.hosts[hostId]?.state === 'ready')
  const actions = useRemoteLaneActions({
    hostId,
    lane,
    ready,
    withOpen: false,
    onDone: onClose,
    onRename: () => {
      onClose()
      void promptText({
        title: 'Rename lane',
        initialValue: actions.title === 'Untitled lane' ? '' : actions.title,
        submitLabel: 'Rename',
      }).then((name) => (name ? actions.saveName(name) : false))
    },
  })
  return (
    <>
      {actions.dialogs}
      {open && children({ items: actions.items(), error: actions.error })}
    </>
  )
}

function LaneSheet({
  title,
  hostId,
  sessionId,
  pane,
  actions,
  error,
  onPane,
  onNewLane,
  onClose,
}: {
  title: string
  hostId: string
  sessionId: string | undefined
  pane: LanePane
  /** The shared lane actions; none while the Host has not listed the lane. */
  actions: ContextMenuItem[]
  error: string | null
  onPane: (pane: LanePane) => void
  onNewLane: () => void
  onClose: () => void
}): React.JSX.Element {
  const control = useLaneControl(sessionId)
  return (
    <ActionSheet
      label="Lane menu"
      head={
        <>
          <strong>{title}</strong>
          <LaneStatus hostId={hostId} control={control} />
        </>
      }
      onClose={onClose}
    >
      <nav aria-label="Lane panes" className="action-sheet-group">
        <p className="action-sheet-label">View</p>
        {COMPACT_LANE_PANES.map((id) => {
          const Icon = SCREENS[id].icon
          return (
            <ActionSheetItem
              key={id}
              icon={<Icon size={16} />}
              current={pane === id}
              onClick={() => {
                onClose()
                onPane(id)
              }}
            >
              {SCREENS[id].title}
            </ActionSheetItem>
          )
        })}
      </nav>
      {sessionId && <SessionOptionsGroup sessionId={sessionId} onClose={onClose} />}
      <LaneActionGroup
        hostId={hostId}
        actions={actions}
        error={error}
        onNewLane={() => {
          onClose()
          onNewLane()
        }}
      />
    </ActionSheet>
  )
}

/** The session options every surface offers (`sessionMenuItems`), as sheet rows. */
function SessionOptionsGroup({
  sessionId,
  onClose,
}: {
  sessionId: string
  onClose: () => void
}): React.JSX.Element {
  // Subscribed so the hints follow the session; the items read the stores themselves.
  useChatStore((s) => s.sessions[sessionId]?.meta)
  return (
    <div role="group" aria-label={SESSION_OPTIONS} className="action-sheet-group">
      <p className="action-sheet-label">Session</p>
      {currentSessionMenuItems(sessionId).map((item) => (
        <ActionSheetItem
          key={item.label}
          disabled={item.disabled}
          hint={item.hint}
          onClick={() => {
            onClose()
            item.onClick()
          }}
        >
          {item.label}
        </ActionSheetItem>
      ))}
    </div>
  )
}

/** The shared lane actions as sheet rows, then New lane on this Host. */
function LaneActionGroup({
  hostId,
  actions,
  error,
  onNewLane,
}: {
  hostId: string
  actions: ContextMenuItem[]
  error: string | null
  onNewLane: () => void
}): React.JSX.Element {
  return (
    <div role="group" aria-label="Lane actions" className="action-sheet-group">
      <p className="action-sheet-label">Lane</p>
      {actions.map((item) => (
        <ActionSheetItem
          key={item.label}
          danger={item.danger}
          disabled={item.disabled}
          hint={item.hint}
          onClick={item.onClick}
        >
          {item.label}
        </ActionSheetItem>
      ))}
      <ActionSheetItem icon={<PlusIcon size={16} />} onClick={onNewLane}>
        New lane on {machineLabel(hostId)}
      </ActionSheetItem>
      {error && (
        <p role="alert" className="action-sheet-error">
          {error}
        </p>
      )}
    </div>
  )
}
