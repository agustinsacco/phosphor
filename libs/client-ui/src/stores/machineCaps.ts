import { useMemo } from 'react'
import type { HostConnectionView } from '@shared/ipc'
import type { HostCapability } from '@shared/remote-host'
import { featureNotOffered, REMOTE_NOT_READY, type GrantedCapability } from './hostRefusals'
import { useRemoteLanesStore } from './remoteLanes'

type HostCapsSource = Pick<
  HostConnectionView,
  'state' | 'capabilities' | 'laneMarks' | 'machineShell'
>

/**
 * What a machine lets this device see and use, for showing, hiding, disabling and explaining
 * controls. Display gating only: the Host checks every grant on every request, so this is never
 * authorization and a check here never stands in for the Host's own.
 */
export interface MachineCaps {
  ready: boolean
  /** Granted regardless of connection: lists, counts and last-known views. */
  granted(cap: HostCapability): boolean
  /** Ready and every cap granted: usable now. */
  can(...caps: HostCapability[]): boolean
  /** `REMOTE_NOT_READY`, else the first missing grant in `featureNotOffered` words; undefined when allowed. */
  refusal(...caps: GrantedCapability[]): string | undefined
  /** `refusal` for one grant, naming `feature` where the reader shows less than the grant (models, under skills). */
  refusalAs(cap: GrantedCapability, feature: string): string | undefined
  /** Keeps lane pins and markers. */
  laneMarks: boolean
  /** Offers a machine shell. */
  machineShell: boolean
}

/** A Host's caps from its view; an unknown Host is not ready and grants nothing. */
export function machineCaps(host: HostCapsSource | undefined): MachineCaps {
  const ready = host?.state === 'ready'
  const granted = (cap: HostCapability): boolean => !!host?.capabilities.includes(cap)
  const refusalAs = (cap: GrantedCapability, feature?: string): string | undefined =>
    !ready ? REMOTE_NOT_READY : granted(cap) ? undefined : featureNotOffered(cap, feature)
  return {
    ready,
    granted,
    can: (...caps) => ready && caps.every(granted),
    refusal: (...caps) =>
      !ready ? REMOTE_NOT_READY : caps.map((cap) => refusalAs(cap)).find(Boolean),
    refusalAs,
    laneMarks: host?.laneMarks === true,
    machineShell: host?.machineShell === true,
  }
}

/** This Mac: always ready, everything granted. */
export const LOCAL_MACHINE_CAPS: MachineCaps = Object.freeze({
  ready: true,
  granted: () => true,
  can: () => true,
  refusal: () => undefined,
  refusalAs: () => undefined,
  laneMarks: true,
  machineShell: true,
})

/** The caps of a Host by id, or This Mac's for undefined; recomputed when the Host's view changes. */
export function useMachineCaps(hostId: string | undefined): MachineCaps {
  const host = useRemoteLanesStore((s) => (hostId === undefined ? undefined : s.hosts[hostId]))
  return useMemo(
    () => (hostId === undefined ? LOCAL_MACHINE_CAPS : machineCaps(host)),
    [hostId, host],
  )
}
