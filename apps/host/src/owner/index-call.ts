import { basename } from 'node:path'
import {
  OWNER_LIMITS,
  type OwnerCalls,
  type OwnerIndex,
  type OwnerLaneRow,
} from '@phosphor/shared/host-protocol-owner'
import { isTranscriptName } from '@phosphor/shared/host-protocol-lane-transfer'
import type { OwnerLockRecord } from '@phosphor/session-runtime/owner-lock/types'
import type { LocalDaemon } from '../commands/run-local'
import type { HostStore, StoredLane } from '../lanes/store'

export interface OwnerIndexPorts {
  machineId: string
  agentDir: string
  sessionsRoot: string
  daemon: Pick<LocalDaemon, 'standby' | 'link'>
  store: Pick<HostStore, 'listLanes'>
  /** The machine's owner lock record, or null when nobody holds it. */
  ownerLock(): Promise<Pick<OwnerLockRecord, 'owner' | 'pid'> | null>
  pid: number
}

/** pi's `<ts>_<uuid>.jsonl` names the session; any other name gives null, never a guess. */
function sessionIdOf(sessionFile: string | null): string | null {
  if (sessionFile === null) return null
  const name = basename(sessionFile)
  return isTranscriptName(name) ? name.slice(name.lastIndexOf('_') + 1, -'.jsonl'.length) : null
}

const rowOf = (lane: StoredLane): OwnerLaneRow => ({
  laneId: lane.laneId,
  sessionFile: lane.sessionFile,
  sessionId: sessionIdOf(lane.sessionFile),
  cwd: lane.cwd,
  repositoryId: lane.repositoryId,
})

/**
 * `owner.index`: the machine's lanes as Desktop's remaining machine work
 * reads them, in `laneId` order, `indexLanesPerPage` at a time. `next` is
 * the page's last `laneId`, so a lane added or removed between pages never
 * shifts another. `owning` is true only once this daemon holds the owner lock.
 */
export async function ownerIndex(
  ports: OwnerIndexPorts,
  params: OwnerCalls['owner.index']['params'],
): Promise<OwnerIndex> {
  const after = params.after
  const lanes = ports.store
    .listLanes()
    .filter((lane) => after === undefined || lane.laneId > after)
    .sort((a, b) => (a.laneId < b.laneId ? -1 : a.laneId > b.laneId ? 1 : 0))
  const page = lanes.slice(0, OWNER_LIMITS.indexLanesPerPage)
  const lock = ports.daemon.standby() ? null : await ports.ownerLock()
  const state = ports.daemon.link()?.state()
  const last = page.at(-1)
  return {
    machineId: ports.machineId,
    ...(state?.kind === 'enrolled' ? { enrolledHostId: state.hostId } : {}),
    agentDir: ports.agentDir,
    sessionsRoot: ports.sessionsRoot,
    owning: lock?.owner === 'daemon' && lock.pid === ports.pid,
    migrateLevel: 1,
    lanes: page.map(rowOf),
    ...(last && lanes.length > page.length ? { next: last.laneId } : {}),
  }
}
