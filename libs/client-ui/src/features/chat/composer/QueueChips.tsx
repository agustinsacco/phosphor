import { useCanControlSession } from '@/features/sessions/useCanControlSession'
import { TAKE_CONTROL_FIRST } from '@/features/sessions/remoteLaneActions'
import { TooltipButton } from '@/components/Tooltip'
import { useChatStore } from '@/stores/chat'
import { unqueueMessage } from './queueActions'

/**
 * Pending steering / follow-up messages (from queue_update).
 *
 * A chip exists only while pi has not read that message yet, so each one is
 * undoable: the ✕ removes just that entry (see `unqueueMessage` — pi has no
 * per-entry command, so it is a drain and re-queue). The chip body is still
 * not a button; an earlier click handler only copied the text into the editor
 * while leaving it queued, which looked broken and could make users submit the
 * same instruction twice.
 */
export function QueueChips({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const queues = useChatStore((s) => s.sessions[sessionId]?.queues)
  if (!queues || (queues.steering.length === 0 && queues.followUp.length === 0)) return null

  return (
    <div
      className="mx-auto flex w-full max-w-3xl flex-wrap gap-1.5 px-1 pb-2"
      data-testid="queue-chips"
    >
      {queues.steering.map((text, i) => (
        <QueueChip key={`s-${i}`} kind="steer" text={text} sessionId={sessionId} index={i} />
      ))}
      {queues.followUp.map((text, i) => (
        <QueueChip key={`f-${i}`} kind="follow-up" text={text} sessionId={sessionId} index={i} />
      ))}
    </div>
  )
}

function QueueChip({
  kind,
  text,
  sessionId,
  index,
}: {
  kind: 'steer' | 'follow-up'
  text: string
  sessionId: string
  index: number
}): React.JSX.Element {
  // A Host lane's queue belongs to its controller.
  const blocked = !useCanControlSession(sessionId)
  const steer = kind === 'steer'
  return (
    <div
      data-tooltip={text || (steer ? 'Steering message queued' : 'Follow-up message queued')}
      className={
        steer
          ? 'bg-accent-soft text-accent border-accent/25 flex max-w-full items-center gap-1.5 rounded-full border py-1 pl-3 pr-2 text-base'
          : 'bg-info/10 text-info border-info/25 flex max-w-full items-center gap-1.5 rounded-full border py-1 pl-3 pr-2 text-base'
      }
    >
      <span className="shrink-0 text-xs font-semibold font-mono uppercase tracking-wide">
        {steer ? 'Steer queued' : 'Follow-up queued'}
      </span>
      {text && <span className="truncate">{text}</span>}
      <TooltipButton
        disabled={blocked}
        onClick={() => void unqueueMessage(sessionId, kind, index, text)}
        aria-label={steer ? 'Remove queued steering message' : 'Remove queued follow-up message'}
        title={blocked ? TAKE_CONTROL_FIRST : 'Remove — the agent has not read this yet'}
        className="shrink-0 rounded-full px-1 text-xs opacity-60 transition-opacity hover:opacity-100"
      >
        ✕
      </TooltipButton>
    </div>
  )
}
