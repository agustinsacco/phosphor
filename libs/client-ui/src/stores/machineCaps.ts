import { useMemo } from 'react'
import type { HostConnectionView } from '@shared/ipc'
import type { HostCapability } from '@shared/remote-host'
import { featureNotOffered, REMOTE_NOT_READY, type GrantedCapability } from './hostRefusals'
import { useRemoteLanesStore } from './remoteLanes'
import { hostReady } from './hostReadiness'

type HostCapsSource = Pick<
  HostConnectionView,
  | 'state'
  | 'capabilities'
  | 'laneMarks'
  | 'laneArchive'
  | 'machineShell'
  | 'laneTransfer'
  | 'fileBytes'
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
  laneArchive: boolean
  /** Offers a machine shell. */
  machineShell: boolean
  /** Can import and export saved lanes. */
  laneTransfer: boolean
  /** Serves raw file bytes: downloads and media previews. */
  fileBytes: boolean
}

/** A Host's caps from its view; an unknown or starting Host is not ready. */
export function machineCaps(host: HostCapsSource | undefined): MachineCaps {
  const ready = hostReady(host)
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
    laneArchive: host?.laneArchive === true,
    machineShell: host?.machineShell === true,
    laneTransfer: host?.laneTransfer === true,
    fileBytes: host?.fileBytes === true,
  }
}

/**
 * Why this device cannot open the machine's own shell (its account's home, outside any
 * lane), or null when it can. Names the machine, because the Machine page shows it
 * beside everything else that is specific to this one.
 */
export function machineShellRefusal(
  host: Pick<HostConnectionView, 'state' | 'capabilities' | 'machineShell'> | undefined,
  label: string,
): string | null {
  if (!host || host.state !== 'ready') return `Connect to ${label} to open a terminal.`
  if (!host.capabilities.includes('terminal') || !host.capabilities.includes('sessions.control'))
    return `This device may not open terminals on ${label}.`
  if (!host.machineShell) return `Update the Host on ${label} to open a terminal here.`
  return null
}

/** This Mac: always ready, everything granted. */
export const LOCAL_MACHINE_CAPS: MachineCaps = Object.freeze({
  ready: true,
  granted: () => true,
  can: () => true,
  refusal: () => undefined,
  refusalAs: () => undefined,
  laneMarks: true,
  laneArchive: true,
  machineShell: true,
  laneTransfer: true,
  fileBytes: true,
})

/** The caps of a Host by id, or This Mac's for undefined; recomputed when the Host's view changes. */
export function useMachineCaps(hostId: string | undefined): MachineCaps {
  const host = useRemoteLanesStore((s) => (hostId === undefined ? undefined : s.hosts[hostId]))
  return useMemo(
    () => (hostId === undefined ? LOCAL_MACHINE_CAPS : machineCaps(host)),
    [hostId, host],
  )
}
