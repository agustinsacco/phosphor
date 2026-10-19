import type { HostLaneView } from '@shared/ipc'
import {
  RemoteLanePresentation,
  useRemoteLaneTitle,
} from '@/features/sessions/RemoteLanePresentation'

/** Navigation-only use of the Desktop lane surface, without native curation or takeover. */
export function RemoteLaneRow({
  lane,
  onOpen,
  hostId,
  ready = true,
  active = false,
  disabled = false,
}: {
  lane: HostLaneView
  onOpen: () => void
  hostId?: string
  ready?: boolean
  active?: boolean
  disabled?: boolean
}): React.JSX.Element {
  const title = useRemoteLaneTitle(lane, hostId)
  return (
    <RemoteLanePresentation
      lane={lane}
      title={title}
      ready={ready && !disabled}
      active={active}
      onClick={() => {
        if (ready && !disabled) onOpen()
      }}
    />
  )
}
