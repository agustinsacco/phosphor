import { useMemo } from 'react'
import { TreeViewModal } from '@/features/sessions/TreeViewModal'
import { useNavigation } from '@/navigation/Navigation'
import type { HostLaneView } from '@shared/ipc'
import { useMachineCaps } from '@/stores/machineCaps'
import { copyHostLane, useLaneEditing, type HostEditLane } from './hostLaneEditing'

export function HostTreeDialog({
  hostId,
  laneId,
  title,
  onClose,
}: HostEditLane & { title: string; onClose: () => void }) {
  const target = useMemo(() => ({ hostId, laneId }), [hostId, laneId])
  return (
    <TreeViewModal
      meta={{ path: laneId, name: title }}
      hostLane={target}
      workspacePath=""
      onClose={onClose}
    />
  )
}

/** A missing handler omits the menu action on previous Hosts. No implicit control change. */
export function useEditingMenu(
  hostId: string,
  lane: HostLaneView,
  tree: () => void,
  act: (work: () => Promise<unknown>) => Promise<boolean>,
) {
  const editing = useLaneEditing(hostId)
  const caps = useMachineCaps(hostId)
  const { navigate } = useNavigation()
  const controller = lane.control.controller
  if (!editing) return {}
  return {
    tree: caps.granted('sessions.read') ? tree : undefined,
    clone:
      caps.granted('sessions.control') && (!controller?.connected || controller.self)
        ? () =>
            void act(async () =>
              navigate({
                to: 'lane',
                lane: await copyHostLane({ hostId, laneId: lane.laneId }, 'clone'),
              }),
            )
        : undefined,
  }
}
