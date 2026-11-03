import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { PopupMenu, MenuRow } from '@/components/PopupMenu'
import { TooltipButton } from '@/components/Tooltip'
import { LinkIcon, SlackIcon } from '@/components/icons'
import { useChatStore } from '@/stores/chat'
import { useSessionsStore } from '@/stores/sessions'
import { composerDraftKey, useDraftsStore } from '@/stores/drafts'
import { slackThreadsInTranscript, type SlackThread } from './slackThread'

/**
 * Quick links to the Slack threads this lane has in context, beside the PR
 * pill. Hidden until the transcript mentions one.
 */
export function LaneSlackThreads({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const items = useChatStore((s) => s.sessions[sessionId]?.items)
  const threads = useMemo(() => slackThreadsInTranscript(items), [items])
  if (threads.length === 0) return null
  return <SlackPill sessionId={sessionId} threads={threads} />
}

function SlackPill({
  sessionId,
  threads,
}: {
  sessionId: string
  threads: SlackThread[]
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const id = useId()
  const label = `${threads.length} Slack thread${threads.length === 1 ? '' : 's'} in context`
  const close = (restoreFocus = true): void => {
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }
  return (
    <div className="titlebar-no-drag relative shrink-0">
      <TooltipButton
        ref={triggerRef}
        type="button"
        tooltip={label}
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => (open ? close() : setOpen(true))}
        data-testid="lane-slack-threads"
        className="bg-chip border-border flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-xs font-semibold text-text-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <SlackIcon size={12} />
        {threads.length > 1 && <span>{threads.length}</span>}
      </TooltipButton>
      {open && (
        <PopupMenu
          id={id}
          triggerRef={triggerRef}
          onClose={close}
          fitViewport
          escapeContainer
          className="absolute left-0 top-full mt-1 w-80 py-2"
        >
          <ThreadList sessionId={sessionId} threads={threads} onClose={close} />
        </PopupMenu>
      )}
    </div>
  )
}

/** The popup's rows. Failures stay visible, and the popup open, so you can retry. */
function ThreadList({
  sessionId,
  threads,
  onClose,
}: {
  sessionId: string
  threads: SlackThread[]
  onClose: (restoreFocus?: boolean) => void
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const attempt = (work: Promise<void>, failure: string): void => {
    setError(null)
    work.then(() => onClose()).catch(() => setError(failure))
  }
  const reference = (thread: SlackThread): void => {
    addToDraft(sessionId, thread.url)
    onClose(false)
    // The composer is a sibling tree; its field is the one shared hook F6 also uses.
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>('[data-composer-input]')?.focus(),
    )
  }
  return (
    <FocusFirst>
      <p className="px-3 pb-1 text-xs text-text-tertiary">Slack threads in this lane</p>
      {threads.map((thread) => (
        <ThreadRow
          key={thread.key}
          thread={thread}
          onOpen={() =>
            attempt(
              window.phosphor.invoke('app:openExternal', thread.url),
              'Could not open Slack. Try again.',
            )
          }
          onCopy={() =>
            attempt(navigator.clipboard.writeText(thread.url), 'Could not copy the link.')
          }
          onReference={() => reference(thread)}
        />
      ))}
      {error && (
        <p role="alert" className="px-3 pt-1 text-sm text-danger">
          {error}
        </p>
      )}
    </FocusFirst>
  )
}

/** Moves focus into the popup on open, as the PR details do. */
function FocusFirst({ children }: { children: React.ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector('button')?.focus()
  }, [])
  return (
    <div ref={ref} role="region" aria-label="Slack threads in this lane">
      {children}
    </div>
  )
}

function ThreadRow({
  thread,
  onOpen,
  onCopy,
  onReference,
}: {
  thread: SlackThread
  onOpen: () => void
  onCopy: () => void
  onReference: () => void
}): React.JSX.Element {
  const name = `${thread.workspace} · ${when(thread.threadTs)}`
  return (
    <MenuRow
      active={false}
      onClick={onOpen}
      testId="slack-thread-open"
      title={`Open in Slack: ${thread.url}`}
      trailing={
        <span className="flex items-center gap-0.5">
          <RowAction label={`Add ${name} to message`} onClick={onReference}>
            @
          </RowAction>
          <RowAction label={`Copy link to ${name}`} onClick={onCopy}>
            <LinkIcon size={12} />
          </RowAction>
        </span>
      }
    >
      <span className="flex min-w-0 flex-col pr-8">
        <span className="truncate text-sm font-semibold">
          {name} <span aria-hidden="true">↗</span>
        </span>
        {thread.snippet && (
          <span className="truncate text-xs text-text-tertiary">{thread.snippet}</span>
        )}
      </span>
    </MenuRow>
  )
}

function RowAction({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <TooltipButton
      type="button"
      tooltip={label}
      aria-label={label}
      onClick={onClick}
      className="flex h-6 w-6 items-center justify-center rounded text-xs text-text-secondary hover:bg-bg-tertiary focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
    >
      {children}
    </TooltipButton>
  )
}

/** "Nov 2, 14:05" from a Slack `seconds.micros` timestamp. */
function when(ts: string): string {
  return new Date(Number(ts) * 1000).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Appends the link to the lane's unsent message, space-separated, never replacing it. */
export function addToDraft(sessionId: string, url: string): void {
  const key = composerDraftKey(useSessionsStore.getState().live[sessionId], sessionId)
  const drafts = useDraftsStore.getState()
  const text = drafts.get(key).text
  drafts.setText(key, `${text}${text && !/\s$/.test(text) ? ' ' : ''}${url} `)
}
