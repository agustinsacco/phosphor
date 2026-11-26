import type { HostLaneView } from '@shared/ipc'
import type { LiveSessionInfo } from '@shared/models'
import { hostResourceKey, remoteLaneKey } from '@shared/remote-host'
import { refreshRemoteArtifacts } from '@/features/artifacts/remoteArtifactRefresh'
import { rememberRemoteRepository } from '@/features/home/remoteComposer'
import { useDraftsStore, type DraftKey } from './drafts'
import { useExtensionUiStore } from './extensionUi'
import { refreshHostsSnapshot } from './hostsSnapshotRead'
import { useLayoutStore } from './layout'
import { useMachinesStore } from './machines'
import { alignLaneMachineFilter, navigateToLane, useRemoteLanesStore } from './remoteLanes'
import { useSessionsStore } from './sessions'
import {
  claimLane,
  dropLaneCreate,
  laneCreate,
  laneCreateShown,
  leaveLaneCreate,
  patchLaneCreate,
  settleLaneCreateDraft,
  takeLaneCreateDraft,
  useLaneCreatesStore,
  type LaneCreate,
} from './laneCreateState'

export { laneCreate, laneCreateShown, useLaneCreatesStore, type LaneCreate }

/** A create can take two minutes on a big repository; its lane may be listed a while later. */
const CHECK_EVERY_MS = 10_000
const CHECK_FOR_MS = 180_000
const UNCONFIRMED =
  'The Host could not confirm this lane. If the lane shows up later, it was created.'

const RECOVERED = "Lane created. Your first message wasn't sent; it's in the composer."

let sequence = 0

/**
 * Takes the composer's draft and switches to its placeholder, in the same tick
 * as Enter. Undefined when the draft is empty (a second Enter already took it).
 */
export function beginLaneCreate(start: {
  hostId: string
  repositoryId: string
  draftKey: DraftKey
}): LaneCreate | undefined {
  const draft = useDraftsStore.getState().get(start.draftKey)
  const text = draft.text.trim()
  if (!text && !draft.attachments.length) return
  const id = `create-${++sequence}`
  takeLaneCreateDraft(id, start.draftKey)
  const lanes = useRemoteLanesStore.getState().hosts[start.hostId]?.lanes ?? []
  const seen = lanes.filter((l) => l.repositoryId === start.repositoryId).map((l) => l.laneId)
  const create: LaneCreate = {
    ...start,
    id,
    title: text || 'New lane',
    text,
    attachments: draft.attachments,
    swarm: !!draft.swarm,
    branches: [],
    seen,
  }
  useLaneCreatesStore.setState((s) => ({ creates: { ...s.creates, [id]: create } }))
  showLaneCreate(id)
  return create
}

/** Puts a placeholder on screen, in both shells: no page in the way, its machine in view. */
export function showLaneCreate(id: string): void {
  const create = laneCreate(id)
  if (!create || create.retired) return
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
  if (create) patchLaneCreate(id, { branches: [...create.branches, branch] })
}

export function refuseLaneCreateBranch(id: string, branch: string): void {
  const create = laneCreate(id)
  if (create) patchLaneCreate(id, { branches: create.branches.filter((b) => b !== branch) })
}

/** The Host made the lane: its row, once listed, replaces the placeholder's. */
export function laneCreated(id: string, info: LiveSessionInfo): void {
  const create = laneCreate(id)
  if (!create || !info.laneId) return
  claimLane(create.hostId, info.laneId)
  patchLaneCreate(id, { laneId: info.laneId, sessionId: info.sessionId })
  const lane = { hostId: create.hostId, laneId: info.laneId }
  useSessionsStore.setState((s) =>
    s.opening?.create === id ? { opening: { ...s.opening, lane } } : {},
  )
}

const laneDraftKey = (create: LaneCreate, laneId: string): DraftKey =>
  hostResourceKey({ kind: 'remote', hostId: create.hostId }, 'session', laneId)

