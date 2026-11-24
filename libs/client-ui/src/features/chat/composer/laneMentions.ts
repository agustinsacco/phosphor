import { useShallow } from 'zustand/react/shallow'
import type { RpcSessionState } from '@phosphor/shared/rpc'
import { useMemo } from 'react'
import { localLiveEntries } from '@/features/machines/localLive'
import { remoteLaneTitle } from '@/features/sessions/remoteLaneView'
import { localMachineLabel } from '@/lib/localMachine'
import { sessionTitle } from '@/lib/sessionTitle'
import { laneHref, parseLaneHref } from '@/lib/laneMention'
import { fuzzyFilter } from '@/lib/fuzzy'
import { usePlatform } from '@/platform/Platform'
import { useChatStore } from '@/stores/chat'
import { machineCaps } from '@/stores/machineCaps'
import { machineLabel, useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import type { SessionMeta } from '@phosphor/shared/models'
import type { LaneKey } from '@/navigation/location'

type Destination = LaneKey | { workspace: string; meta: SessionMeta }
export interface LaneMention {
  href: string
  title: string
  machine: string
  destination: Destination
}

type Sessions = ReturnType<typeof useSessionsStore.getState>
type Chats = ReturnType<typeof useChatStore.getState>['sessions']

function liveMetadata(chats: Chats, live: Sessions['live'] | undefined) {
  return Object.fromEntries(
    localLiveEntries(live ?? {}).map((entry) => [entry.phosphorId, chats[entry.phosphorId]?.meta]),
  )
}

function localMentions(
  disk: Sessions['disk'],
  metadata: Record<string, RpcSessionState | null | undefined>,
) {
  const lanes = new Map<string, LaneMention>()
  const machine = localMachineLabel()
  for (const [workspace, metas] of Object.entries(disk)) {
    for (const meta of metas) {
      const href = laneHref({ piSessionId: meta.sessionId })
      const title =
        sessionTitle({ explicitName: meta.name, firstUserText: meta.firstUserText }) ??
        'Untitled lane'
      lanes.set(href, { href, title, machine, destination: { workspace, meta } })
    }
  }
  for (const [sessionId, meta] of Object.entries(metadata)) {
    if (!meta?.sessionId) continue
    const href = laneHref({ piSessionId: meta.sessionId })
    const title =
      sessionTitle({ explicitName: meta.sessionName }) ?? lanes.get(href)?.title ?? 'Untitled lane'
    lanes.set(href, { href, title, machine, destination: { sessionId } })
  }
  return lanes
}

function hostMentions(hosts: ReturnType<typeof useRemoteLanesStore.getState>['hosts']) {
  const lanes = new Map<string, LaneMention>()
  for (const [hostId, host] of Object.entries(hosts)) {
    if (!machineCaps(host).can('sessions.read')) continue
    const publicId = (host.local && host.enrolledHostId) || hostId
    const machine = machineLabel(host.local ? 'local' : hostId)
    for (const lane of host.lanes) {
      const destination = { hostId, laneId: lane.laneId }
      const href = laneHref({ ...destination, hostId: publicId })
      if (!host.local && lanes.has(href)) continue
      lanes.set(href, { href, machine, title: remoteLaneTitle(null, lane.title), destination })
    }
  }
  return lanes
}

/** Read only the existing lane projections, never a transcript or an extra IPC. */
export function useLaneMentions(query: string | undefined) {
  const local = usePlatform().localLanes && query !== undefined
  const disk = useSessionsStore((s) => (local ? s.disk : undefined))
  const live = useSessionsStore((s) => (local ? s.live : undefined))
  const metadata = useChatStore(
    useShallow((s) => (live ? liveMetadata(s.sessions, live) : undefined)),
  )
  const hosts = useRemoteLanesStore((s) => (query !== undefined ? s.hosts : undefined))
  const lanes = useMemo(
    () =>
      [
        ...(disk && metadata ? localMentions(disk, metadata).values() : []),
        ...(hosts ? hostMentions(hosts).values() : []),
      ].filter((lane) => parseLaneHref(lane.href)),
    [disk, metadata, hosts],
  )
  return useMemo(
    () => fuzzyFilter(query ?? '', lanes, (lane) => `${lane.title} ${lane.machine}`, 12),
    [query, lanes],
  )
}

/** Resolve again on click: a handle or socket alias may have changed since insertion. */
export function findMentionDestination(href: string, local: boolean): Destination | undefined {
  const target = parseLaneHref(href)
  if (!target) return
  if ('hostId' in target) {
    const hosts = useRemoteLanesStore.getState().hosts
    // Pre-enrollment links keep working on the original machine after enrollment.
    for (const [hostId, host] of Object.entries(hosts)) {
      if (hostId !== target.hostId && !(host.local && host.enrolledHostId === target.hostId))
        continue
      if (
        machineCaps(host).can('sessions.read') &&
        host.lanes.some((lane) => lane.laneId === target.laneId)
      )
        return { hostId, laneId: target.laneId }
    }
    return
  }
  if (!local) return
  const { disk, live } = useSessionsStore.getState()
  return localMentions(disk, liveMetadata(useChatStore.getState().sessions, live)).get(href)
    ?.destination
}
