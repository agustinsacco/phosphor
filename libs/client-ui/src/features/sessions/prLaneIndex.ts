import type { GhPrKey, GitInfo, SessionMeta } from '@shared/models'
import { sessionTitle } from '@/lib/sessionTitle'
import { useChatStore } from '@/stores/chat'
import { usePrStatusStore, type PrStatusEntry } from '@/stores/prStatus'
import {
  repoPullRequests,
  usePullRequestsStore,
  type RepoPullRequests,
} from '@/stores/pullRequests'
import { useSessionsStore } from '@/stores/sessions'
import { resolveLanePrs, type LanePr } from './lanePrs'

/** The This Mac lane a PR belongs to: its session file and the folder it is listed under. */
export interface PrLaneOwner {
  path: string
  workspacePath: string
  title: string
  /** The lane's pi session when it is running. */
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
  live: Readonly<Record<string, { phosphorId: string; diskPath?: string }>>
  gitByCwd: Readonly<Record<string, Pick<GitInfo, 'mainRepoPath' | 'branch'> | undefined>>
  byRepo: Readonly<Record<string, RepoPullRequests>>
  status: Record<GhPrKey, PrStatusEntry>
  /** A running lane's name, which the scan learns late. */
  liveNames?: ReadonlyMap<string, string>
}

/**
 * Which lane owns which PR: `resolveLanePrs(...).owned` for every This Mac
 * lane on disk, never a suggestion (reviewing or mentioned). When two lanes
 * own one PR, the one touched last keeps it.
 */
export function prLaneIndex(input: PrLaneIndexInput): Map<GhPrKey, PrLaneOwner> {
  const liveByPath = new Map<string, string>()
  for (const entry of Object.values(input.live))
    if (entry.diskPath) liveByPath.set(entry.diskPath, entry.phosphorId)
  const lanes = Object.entries(input.disk)
    .flatMap(([workspacePath, metas]) => metas.map((meta) => ({ workspacePath, meta })))
    .sort((a, b) => b.meta.mtimeMs - a.meta.mtimeMs)
  const index = new Map<GhPrKey, PrLaneOwner>()
  for (const { workspacePath, meta } of lanes) {
    const git = input.gitByCwd[meta.cwd || workspacePath]
    const owned = resolveLanePrs({
      signals: meta.pullRequests,
      branch: git?.branch,
      slice: repoPullRequests({ byRepo: input.byRepo }, git?.mainRepoPath ?? meta.cwd),
      status: input.status,
    }).owned
    if (!owned.length) continue
    const sessionId = liveByPath.get(meta.path)
    const liveName = sessionId ? input.liveNames?.get(sessionId) : undefined
    const title =
      sessionTitle({
        explicitName: liveName ?? meta.name,
        firstUserText: meta.firstUserText,
      }) ?? 'Untitled lane'
    for (const pr of owned) {
      if (index.has(pr.key)) continue
      index.set(pr.key, { path: meta.path, workspacePath, title, sessionId, pr })
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
    liveNames,
  })
}
