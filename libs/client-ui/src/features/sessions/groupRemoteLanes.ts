import type { HostConnectionView, HostLaneView } from '@shared/ipc'

export interface RemoteLaneGroup {
  repositoryId: string
  name: string
  available: boolean
  lanes: HostLaneView[]
}

/** Match Desktop's snapshot order: repositories first, stable lane order within each.
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
  return [...groups.values()]
}
