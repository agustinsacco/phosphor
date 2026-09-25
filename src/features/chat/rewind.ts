import type { ImageContent } from '@shared/rpc'
import { useChatStore } from '@/stores/chat'
import { bootstrapSession } from '@/stores/sessions'
import { piCall, rehydrateTranscript } from '@/lib/rpc'
import type { ChatItem, UserItem } from './chatItems'
import { userMessageImages, userMessageText } from './messageContent'
import { useChatUiStore } from './uiState'

/**
 * Rewind semantics come straight from pi's own `fork` RPC command: it
 * branches the *live* session onto a new file rooted just before `entryId`
 * and hands back the original text, which the composer offers up for
 * edit-and-resend. This is the one mechanism behind both the per-message
 * "Rewind" button and the (multi-message) fork picker.
 *
 * pi always creates a new session file here, even though the live RPC
 * connection carries on uninterrupted on the same subprocess — so
 * `bootstrapSession` has to run again to relearn the new `sessionFile`.
 * Skipping that step leaves `live[sessionId].diskPath` pointed at the
 * abandoned pre-fork file, which reads in the sidebar as the chat having
 * been duplicated (see `bootstrapSession`'s doc comment).
 *
 * `images` is supplied by the caller, not by pi: `fork` replies with
 * `selectedText` only (`extractUserMessageText` in pi's runtime drops every
 * non-text block), so the caller reads them off the entry it is forking from
 * (`currentBranchUserMessages`). Without them, rewinding a message that had
 * a screenshot on it gave the text back and silently ate the screenshot.
 *
 * `entryId` must come from `currentBranchUserMessages`, never from a
 * position in some other list — see that function for what went wrong.
 */
export async function rewindToEntry(
  sessionId: string,
  entryId: string,
  images?: ImageContent[],
): Promise<void> {
  const fork = await piCall(sessionId, { type: 'fork', entryId })
  if (!fork) return
  if (fork.cancelled) {
    useChatStore.getState().setError(sessionId, 'Rewind was cancelled by an extension.')
    return
  }
  // Rebuild the transcript from the new branch point and relearn its file.
  await Promise.all([rehydrateTranscript(sessionId), bootstrapSession(sessionId)])
  if (fork.text || images?.length) {
    useChatUiStore.getState().setPrefill(sessionId, fork.text, images)
  }
}

/** A user message on the session's current branch — something `fork` accepts. */
export interface BranchUserMessage {
  entryId: string
  text: string
  images?: ImageContent[]
  /** The AgentMessage's own unix ms — the same value the transcript renders. */
  timestamp?: number
}

/** The slice of a raw pi session entry this module reads. */
interface RawEntry {
  id: string
  parentId: string | null
  type: string
  message?: {
    role?: string
    content?: string | Array<{ type: string; text?: string; data?: string; mimeType?: string }>
    timestamp?: number
  }
}

function isRawEntry(value: unknown): value is RawEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry.id === 'string' && typeof entry.type === 'string'
}

/**
 * Root-to-leaf path through a session's entry tree — pi's own
 * `buildSessionPath`, mirrored: a `null` leaf is an empty session (every
 * entry abandoned), and an unknown leaf falls back to the last entry.
 */
