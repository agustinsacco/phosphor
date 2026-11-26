import { create } from 'zustand'
import type { HostLaneView } from '@shared/ipc'
import type { LiveSessionInfo } from '@shared/models'
import { hostResourceKey } from '@shared/remote-host'
import type { PendingAttachment } from '@/features/chat/attachments'
import { refreshRemoteArtifacts } from '@/features/artifacts/remoteArtifactRefresh'
import { rememberRemoteRepository } from '@/features/home/remoteComposer'
import { useDraftsStore, type DraftKey } from './drafts'
import { useLayoutStore } from './layout'
import { alignLaneMachineFilter, navigateToLane, useRemoteLanesStore } from './remoteLanes'
import { useSessionsStore } from './sessions'

/**
 * A Host lane the user asked for from a New lane composer, before (or
 * without) the Host confirming it. The composer clears at Enter and this
 * holds what was sent until the create is settled: its row sits at the top of
 * its folder, starting, and `LaneCreateView` shows the message. Several run at
 * once. Window-local and in memory; an owner reset drops them all.
 */
export interface LaneCreate {
  /** Client-side, per window; the Host never sees it. */
  id: string
  hostId: string
  repositoryId: string
  /** The composer the text came from; Edit and retry puts it back there. */
  draftKey: DraftKey
  title: string
  text: string
  attachments: PendingAttachment[]
  swarm: boolean
  /** Fresh branch names asked for: how an uncertain receipt finds its lane. */
  branches: string[]
  /** The folder's lanes when the create began; a lane not among them may be this one. */
  seen: string[]
  /** Set once the Host made the lane. */
  laneId?: string
  sessionId?: string
  /** Why it failed; the placeholder stays with Edit and retry and Dismiss. */
  failure?: string
  /** The Host may have made the lane anyway, so it is looked for before any retry. */
  unknown?: boolean
}

export const useLaneCreatesStore = create<{ creates: Record<string, LaneCreate> }>(() => ({
  creates: {},
}))

let sequence = 0

export const laneCreate = (id: string): LaneCreate | undefined =>
  useLaneCreatesStore.getState().creates[id]

export const laneCreateShown = (id: string): boolean =>
  useSessionsStore.getState().opening?.create === id

function patch(id: string, change: Partial<LaneCreate>): void {
  useLaneCreatesStore.setState((s) => {
    const current = s.creates[id]
    return current ? { creates: { ...s.creates, [id]: { ...current, ...change } } } : {}
  })
}

function drop(id: string): void {
  useLaneCreatesStore.setState((s) => {
    const { [id]: _gone, ...creates } = s.creates
    return { creates }
  })
}

/** Leaves the placeholder's view if it is on screen; the screen underneath shows. */
function leave(id: string): void {
  useSessionsStore.setState((s) => (s.opening?.create === id ? { opening: null } : {}))
}

/** Records the create and switches to its placeholder, in the same tick as Enter. */
export function beginLaneCreate(start: Omit<LaneCreate, 'id' | 'branches' | 'seen'>): string {
  const id = `create-${++sequence}`
  const lanes = useRemoteLanesStore.getState().hosts[start.hostId]?.lanes ?? []
  const seen = lanes.filter((l) => l.repositoryId === start.repositoryId).map((l) => l.laneId)
  useLaneCreatesStore.setState((s) => ({
    creates: { ...s.creates, [id]: { ...start, id, branches: [], seen } },
  }))
  showLaneCreate(id)
  return id
}

/** Puts a placeholder on screen, in both shells: no page in the way, its machine in view. */
export function showLaneCreate(id: string): void {
  const create = laneCreate(id)
  if (!create) return
  useLayoutStore.getState().setPage(null)
  alignLaneMachineFilter(create.hostId)
  useSessionsStore.getState().beginOpening({
    workspacePath: `create:${id}`,
    title: create.title,
    reason: 'open',
    create: id,
    ...(create.laneId ? { lane: { hostId: create.hostId, laneId: create.laneId } } : {}),
  })
}

export function noteLaneCreateBranch(id: string, branch: string): void {
  const create = laneCreate(id)
  if (create) patch(id, { branches: [...create.branches, branch] })
}

