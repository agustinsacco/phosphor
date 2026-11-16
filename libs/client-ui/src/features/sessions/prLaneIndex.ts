import { remotePrKey } from '@shared/host-protocol-github'
import type { HostsSnapshot } from '@shared/ipc'
import type { GhPrKey, GitInfo, LanePrSignals, LiveSessionInfo, SessionMeta } from '@shared/models'
import type { PrLanePlace } from '@/features/notifications/prNotice'
import { sessionTitle } from '@/lib/sessionTitle'
import { useChatStore } from '@/stores/chat'
import { machineCaps } from '@/stores/machineCaps'
import { usePrStatusStore, type PrStatusEntry } from '@/stores/prStatus'
import {
  repoPullRequests,
  usePullRequestsStore,
  type RepoPullRequests,
} from '@/stores/pullRequests'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { resolveLanePrs, type LanePr } from './lanePrs'

/** The lane a PR belongs to. */
export type PrLaneOwner = PrLanePlace & {
  title: string
  /** The lane's session when it is running here. */
  sessionId?: string
  pr: LanePr
}

/** What the index reads of a scanned session file. */
export type PrLaneFile = Pick<
  SessionMeta,
  'path' | 'cwd' | 'name' | 'firstUserText' | 'mtimeMs' | 'pullRequests'
>

export interface PrLaneIndexInput {
  /** Scanned session files by the folder they are listed under. */
  disk: Readonly<Record<string, readonly PrLaneFile[]>>
  live: Readonly<
    Record<
      string,
      { phosphorId: string; diskPath?: string } & Pick<LiveSessionInfo, 'target' | 'laneId'>
    >
  >
  gitByCwd: Readonly<Record<string, Pick<GitInfo, 'mainRepoPath' | 'branch'> | undefined>>
  byRepo: Readonly<Record<string, RepoPullRequests>>
  status: Record<GhPrKey, PrStatusEntry>
  /** Host lanes, with the signals their Hosts folded from each lane's file. */
  hosts?: Readonly<HostsSnapshot>
  /** A running lane's name, which the scan learns late. */
  liveNames?: ReadonlyMap<string, string>
}

interface IndexLane {
  place: PrLanePlace
  touchedAt: number
  signals: LanePrSignals | undefined
  branch: string | undefined
  slice: RepoPullRequests
  sessionId: string | undefined
  title: (liveName: string | undefined) => string
}

function localLanes(input: PrLaneIndexInput): IndexLane[] {
  const liveByPath = new Map<string, string>()
  for (const entry of Object.values(input.live))
    if (entry.diskPath) liveByPath.set(entry.diskPath, entry.phosphorId)
  return Object.entries(input.disk).flatMap(([workspacePath, metas]) =>
    metas.map((meta) => {
      const git = input.gitByCwd[meta.cwd || workspacePath]
      return {
        place: { path: meta.path, workspacePath },
        touchedAt: meta.mtimeMs,
        signals: meta.pullRequests,
        branch: git?.branch,
        slice: repoPullRequests({ byRepo: input.byRepo }, git?.mainRepoPath ?? meta.cwd),
        sessionId: liveByPath.get(meta.path),
        title: (liveName) =>
          sessionTitle({
            explicitName: liveName ?? meta.name,
            firstUserText: meta.firstUserText,
          }) ?? 'Untitled lane',
      }
    }),
  )
}

/** A Host lane's PRs as its row resolves them: an older Host's lanes keep the checkout branch only. */
function hostLanes(input: PrLaneIndexInput): IndexLane[] {
  const liveByLane = new Map<string, string>()
  for (const entry of Object.values(input.live))
    if (entry.target?.kind === 'remote' && entry.laneId)
      liveByLane.set(`${entry.target.hostId}/${entry.laneId}`, entry.phosphorId)
  return Object.entries(input.hosts ?? {}).flatMap(([hostId, host]) => {
    const byNumber = host.prStatus === true && machineCaps(host).can('workspaces.read')
    return host.lanes.map((lane) => ({
      place: { hostId, laneId: lane.laneId },
      touchedAt: Date.parse(lane.updatedAt) || 0,
      signals: byNumber ? lane.pullRequests : undefined,
      branch: lane.branch ?? undefined,
      slice: repoPullRequests({ byRepo: input.byRepo }, remotePrKey(hostId, lane.repositoryId)),
      sessionId: liveByLane.get(`${hostId}/${lane.laneId}`),
      title: (liveName) => liveName?.trim() || lane.title || 'Untitled lane',
    }))
  })
}

/**
 * Which lane owns which PR: `resolveLanePrs(...).owned` for every This Mac lane
 * on disk and every Host lane its Host lists, never a suggestion (reviewing or
 * mentioned). When two lanes own one PR, the one touched last keeps it.
 */
export function prLaneIndex(input: PrLaneIndexInput): Map<GhPrKey, PrLaneOwner> {
  const lanes = [...localLanes(input), ...hostLanes(input)].sort(
    (a, b) => b.touchedAt - a.touchedAt,
  )
  const index = new Map<GhPrKey, PrLaneOwner>()
  for (const lane of lanes) {
    const { signals, branch, slice } = lane
    const owned = resolveLanePrs({ signals, branch, slice, status: input.status }).owned
    if (!owned.length) continue
    const sessionId = lane.sessionId
    const title = lane.title(sessionId ? input.liveNames?.get(sessionId) : undefined)
    for (const pr of owned) {
      if (index.has(pr.key)) continue
      index.set(pr.key, { ...lane.place, title, sessionId, pr })
    }
  }
  return index
}

/** The index from the stores now: for a decision, not for rendering. */
export function currentPrLaneIndex(): Map<GhPrKey, PrLaneOwner> {
  const { disk, live, gitByCwd } = useSessionsStore.getState()
  const chats = useChatStore.getState().sessions
  const liveNames = new Map<string, string>()
  for (const id of Object.keys(live)) {
    const name = chats[id]?.meta?.sessionName
    if (name) liveNames.set(id, name)
  }
  return prLaneIndex({
    disk,
    live,
    gitByCwd,
    byRepo: usePullRequestsStore.getState().byRepo,
    status: usePrStatusStore.getState().byKey,
    hosts: useRemoteLanesStore.getState().hosts,
    liveNames,
  })
}