function branchPath(entries: RawEntry[], leafId: string | null): RawEntry[] {
  if (leafId === null) return []
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const path: RawEntry[] = []
  const seen = new Set<string>()
  let current = byId.get(leafId) ?? entries[entries.length - 1]
  // `seen` only guards against a corrupt file whose parents form a cycle.
  while (current && !seen.has(current.id)) {
    seen.add(current.id)
    path.push(current)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return path.reverse()
}

/**
 * Every user message on the session's current branch, oldest first, read
 * from the entry tree itself (`get_entries` plus its `leafId`).
 *
 * This is the list a rewind has to target, and neither of the two obvious
 * sources is it. `get_fork_messages` walks the WHOLE FILE: every abandoned
 * branch's messages, in file order, minus any message with no text (a lone
 * screenshot). The rendered transcript is `get_messages`, which is pi's
 * compaction-aware context: a compacted session renders only what the
 * summary kept. Both lists grow and shrink independently, so the Nth
 * rendered message and the Nth fork candidate are the same message only in
 * a session that was never compacted, branched, or sent an image without
 * text. Rewind used to assume they always were, and on a compacted session
 * it forked from a message hundreds of turns earlier than the one clicked —
 * silently dropping everything after it from the new branch.
 *
 * Images come from the entry too: pi's `fork` reply carries text only, and
 * the entry is what the model actually saw.
 *
 * `get_entries` ships the whole file: 15 MB for the largest local session,
 * ~80 ms to parse and clone. Fine behind a click; keep it off render paths.
 *
 * Deliberately NOT `piCall` (CLAUDE.md fact 3): every caller turns `null`
 * into its own, more specific message.
 */
export async function currentBranchUserMessages(
  sessionId: string,
): Promise<BranchUserMessage[] | null> {
  const response = await window.phosphor.piCommand(sessionId, { type: 'get_entries' })
  if (!response.success || !response.data) return null
  const entries = response.data.entries.filter(isRawEntry)
  const messages: BranchUserMessage[] = []
  for (const entry of branchPath(entries, response.data.leafId)) {
    const message = entry.message
    if (entry.type !== 'message' || message?.role !== 'user' || message.content == null) continue
    const content = { content: message.content }
    const text = userMessageText(content)
    const images = userMessageImages(content)
    // Mirrors the rewind button's own gate: nothing to put back in the composer.
    if (!text && !images) continue
    messages.push({ entryId: entry.id, text, images, timestamp: message.timestamp })
  }
  return messages
}

/**
 * Find the branch entry behind a rendered user message, or null when none
 * matches for certain. A miss is always preferable to a guess: forking from
 * the wrong entry drops real conversation from the new branch.
 *
 * The timestamp is the key. It is the AgentMessage's own `timestamp`, carried
 * verbatim by both the entry and the message the transcript rendered, so it
 * identifies the message even when a context edit replaced its text. Text
 * breaks a tie, should two messages ever share a millisecond. A timestamp
 * that matches nothing means the message is not on this branch at all (the
 * transcript is stale), which is a miss, not a cue to guess by text.
 *
 * Only a message without a timestamp falls back to text, counted from the
 * END: the transcript and the branch both end at the leaf, so the
 * Nth-from-last rendered message with this text is the Nth-from-last branch
 * message with it — which holds however much of the start compaction
 * trimmed, and still picks the right one of several identical "continue"s.
 */
export function matchRenderedUserMessage(
  branch: BranchUserMessage[],
  rendered: ChatItem[],
  item: UserItem,
): BranchUserMessage | null {
  if (item.timestamp != null) {
    const sameTime = branch.filter((message) => message.timestamp === item.timestamp)
    if (sameTime.length <= 1) return sameTime[0] ?? null
    const sameText = sameTime.filter((message) => message.text === item.text)
    return sameText.length === 1 ? sameText[0]! : null
  }

  const index = rendered.findIndex((candidate) => candidate.id === item.id)
  if (index < 0) return null
  let laterTwins = 0
  for (const later of rendered.slice(index + 1)) {
    if (later.kind === 'user' && !later.optimistic && later.text === item.text) laterTwins++
  }
  const twins = branch.filter((message) => message.text === item.text)
  return twins[twins.length - 1 - laterTwins] ?? null
}

/** The branch entry a rendered user message's rewind button forks from. */
export async function branchMessageForItem(
  sessionId: string,
  item: UserItem,
): Promise<BranchUserMessage | null> {
  const branch = await currentBranchUserMessages(sessionId)
  if (!branch) return null
  // Read after the await: the transcript the match counts against must be
  // the one that exists now, not the one from before the round trip.
  const rendered = useChatStore.getState().sessions[sessionId]?.items ?? []
  return matchRenderedUserMessage(branch, rendered, item)
}
