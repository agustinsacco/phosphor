import type { LaneMarksChange } from '@shared/host-protocol-lane-marks'
import { HOST_TOO_OLD } from '@shared/host-protocol-repositories'
import type { HostConnectionView, HostsSnapshot } from '@shared/ipc'
import { hostResourceKey } from '@shared/remote-host'
import { useExtensionUiStore } from './extensionUi'
import { useSessionsStore } from './sessions'

/**
 * Pin or mark a Host lane on its Host, so every client shows the same pin and marker.
 * `marker: null` forgets the choice (the lane goes back to its auto marker); `''` is "none".
 * Nothing changes locally: the Host republishes the lane's summary once it has applied it.
 */
export async function setRemoteLaneMarks(
  hostId: string,
  laneId: string,
  marks: LaneMarksChange,
): Promise<boolean> {
  try {
    await window.phosphor.invoke('hosts:setLaneMarks', hostId, laneId, marks)
    return true
  } catch (error) {
    useExtensionUiStore
      .getState()
      .pushToast(
        error instanceof Error && error.message.includes(HOST_TOO_OLD)
          ? `Pins and lane markers need a newer Host. ${HOST_TOO_OLD}`
          : 'The Host could not save this pin or marker. Try again.',
        'error',
      )
    return false
  }
}

/** Hosts whose legacy Desktop marks were already moved, or are moving, in this app run. */
const migrated = new Set<string>()

/**
 * Desktop once kept Host lanes' pins and markers in its own prefs, under each lane's
 * hostResourceKey. When a Host that keeps marks is ready, move each legacy entry of a
 * lane the Host lists with no marks yet, then drop the local entry through the sessions
 * store's own setters so the removal persists. A lane the Host already marked keeps the
 * Host's marks. Once per Host per app run; the browser never has legacy entries.
 */
export function migrateLegacyLaneMarks(hosts: HostsSnapshot): void {
  for (const [hostId, host] of Object.entries(hosts)) {
    if (
      migrated.has(hostId) ||
      host.state !== 'ready' ||
      host.laneMarks !== true ||
      !host.capabilities.includes('sessions.control')
    )
      continue
    migrated.add(hostId)
    void migrateHost(hostId, host).catch(() => migrated.delete(hostId))
  }
}

async function migrateHost(hostId: string, host: HostConnectionView): Promise<void> {
  // The prefs read may still be in flight at startup; a setter must never persist an empty list.
  await useSessionsStore.getState().hydratePinned()
  for (const lane of host.lanes) {
    const key = hostResourceKey({ kind: 'remote', hostId }, 'session', lane.laneId)
    const { pinned, laneMarkers } = useSessionsStore.getState()
    const legacy: LaneMarksChange = {
      ...(pinned.includes(key) ? { pinned: true } : {}),
      ...(laneMarkers[key] === undefined ? {} : { marker: laneMarkers[key] }),
    }
    if (legacy.pinned === undefined && legacy.marker === undefined) continue
    if (lane.pinned !== true && lane.marker === undefined) {
      try {
        await window.phosphor.invoke('hosts:setLaneMarks', hostId, lane.laneId, legacy)
      } catch {
        continue // Kept locally; the next app run tries again.
      }
    }
    const current = useSessionsStore.getState()
    if (current.pinned.includes(key)) current.togglePin(key)
    if (current.laneMarkers[key] !== undefined) current.setLaneMarker(key, null)
  }
}
