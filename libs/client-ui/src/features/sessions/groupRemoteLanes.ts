import { orderedSessions } from './sessionOrder'
import type { HostConnectionView, HostLaneView } from '@shared/ipc'
import { remoteLaneKey } from '@shared/remote-host'

export interface RemoteLaneGroup {
  repositoryId: string
  name: string
  available: boolean
  lanes: HostLaneView[]
}

/** A Host lane's entry in the sidebar's device-local `sessionOrder`: its lane key. */
export const remoteLaneOrderKey = remoteLaneKey

/** Host lanes in the order this device's user arranged them, newest unarranged ones first. */
export function orderedRemoteLanes(
  hostId: string,
  lanes: HostLaneView[],
  order: string[],
): HostLaneView[] {
  return orderedSessions(
    lanes.map((lane) => ({ lane, path: remoteLaneOrderKey(hostId, lane.laneId) })),
    order,
  ).map(({ lane }) => lane)
}

/** Newest first, like Desktop's sessions; an unreadable timestamp sinks, ties keep snapshot order. */
export function compareLanesByCreation(a: HostLaneView, b: HostLaneView): number {
  const time = (lane: HostLaneView): number => {
    const parsed = Date.parse(lane.createdAt)
    return Number.isFinite(parsed) ? parsed : -Infinity
  }
  const [ta, tb] = [time(a), time(b)]
  return ta === tb ? 0 : tb > ta ? 1 : -1
}

/** Match Desktop's sidebar: repositories in snapshot order, lanes newest first within each.
 * The Host lists lanes oldest first, and a new lane arrives as a delta at the end, so
 * without the sort a lane you just created lands at the bottom of its group.
 * A lane can outlive an active repository; preserve it without inventing a folder name.
 */
export function groupRemoteLanes(
  repositories: HostConnectionView['repositories'],
  lanes: HostLaneView[],
): RemoteLaneGroup[] {
  const groups = new Map<string, RemoteLaneGroup>(
    repositories.map((repo) => [
      repo.id,
      { repositoryId: repo.id, name: repo.name, available: true, lanes: [] },
    ]),
  )
  for (const lane of lanes) {
    let group = groups.get(lane.repositoryId)
    if (!group) {
      group = {
        repositoryId: lane.repositoryId,
        name: `Unavailable folder (${lane.repositoryId})`,
        available: false,
        lanes: [],
      }
      groups.set(lane.repositoryId, group)
    }
    group.lanes.push(lane)
  }
  for (const group of groups.values()) group.lanes.sort(compareLanesByCreation)
  return [...groups.values()]
}