/** The Host made the lane: its real row, once listed, is the selection. */
export function laneCreated(id: string, info: LiveSessionInfo): void {
  const create = laneCreate(id)
  if (!create || !info.laneId) return
  patch(id, { laneId: info.laneId, sessionId: info.sessionId })
  const lane = { hostId: create.hostId, laneId: info.laneId }
  useSessionsStore.setState((s) =>
    s.opening?.create === id ? { opening: { ...s.opening, lane } } : {},
  )
}

/** Done: the placeholder goes, and its lane takes the screen only if the user is still on it. */
export function finishLaneCreate(id: string): void {
  const create = laneCreate(id)
  if (!create) return
  const shown = laneCreateShown(id)
  drop(id)
  if (!shown) return
  if (create.sessionId && useSessionsStore.getState().live[create.sessionId]) {
    useSessionsStore.getState().activate(create.sessionId)
    void refreshRemoteArtifacts(create.sessionId)
  } else leave(id)
}

/** What was sent goes to the lane's own composer, never into a second create. */
export function fileOnLane(create: LaneCreate, laneId: string): void {
  const key = hostResourceKey({ kind: 'remote', hostId: create.hostId }, 'session', laneId)
  useDraftsStore.getState().patch(key, { text: create.text, attachments: create.attachments })
}

export function failLaneCreate(id: string, failure: string, unknown: boolean): void {
  patch(id, { failure, unknown })
  if (unknown) reconcileLaneCreate(id)
}

/**
 * An uncertain create whose lane the Host lists after all: by a branch it was
 * asked for, or, unbranched, as the only lane in its folder that is new since
 * Enter and no other create's. Replaced by that lane; its text goes there.
 */
export function reconcileLaneCreate(id: string): string | undefined {
  const create = laneCreate(id)
  if (!create?.unknown) return
  const creates = Object.values(useLaneCreatesStore.getState().creates)
  const claimed = new Set(creates.map((c) => c.laneId))
  const unseen = (useRemoteLanesStore.getState().hosts[create.hostId]?.lanes ?? []).filter(
    (l) =>
      l.repositoryId === create.repositoryId &&
      !create.seen.includes(l.laneId) &&
      !claimed.has(l.laneId),
  )
  const found = create.branches.length
    ? unseen.filter((l) => l.branch !== null && create.branches.includes(l.branch))
    : unseen
  if (found.length !== 1) return
  const laneId = found[0]!.laneId
  const shown = laneCreateShown(id)
  fileOnLane(create, laneId)
  drop(id)
  if (shown) void navigateToLane({ hostId: create.hostId, laneId })
  return laneId
}

useRemoteLanesStore.subscribe((state, previous) => {
  if (state.hosts === previous.hosts) return
  for (const create of Object.values(useLaneCreatesStore.getState().creates))
    if (create.unknown) reconcileLaneCreate(create.id)
})

/** Edit and retry: the text and attachments back in the New lane composer, the placeholder gone. */
export function editLaneCreate(id: string): void {
  const create = laneCreate(id)
  if (!create || (create.unknown && reconcileLaneCreate(id))) return
  rememberRemoteRepository(create.hostId, create.repositoryId)
  useDraftsStore.getState().patch(create.draftKey, {
    text: create.text,
    attachments: create.attachments,
    swarm: create.swarm,
  })
  leave(id)
  drop(id)
}

export function dismissLaneCreate(id: string): void {
  leave(id)
  drop(id)
}

/** A folder's placeholders, newest first, without those whose lane the Host now lists. */
export function pendingLaneCreates(
  creates: Record<string, LaneCreate>,
  hostId: string,
  repositoryId: string,
  lanes: readonly HostLaneView[] = useRemoteLanesStore.getState().hosts[hostId]?.lanes ?? [],
): LaneCreate[] {
  return Object.values(creates)
    .filter(
      (c) =>
        c.hostId === hostId &&
        c.repositoryId === repositoryId &&
        !(c.laneId && lanes.some((l) => l.laneId === c.laneId)),
    )
    .reverse()
}
