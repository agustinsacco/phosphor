import type { HostLaneView, HostsSnapshot } from '@shared/ipc'
import { createMockArchive } from './mockArchive'

const inventories = new Map<string, ReturnType<typeof createMockArchive<HostLaneView>>>()
export function mockHostArchive(
  channel: string,
  args: unknown[],
  hosts: HostsSnapshot,
  changed: () => void,
): unknown {
  const hostId = String(args[0])
  const host = hosts[hostId]
  if (!host) throw new Error('Host unavailable.')
  let archive = inventories.get(hostId)
  if (!archive) {
    archive = createMockArchive<HostLaneView>((lane) => ({
      title: lane.title || 'Untitled lane',
      cwd: lane.cwd,
      worktree: lane.worktree,
    }))
    inventories.set(hostId, archive)
  }
  if (channel === 'hosts:archives') return archive.list()
  if (channel === 'hosts:archiveLane') {
    const lane = host.lanes.find((entry) => entry.laneId === args[1])
    if (!lane) throw new Error('Lane unavailable.')
    archive.add(lane)
    host.lanes = host.lanes.filter((entry) => entry !== lane)
  } else {
    const lane = archive.remove(args[1])
    if (channel === 'hosts:restoreArchive')
      host.lanes.push({
        ...lane,
        activity: 'stopped',
        control: { controller: null, fence: lane.control.fence + 1 },
      })
  }
  changed()
  return undefined
}