/**
 * Done, sent or not: the placeholder goes, and its lane takes the screen only
 * if the placeholder is still on it. `restore` puts what was sent on the lane's
 * composer, after anything typed there meanwhile.
 */
export function finishLaneCreate(id: string, restore = false): void {
  const create = laneCreate(id)
  if (!create) return
  settleLaneCreateDraft(
    id,
    restore && create.laneId ? laneDraftKey(create, create.laneId) : undefined,
  )
  laneCreateAdopted(id)
  dropLaneCreate(id)
}

/**
 * Its lane is live here: it takes the screen if the placeholder still has it,
 * before the first prompt's files upload (the Host takes them only for the
 * lane on screen). Otherwise the screen stays where the user went.
 */
export function laneCreateAdopted(id: string): void {
  const create = laneCreate(id)
  if (!create?.sessionId || !laneCreateShown(id)) return
  if (!useSessionsStore.getState().live[create.sessionId]) return
  useSessionsStore.getState().activate(create.sessionId)
  void refreshRemoteArtifacts(create.sessionId)
}

export function failLaneCreate(id: string, failure: string, unknown: boolean): void {
  if (!unknown) patchLaneCreate(id, { failure })
  else {
    patchLaneCreate(id, { unknown: true, checking: true })
    if (!reconcileLaneCreate(id)) keepChecking(id, Date.now() + CHECK_FOR_MS)
  }
}

/** Fresh snapshot reads until the lane is listed or the window closes; never a second create. */
function keepChecking(id: string, until: number): void {
  setTimeout(() => {
    if (!laneCreate(id)?.checking) return
    if (Date.now() >= until) {
      patchLaneCreate(id, { checking: false, failure: UNCONFIRMED })
      if (!laneCreateShown(id)) useExtensionUiStore.getState().pushToast(UNCONFIRMED, 'warning')
      return
    }
    void refreshHostsSnapshot()
      .catch(() => undefined)
      .then(() => {
        if (!reconcileLaneCreate(id)) keepChecking(id, until)
      })
  }, CHECK_EVERY_MS)
}

/** Lanes new in the create's folder since Enter that no create is known to have made. */
function unclaimedLanes(create: LaneCreate): HostLaneView[] {
  const { claimed } = useLaneCreatesStore.getState()
  return (useRemoteLanesStore.getState().hosts[create.hostId]?.lanes ?? []).filter(
    (l) =>
      l.repositoryId === create.repositoryId &&
      !create.seen.includes(l.laneId) &&
      !claimed[remoteLaneKey(create.hostId, l.laneId)],
  )
}

/** Whether a lane could be this create's: its requested branch, or in place for one that asked for none. */
const mayBeFrom = (create: LaneCreate, lane: HostLaneView): boolean =>
  create.branches.length
    ? lane.worktree && lane.branch !== null && create.branches.includes(lane.branch)
    : !lane.worktree

/** The lane an uncertain create made, only when nothing else can explain it. */
function foundLane(create: LaneCreate): string | undefined {
  const found = unclaimedLanes(create).filter((l) => mayBeFrom(create, l))
  if (found.length !== 1 || (!create.branches.length && !aloneInPlace(create))) return
  return found[0]!.laneId
}

/**
 * In place: only when no other create here may have made a lane. One past its
 * window may still have; one the user took back with Edit and retry has not.
 */
function aloneInPlace(create: LaneCreate): boolean {
  const unresolved = Object.values(useLaneCreatesStore.getState().creates).filter(
    (c) =>
      c.hostId === create.hostId &&
      c.repositoryId === create.repositoryId &&
      !c.branches.length &&
      !c.laneId &&
      !c.retired &&
      (!c.failure || c.unknown),
  )
  return unresolved.length === 1 && unresolved[0]!.id === create.id
}

/**
 * An uncertain create whose lane the Host lists after all: it holds the lane
 * and is replaced by it, its text in that lane's composer. A retired one only
 * holds the lane. Returns the lane found.
 */
