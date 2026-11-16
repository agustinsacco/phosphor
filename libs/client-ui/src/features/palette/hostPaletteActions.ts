import type { HostConnectionView } from '@shared/ipc'
import { canAddHostFolder } from '@/features/machines/HostFolderBrowser'
import { openRemoteComposer } from '@/features/home/remoteComposer'
import { remoteLanePresentation, remoteLaneTitle } from '@/features/sessions/remoteLaneView'
import { machineLabel, openRemoteLane } from '@/stores/remoteLanes'
import type { Navigation } from '@/navigation/Navigation'
import type { PaletteAction } from './paletteStore'

/** Qualified identities keep same-named lanes and folders on different Hosts distinct. */
export function hostPaletteActions(
  hostId: string,
  host: HostConnectionView,
  addFolder: (hostId: string) => void,
  navigate?: Navigation['navigate'],
): PaletteAction[] {
  const machine = machineLabel(hostId)
  const lanes = host.lanes.map((lane) => ({
    id: `lane-${hostId}-${lane.laneId}`,
    label: `Open lane: ${remoteLaneTitle(null, lane.title)}`,
    ...(navigate && {
      hint: `${machine} · ${host.repositories.find((r) => r.id === lane.repositoryId)?.name ?? 'Unavailable folder'}`,
      needsYou: remoteLanePresentation(lane, host.state === 'ready').needsYou,
    }),
    run: () => {
      if (navigate) navigate({ to: 'lane', lane: { hostId, laneId: lane.laneId }, pane: 'chat' })
      else void openRemoteLane(hostId, lane.laneId)
    },
  }))
  const repositories = host.repositories.map((repository) => ({
    id: `new-lane-${hostId}-${repository.id}`,
    label: navigate
      ? `New lane on ${machine}/${repository.name}`
      : `New lane in ${repository.name}`,
    hint: navigate ? undefined : machine,
    run: () => {
      openRemoteComposer(hostId, repository.id)
      navigate?.({ to: 'new', machine: hostId })
    },
  }))
  const add = {
    id: `add-host-folder-${hostId}`,
    label: `Add folder on ${machine}…`,
    run: () => addFolder(hostId),
  }
  return [...lanes, ...repositories, ...(canAddHostFolder(host) ? [add] : [])]
}
