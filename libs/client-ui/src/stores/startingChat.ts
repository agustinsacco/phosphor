import { create } from 'zustand'
import type { ImageContent } from '@shared/rpc'
import type { StartChatPhase } from '@/features/sessions/startChat'
import type { PendingAttachment } from '@/features/chat/attachments'

/**
 * The chat that has been sent but does not exist yet.
 *
 * Pressing Enter on the home composer used to change nothing on screen: the
 * typed text stayed in the field, the greeting stayed up, and the only
 * feedback was a 14px spinner in the composer's corner — while `startChat`
 * resolved a start point, created a worktree and spawned pi. Even at ~350ms
 * warm that reads as a dropped keystroke, and the labels written to narrate
 * the wait ("Creating branch…") only ever reached `aria-label`.
 *
 * So the send is committed immediately instead: the composer clears, this
 * store holds the message, and the app renders it as a chat that is coming up
 * (`StartingChat`). When the session exists, `activeSessionId` flips and the
 * real transcript takes over — showing the same message, in the same bubble,
 * in the same place, so the swap is invisible.
 *
 * **`draft` is the other half of that bargain.** Committing the send unmounts
 * `WorkspaceHome`, which takes its `text`/`images` state with it — so if the
 * start then fails, the component that would restore what the user typed no
 * longer exists. The draft is parked here instead, and the freshly remounted
 * greeting screen picks it up.
 *
 * **Its own store, like `naming.ts`.** It changes several times per send and
 * is read by the app shell; `sessions.ts` is subscribed to by the sidebar,
 * the top bar and the resource monitor, and does not need to re-render for
 * any of this.
 */
export interface StartingChat {
  /** This Mac: folder the chat was composed against — where the greeting screen was. */
  workspacePath?: string
  prompt: string
  images?: ImageContent[]
  phase: StartChatPhase
  /**
   * A Host lane. Its phases come from the hosts snapshot (`laneStarts`), and its
   * draft never leaves the drafts store, so a failure only ends the echo.
   */
  remote?: RemoteStart
}

export interface RemoteStart {
  hostId: string
  repositoryId: string
  draftKey: string
  /** The adopted lane whose first prompt is still on its way from this client. */
  sessionId?: string
  laneId?: string
}

/** Whether the echo stands in for this lane, whose first prompt this client is still sending. */
export function coversLane(
  starting: StartingChat | null,
  lane: { sessionId: string } | { hostId: string; laneId: string },
): boolean {
  const remote = starting?.remote
  if (!remote?.sessionId) return false
  return 'sessionId' in lane
    ? lane.sessionId === remote.sessionId
    : lane.hostId === remote.hostId && lane.laneId === remote.laneId
}

/** What the composer should be holding again after a failed start. */
export interface ComposerDraft {
  workspacePath: string
  text: string
  attachments: PendingAttachment[]
  swarm?: boolean
  /** Why it came back. Shown under the composer. */
  message: string
}

interface StartingChatState {
  starting: StartingChat | null
  draft: ComposerDraft | null
  begin: (chat: Omit<StartingChat, 'phase'>) => void
  setPhase: (phase: StartChatPhase) => void
  /** Keep standing in for this adopted Host lane until its first prompt is sent. */
  cover: (hostId: string, repositoryId: string, lane: { sessionId: string; laneId: string }) => void
  /**
   * The session exists (or was abandoned): stop standing in for it. A Host start
   * passes its draft key, so it never ends a different start that replaced it.
   */
  finish: (draftKey?: string) => void
  /** The start failed: hand the message back to the composer with a reason. */
  restore: (draft: ComposerDraft) => void
  /** The composer has taken the draft back. */
  clearDraft: () => void
}

export const useStartingChatStore = create<StartingChatState>((set) => ({
  starting: null,
  draft: null,

  // Clearing `draft` here as well: a new send supersedes whatever the last
  // failed one left behind, and leaving it would re-inject old text the
  // moment this send finishes. A Host start keeps it: its own draft lives in
  // the drafts store, and the parked one still waits for its workspace.
  begin: (chat) =>
    set((s) => ({
      starting: { ...chat, phase: 'branching' },
      draft: chat.remote ? s.draft : null,
    })),

  setPhase: (phase) => set((s) => (s.starting ? { starting: { ...s.starting, phase } } : s)),

  // By Host and repository: a newer start that replaced this one is never covered for it.
  cover: (hostId, repositoryId, lane) =>
    set((s) =>
      s.starting?.remote?.hostId === hostId && s.starting.remote.repositoryId === repositoryId
        ? { starting: { ...s.starting, remote: { ...s.starting.remote, ...lane } } }
        : s,
    ),

  finish: (draftKey) =>
    set((s) => (draftKey && s.starting?.remote?.draftKey !== draftKey ? s : { starting: null })),

  restore: (draft) => set({ starting: null, draft }),

  clearDraft: () => set({ draft: null }),
}))
