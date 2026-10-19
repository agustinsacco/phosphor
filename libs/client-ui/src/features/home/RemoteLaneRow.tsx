import { SidebarToggleIcon, ChevronIcon } from '@/components/icons'
import { TooltipButton } from '@/components/Tooltip'
import type { HostLaneView } from '@shared/ipc'

/** Shared compact lane presentation for the Host home and browser lane index. */
export function RemoteLaneRow({
  lane,
  onOpen,
}: {
  lane: HostLaneView
  onOpen: () => void
}): React.JSX.Element {
  return (
    <TooltipButton
      className="remote-lane-row"
      onClick={onOpen}
      aria-label={lane.title || 'Untitled lane'}
    >
      <SidebarToggleIcon size={15} />
      <span className="remote-lane-copy">
        <strong>{lane.title || 'Untitled lane'}</strong>
        <span>
          {lane.activity}
          {lane.attention > lane.read ? ' · Needs attention' : ''}
          {lane.branch ? ` · ${lane.branch}` : ''}
        </span>
      </span>
      <ChevronIcon size={13} />
    </TooltipButton>
  )
}
