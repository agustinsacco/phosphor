import type { HostConnectionView, HostLaneView } from '@shared/ipc'
import { ipcErrorText } from '@shared/errors'
import { remoteLaneResourceKey } from '@shared/remote-host'
import { refreshHostsSnapshot } from '@/stores/hostsSnapshotRead'
import type { SessionHostLane } from '@/stores/hostLaneOf'

// RPC is used by the session stores themselves. Read their projections at action time,
// without importing the stores (and their initialization cycle) into the RPC layer.
let views:
  | {
      host(id: string): HostConnectionView | undefined
      session(id: string): SessionHostLane | null
    }
  | undefined
export function bindServiceLaneViews(read: NonNullable<typeof views>) {
  views = read
}

/** An absent lane is not an unheld lane. Even a disconnected controller needs an explicit Take. */
export function laneControlPolicy(local: boolean | undefined, lane: HostLaneView | undefined) {
  const controller = lane?.control.controller
  const auto = local === true && controller === null
  return {
    auto,
    actionable: auto || controller?.self === true,
    transfer: !local || controller?.self === false,
  }
}

export class ServiceLaneControlRefused extends Error {}
const claims = new Map<string, Promise<void>>()

/** Only claim to run an operation. The Host atomically arbitrates a stale view or competing claim. */
export async function ensureServiceLaneControl(hostId: string, laneId: string): Promise<void> {
  const host = views?.host(hostId)
  if (!host?.local && !host?.warmOnOpen) return
  const lane = host.lanes.find((l) => l.laneId === laneId)
  const policy = laneControlPolicy(true, lane)
  if (
    host.state !== 'ready' ||
    !host.capabilities.includes('sessions.control') ||
    !policy.actionable
  )
    throw new ServiceLaneControlRefused(
      lane?.control.controller
        ? `Controlled by ${lane.control.controller.label}. Take control first.`
        : 'Lane control unavailable.',
    )
  if (!policy.auto) return
  const key = remoteLaneResourceKey(hostId, laneId)
  let claim = claims.get(key)
  if (!claim) {
    claim = window.phosphor
      .invoke('hosts:takeControl', hostId, laneId, { ifUnheld: true })
      .then(refreshHostsSnapshot)
      .catch((error: unknown) => {
        throw new ServiceLaneControlRefused(ipcErrorText(error))
      })
      .finally(() => claims.delete(key))
    claims.set(key, claim)
  }
  await claim
}

const warming = new Map<string, Promise<void>>()

/** Navigation never waits for pi. A send during boot joins this attempt before prompting. */
export function warmOpenedLane(
  sessionId: string,
  current: () => boolean,
  report: (error: string) => void,
) {
  const remote = views?.session(sessionId)
  if (
    !remote?.host?.warmOnOpen ||
    remote.host.state !== 'ready' ||
    !remote.host.capabilities.includes('sessions.control') ||
    remote.lane?.activity !== 'stopped' ||
    remote.lane.pause ||
    !laneControlPolicy(true, remote.lane).actionable ||
    warming.has(sessionId)
  )
    return
  const { hostId, lane } = remote
  const start = async () => {
    if (!lane.control.controller) await ensureServiceLaneControl(hostId, lane.laneId)
    const now = views?.session(sessionId)
    if (
      current() &&
      now?.host?.warmOnOpen &&
      now.host.connectionToken === remote.host?.connectionToken &&
      now.lane?.activity === 'stopped' &&
      !now.lane.pause &&
      now.lane.control.controller?.self
    )
      await window.phosphor.invoke('hosts:resumeLane', hostId, lane.laneId)
  }
  warming.set(
    sessionId,
    start()
      .catch((error: unknown) => report(ipcErrorText(error)))
      .finally(() => warming.delete(sessionId)),
  )
}

export function ensureSessionControl(sessionId: string): Promise<void> | undefined {
  const starting = warming.get(sessionId)
  if (starting) return starting.then(() => ensureSessionControl(sessionId))
  const remote = views?.session(sessionId)
  if (remote?.host?.local && remote.laneId)
    return ensureServiceLaneControl(remote.hostId, remote.laneId)
}

type ActionChannel =
  | 'hosts:stopLane'
  | 'hosts:resumeLane'
  | 'hosts:takeControl'
  | 'hosts:releaseControl'
  | 'hosts:markRead'
export async function runLaneAction(channel: ActionChannel, hostId: string, laneId: string) {
  if (channel === 'hosts:stopLane' || channel === 'hosts:resumeLane')
    await ensureServiceLaneControl(hostId, laneId)
  await window.phosphor.invoke(channel, hostId, laneId)
}
