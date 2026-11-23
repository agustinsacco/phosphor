import type { HostReleaseFeature } from '@phosphor/shared/host-release'
import type {
  LocalStatus,
  OwnerLockStatus,
  ServicePauseState,
} from '@phosphor/shared/host-protocol-owner'
import type { OwnerLockRecord } from '@phosphor/session-runtime/owner-lock/types'
import type { ControlLinkState } from '../control/link'
import type { LocalDaemon } from '../commands/run-local'
import type { SocketPrincipal } from './adapter'

export interface LocalStatusPorts {
  /** The socket's identity from `local-identity.json`. */
  machineId: string
  hostVersion: string
  daemon: Pick<LocalDaemon, 'standby' | 'link'>
  appServices?(): NonNullable<LocalStatus['appServices']>
  features(): readonly HostReleaseFeature[]
  /** The machine's owner lock record, or null when nobody holds it. */
  ownerLock(): Promise<Pick<OwnerLockRecord, 'owner' | 'pid'> | null>
  /** The service pause while lanes run. Absent: the field stays out. */
  pause?(): ServicePauseState
  /** The last update's outcome from `update-result.json`. Absent: the field stays out. */
  lastUpdate?(): LocalStatus['lastUpdate']
}

function enrollment(
  state: ControlLinkState | undefined,
): Pick<LocalStatus, 'enrolled' | 'enrolling'> {
  if (state?.kind === 'enrolled')
    return {
      enrolled: { hostId: state.hostId, label: state.label, ownerLogin: state.ownerLogin },
    }
  if (state?.kind === 'enrolling') return { enrolled: null, enrolling: state.offer }
  return { enrolled: null }
}

/**
 * `machine.local`. A `local` principal reads the machine id, version and mode
 * only; the owner also reads enrollment, the owner lock and the features.
 * In standby and during start-up there is no control link yet, so the mode
 * reads `local`.
 */
export async function localStatus(
  ports: LocalStatusPorts,
  principal: SocketPrincipal,
): Promise<LocalStatus> {
  const link = ports.daemon.link()
  const base: LocalStatus = {
    machineId: ports.machineId,
    hostVersion: ports.hostVersion,
    mode: link?.mode() ?? 'local',
  }
  if (principal.kind !== 'owner') return base
  const lock = await ports.ownerLock()
  const ownerLock: OwnerLockStatus = {
    held: lock !== null,
    holder: lock?.owner ?? null,
    pid: lock?.pid ?? null,
    standby: ports.daemon.standby(),
  }
  return {
    ...base,
    ...(ports.appServices ? { appServices: ports.appServices() } : {}),
    features: ports.features(),
    ...enrollment(link?.state()),
    ownerLock,
    ...(ports.pause ? { pause: ports.pause() } : {}),
    ...(ports.lastUpdate ? { lastUpdate: ports.lastUpdate() } : {}),
  }
}
