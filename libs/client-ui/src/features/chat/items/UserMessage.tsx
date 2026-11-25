/**
 * A turn the person sent: the bubble, and the affordances under it.
 *
 * Extracted from `MessageItem.tsx` because that file had grown into every row
 * type at once and had reached its size ceiling; the user row is the one piece
 * of the transcript with behaviour of its own (rewind, fork, the turn's time).
 *
 * Date and time, the way every chat surface settles it (Slack's day divider
 * and hover-exact time, iMessage's `Today 1:25 AM`): the day divider above the
 * turn carries the DATE (`items/dayDividers.ts`), this row carries a quiet
 * CLOCK time, and the exact stamp is one hover away. A timestamp on every
 * message is noise a reader stops seeing; a day boundary is the one moment
 * they need orienting.
 */
import { useState } from 'react'
import { TooltipButton } from '@/components/Tooltip'
import { CopyButton } from '@/components/CopyButton'
import { BranchIcon, RewindIcon } from '@/components/icons'
import { absoluteTime, clockTime } from '@/lib/time'
import { formatShortcut } from '@/lib/shortcuts'
import { REMOTE_UNAVAILABLE } from '@/stores/hostRefusals'
import { useChatStore } from '@/stores/chat'
import { branchMessageForItem, useRewindToEntry } from '../rewind'
import { useRewindAvailable } from '../hostRewind'
import { ChatImage } from '../ChatImage'
import { UserText } from '../UserText'
import { USER_BUBBLE_CLASS } from '../userBubble'
import { useChatUiStore } from '../uiState'
import type { UserItem } from '../reducer'
import { SEGMENT } from '../transcriptFind'

/** Rewind / fork / copy plus the turn's clock time, under the bubble. */
function TurnMetaRow({
  item,
  sessionId,
}: {
  item: UserItem
  sessionId: string
}): React.JSX.Element {
  const unavailable = !useRewindAvailable(sessionId)
  const rewindToEntry = useRewindToEntry()
  const [busy, setBusy] = useState(false)

  const rewind = async (): Promise<void> => {
    if (unavailable) return
    setBusy(true)
    try {
      // `item.id` is a client-side counter (see `newItemId`), not pi's entry
      // id, so the entry is looked up on the current branch — by timestamp,
      // never by position (see `currentBranchUserMessages`).
      const target = await branchMessageForItem(sessionId, item)
      if (!target) {
        useChatStore.getState().setError(sessionId, 'Could not locate this message to rewind.')
        return
      }
      await rewindToEntry(sessionId, target.entryId, target.images)
    } finally {
      setBusy(false)
    }
  }

  /*
   * The clock time is always shown and the actions are not: the hour is what a
   * reader wants without hunting for it, and on a phone's chat there is no
   * hover to wait for. The actions belong to the turn you chose deliberately,
   * so they stay on hover. `h-4` in both states, so revealing them cannot nudge
   * the transcript. See the file header for the date/time rules.
   */
  return (
    <div className="flex h-4 items-center gap-1.5">
      <div className="flex items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
        {(item.text || item.images?.length) && !item.optimistic && (
          <TooltipButton
            onClick={() => void rewind()}
            disabled={busy || unavailable}
            title={unavailable ? REMOTE_UNAVAILABLE : 'Rewind to here'}
            className="text-text-tertiary hover:text-text flex items-center transition-colors disabled:opacity-50"
          >
            <RewindIcon size={12} />
          </TooltipButton>
        )}
        <TooltipButton
          disabled={unavailable}
          onClick={() => {
            if (!unavailable) useChatUiStore.getState().openForkPicker(sessionId)
          }}
          title={
            unavailable
              ? REMOTE_UNAVAILABLE
              : `Rewind to an earlier message… (${formatShortcut('Esc Esc')})`
          }
          className="text-text-tertiary hover:text-text flex items-center transition-colors"
        >
          <BranchIcon size={12} />
        </TooltipButton>
        {item.text && <CopyButton text={item.text} size="sm" />}
      </div>
      {item.timestamp != null && (
        <span
          className="text-text-tertiary text-sm leading-none tabular-nums"
          data-tooltip={absoluteTime(item.timestamp)}
        >
          {clockTime(item.timestamp)}
        </span>
      )}
    </div>
  )
}

/**
 * A turn the person sent: the bubble, and the affordances under it.
 *
 * Extracted from `MessageItem.tsx` because that file had grown into every row
 * type at once and had reached its size ceiling; the user row is the one piece
 * here with behaviour of its own (rewind, fork, the turn's time).
 */
export function UserMessage({
  item,
  sessionId,
}: {
  item: UserItem
  sessionId: string
}): React.JSX.Element {
  return (
    <div className="group flex flex-col items-end gap-1">
      {item.images && item.images.length > 0 && (
        <div className="flex flex-wrap justify-end gap-2">
          {item.images.map((img, i) => (
            <ChatImage key={i} image={img} className="max-h-40 rounded-lg" />
          ))}
        </div>
      )}
      {item.text && (
        // Wrapping long tokens is the bubble class's job; see USER_BUBBLE_CLASS.
        <div
          data-testid="user-message"
          data-find-segment={SEGMENT.body}
          className={USER_BUBBLE_CLASS}
        >
          <UserText text={item.text} />
        </div>
      )}
      <TurnMetaRow item={item} sessionId={sessionId} />
    </div>
  )
}
