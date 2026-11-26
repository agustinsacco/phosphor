import { create } from 'zustand'
import { remoteLaneKey } from '@shared/remote-host'
import type { PendingAttachment } from '@/features/chat/attachments'
import { takeSubmittedDraft, type DraftKey } from './drafts'
import { useLayoutStore } from './layout'
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
  /** Fresh branch names asked for and not refused: how an uncertain receipt finds its lane. */
  branches: string[]
  /** The folder's lanes when the create began; a lane not among them may be this one. */
  seen: string[]
  /** Set as soon as the Host answers with the lane, before it is adopted. */
  laneId?: string
  sessionId?: string
  /** Why it failed; the placeholder stays with Edit and retry and Dismiss. */
  failure?: string
  /** The Host may have made the lane anyway: no create is sent again for it. */
  unknown?: boolean
  /** Still asking the Host whether an uncertain create made its lane. */
  checking?: boolean
  /** An uncertain create whose text went back to the composer; it only holds its claim. */
  retired?: boolean
}

export const useLaneCreatesStore = create<{
  creates: Record<string, LaneCreate>
  /** Lanes a create is known to have made (`remoteLaneKey`); never matched to another. */
  claimed: Record<string, true>
}>(() => ({ creates: {}, claimed: {} }))

export const laneCreate = (id: string): LaneCreate | undefined =>
  useLaneCreatesStore.getState().creates[id]

/** On screen: its placeholder is the opening view and no page covers it. */
export const laneCreateShown = (id: string): boolean =>
  useSessionsStore.getState().opening?.create === id && useLayoutStore.getState().page === null

export function patchLaneCreate(id: string, change: Partial<LaneCreate>): void {
  useLaneCreatesStore.setState((s) => {
    const current = s.creates[id]
    return current ? { creates: { ...s.creates, [id]: { ...current, ...change } } } : {}
  })
}

export function claimLane(hostId: string, laneId: string): void {
  useLaneCreatesStore.setState((s) => ({
    claimed: { ...s.claimed, [remoteLaneKey(hostId, laneId)]: true },
  }))
}

/** Leaves the placeholder's view if it is the opening one; the screen underneath shows. */
export function leaveLaneCreate(id: string): void {
  useSessionsStore.setState((s) => (s.opening?.create === id ? { opening: null } : {}))
}

/** What each create took from its composer, and where a restore goes. */
const submissions = new Map<
  string,
  { finish: (accepted: boolean) => void; destination: { key: DraftKey } }
>()

/** Takes the composer's draft for a create, reserving its documents' budget. */
export function takeLaneCreateDraft(id: string, draftKey: DraftKey): void {
  const destination = { key: draftKey }
  const { finish } = takeSubmittedDraft(draftKey, () => destination.key, { append: true })
  submissions.set(id, { finish, destination })
}

/**
 * Settles what was sent: discarded (`restoreTo` absent) or appended to that
 * draft. Once only; the create itself stays until `dropLaneCreate`.
 */
export function settleLaneCreateDraft(id: string, restoreTo?: DraftKey): void {
  const entry = submissions.get(id)
  submissions.delete(id)
  if (!entry) return
  if (restoreTo) entry.destination.key = restoreTo
  entry.finish(!restoreTo)
}

/** Forgets the create and leaves its view; its draft must be settled first. */
export function dropLaneCreate(id: string): void {
  settleLaneCreateDraft(id)
  leaveLaneCreate(id)
  useLaneCreatesStore.setState((s) => {
    const { [id]: _gone, ...creates } = s.creates
    return { creates }
  })
}