export function reconcileLaneCreate(id: string): string | undefined {
  const create = laneCreate(id)
  if (!create?.unknown) return
  const laneId = foundLane(create)
  if (!laneId) return
  claimLane(create.hostId, laneId)
  const shown = laneCreateShown(id)
  settleLaneCreateDraft(id, create.retired ? undefined : laneDraftKey(create, laneId))
  dropLaneCreate(id)
  if (!create.retired) useExtensionUiStore.getState().pushToast(RECOVERED, 'info')
  if (shown) void navigateToLane({ hostId: create.hostId, laneId })
  return laneId
}

useRemoteLanesStore.subscribe((state, previous) => {
  if (state.hosts === previous.hosts) return
  for (const create of Object.values(useLaneCreatesStore.getState().creates))
    if (create.unknown) reconcileLaneCreate(create.id)
})

/**
 * Edit and retry: what was sent goes back into the New lane composer, after
 * anything typed there since. Not while the Host may still list the lane; an
 * uncertain create keeps its claim afterwards, retired.
 */
export function editLaneCreate(id: string): void {
  const create = laneCreate(id)
  if (!create?.failure || create.checking) return
  rememberRemoteRepository(create.hostId, create.repositoryId)
  settleLaneCreateDraft(id, create.draftKey)
  if (create.swarm) useDraftsStore.getState().patch(create.draftKey, { swarm: true })
  if (!create.unknown) dropLaneCreate(id)
  else {
    // Only what matching needs stays: the text and files are back in the composer.
    patchLaneCreate(id, { retired: true, title: '', text: '', attachments: [] })
    leaveLaneCreate(id)
  }
}

export function dismissLaneCreate(id: string): void {
  dropLaneCreate(id)
}

/** Owner reset or sign-out: nothing of the previous owner's sends stays in memory. */
export function clearLaneCreates(keep: (create: LaneCreate) => boolean = () => false): void {
  for (const create of Object.values(useLaneCreatesStore.getState().creates))
    if (!keep(create)) dropLaneCreate(create.id)
  if (!Object.keys(useLaneCreatesStore.getState().creates).length)
    useLaneCreatesStore.setState({ claimed: {} })
}

useMachinesStore.subscribe((state, previous) => {
  const hosts = useRemoteLanesStore.getState().hosts
  // This Mac's service outlives remote sign-out, as the New lane composer's target does.
  if (!state.remoteEnabled && previous.remoteEnabled)
    clearLaneCreates((create) => !!hosts[create.hostId]?.local)
  else if (state.machines !== previous.machines)
    clearLaneCreates(
      (create) =>
        !!hosts[create.hostId]?.local ||
        state.machines.some((m) => m.id === create.hostId) ||
        !previous.machines.some((m) => m.id === create.hostId),
    )
})

const isRequestedLane = (create: LaneCreate, lane: HostLaneView): boolean =>
  lane.repositoryId === create.repositoryId &&
  !create.seen.includes(lane.laneId) &&
  mayBeFrom(create, lane)

/** A folder's placeholders (or a Host's), newest first, without those whose lane is listed. */
export function pendingLaneCreates(
  creates: Record<string, LaneCreate>,
  hostId: string,
  repositoryId: string | undefined,
  lanes: readonly HostLaneView[] = useRemoteLanesStore.getState().hosts[hostId]?.lanes ?? [],
): LaneCreate[] {
  return Object.values(creates)
    .filter(
      (c) =>
        c.hostId === hostId &&
        !c.retired &&
        (repositoryId === undefined || c.repositoryId === repositoryId) &&
        !(c.laneId && lanes.some((l) => l.laneId === c.laneId)) &&
        !listedEarly(c, lanes),
    )
    .reverse()
}

/**
 * The Host lists a lane while `hosts:createLane` is still opening it. A failed
 * create keeps its row: the lane on its branch is another create's.
 */
function listedEarly(create: LaneCreate, lanes: readonly HostLaneView[]): boolean {
  if (create.failure || create.laneId) return false
  const listed = lanes.filter((l) => isRequestedLane(create, l))
  return create.branches.length ? listed.length > 0 : listed.length === 1 && aloneInPlace(create)
}
