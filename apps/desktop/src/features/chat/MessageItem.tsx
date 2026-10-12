import { TooltipButton } from '@/components/Tooltip'
import { memo, useEffect, useState } from 'react'
import clsx from 'clsx'
import type { AssistantBlock, AssistantItem, CustomItem, ToolState, UserItem } from './reducer'
import { Markdown } from '@/components/markdown/Markdown'
import { useSmoothedText } from './useSmoothedText'
import { CopyButton } from '@/components/CopyButton'
import { absoluteTime, relativeTime } from '@/lib/time'
import { useChatStore } from '@/stores/chat'
import { useChatUiStore } from './uiState'
import { formatShortcut } from '@/lib/shortcuts'
import { branchMessageForItem, rewindToEntry } from './rewind'
import { ActivityGroup } from './items/ActivityGroup'
import { ChatImage } from './ChatImage'
import { UserText } from './UserText'
import { USER_BUBBLE_CLASS } from './userBubble'
import type { TranscriptRow } from './items/transcriptRows'
import { RunCommandRow } from '@/components/RunCommandRow'
import { matchErrorRemedy } from './errorRemedies'
import { parseErrorMessage, type ParsedError } from './errorMessage'
import { useActiveWorkspace } from '@/stores/workspaces'
import { BranchIcon, RewindIcon } from '@/components/icons'
import { BashExecution } from './items/BashExecution'
import { Divider } from './items/Divider'
import { SubagentNoticeItem } from './items/SubagentNotice'
import { openSubagents } from './subagentView'
import { isSubagentNotice } from './subagentRuns'
import { recordedReply } from './subagentHistory'
import type { FindReveal } from './useTranscriptFind'
import { SEGMENT } from './transcriptFind'

interface MessageItemProps {
  row: TranscriptRow
  tools: Record<string, ToolState>
  hideThinking: boolean
  sessionId: string
  activityActive?: boolean
  /** Set on the row holding the current find hit: what to open to show it. */
  reveal?: FindReveal
}

/**
 * One transcript row. Rows come from `buildTranscriptRows`, which groups agent
 * activity across pi's message boundaries — so an `activity` row can span
 * several assistant messages, while prose and outcomes stay per-message.
 */
export const MessageItemView = memo(function MessageItemView({
  row,
  tools,
  hideThinking,
  sessionId,
  activityActive = false,
  reveal,
}: MessageItemProps): React.JSX.Element | null {
  switch (row.kind) {
    case 'activity':
      return (
        <ActivityGroup
          steps={row.steps}
          tools={tools}
          hideThinking={hideThinking}
          sessionId={sessionId}
          active={activityActive}
          reveal={reveal}
        />
      )
    case 'text':
      return <AssistantText item={row.item} block={row.block} isLastInItem={row.isLastInItem} />
    case 'outcome':
      return <AssistantOutcome item={row.item} />
    case 'item':
      switch (row.item.kind) {
        case 'user':
          return <UserMessage item={row.item} sessionId={sessionId} />
        case 'assistant':
          // Only reached for an empty streaming turn (reply placeholder).
          return <PendingReply />

        case 'bash':
          return <BashExecution item={row.item} />
        case 'divider':
          return <Divider item={row.item} />
        case 'custom':
          return isSubagentNotice(row.item.customType) ? (
            <InspectableSubagentNotice item={row.item} sessionId={sessionId} />
          ) : (
            <CustomMessageItem item={row.item} />
          )
      }
  }
})

function InspectableSubagentNotice({
  item,
  sessionId,
}: {
  item: CustomItem
  sessionId: string
}): React.JSX.Element {
  const tools = useChatStore((s) => s.sessions[sessionId]?.tools)
  return (
    <SubagentNoticeItem
      item={item}
      reply={recordedReply(item, [], tools)}
      onInspect={(runId) => openSubagents(sessionId, runId)}
    />
  )
}

/**
 * An assistant turn that exists but has produced nothing yet.
 *
 * Deliberately NOT a second Beacon. The Beacon is the run's identity and it is
 * already on screen in the composer strip, with the elapsed timer, the token
 * count and `Esc to stop` — two identical orbiting marks for one turn read as
 * two things loading. The division of labour is: the strip above the input
 * reports the PROCESS, the transcript holds a SEAT for the content.
 *
 * So the seat is the same blinking caret the streaming tail paints
 * (`.streaming-cursor`, pinned visible under reduced motion). When the first
 * token lands, prose grows from exactly where the caret sat instead of a
 * spinner being swapped out for text — and the same rule already applied to
 * running tools, whose label shimmers rather than adding a circle "competing
 * with the spark for attention" (see .tool-running-label in styles/index.css).
 */
function PendingReply(): React.JSX.Element {
  return (
    <div className="text-lg leading-relaxed" data-testid="pending-reply" role="status">
      <span className="sr-only">Waiting for a response</span>
      <span className="streaming-cursor" aria-hidden="true" />
    </div>
  )
}

/** Extension-injected message; badged when it also reaches the LLM. */
function CustomMessageItem({ item }: { item: CustomItem }): React.JSX.Element {
  return (
    <div className="border-info/30 bg-info/5 rounded-lg border border-dashed px-3.5 py-2.5">
      <div className="mb-1 flex items-center gap-1.5">
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="text-info shrink-0"
        >
          <path d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
        </svg>
        <span className="text-info text-xs font-semibold font-mono uppercase tracking-wide">
          {item.customType ? `Extension · ${item.customType}` : 'Extension message'}
        </span>
        {item.inContext && (
          <span
            className="bg-info/15 text-info rounded px-1.5 py-px text-2xs font-medium"
            data-tooltip="This message is included in the model's context"
          >
            in context
          </span>
        )}
      </div>
      {item.images && item.images.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-2">
          {item.images.map((img, i) => (
            <ChatImage key={i} image={img} className="max-h-32 rounded-md" />
          ))}
        </div>
      )}
      {item.text && (
        <div data-find-segment={SEGMENT.body}>
          <Markdown text={item.text} />
        </div>
      )}
    </div>
  )
}

function UserMessage({
  item,
  sessionId,
}: {
  item: UserItem
  sessionId: string
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)

  const rewind = async (): Promise<void> => {
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

      {/*
       * Bottom-right meta row, revealed on hover: copy, rewind (in-place,
       * via pi's own `fork` command), fork-from-here (the multi-message
       * picker), then the relative timestamp — zero layout height at rest,
       * so hover can never nudge the transcript.
       */}
      <div className="flex h-4 items-center gap-1.5 opacity-0 transition-opacity group-hover:opacity-100">
        {(item.text || item.images?.length) && !item.optimistic && (
          <TooltipButton
            onClick={() => void rewind()}
            disabled={busy}
            title="Rewind to here"
            className="text-text-tertiary hover:text-text flex items-center transition-colors disabled:opacity-50"
          >
            <RewindIcon size={12} />
          </TooltipButton>
        )}
        <TooltipButton
          onClick={() => useChatUiStore.getState().openForkPicker(sessionId)}
          title={`Rewind to an earlier message… (${formatShortcut('Esc Esc')})`}
          className="text-text-tertiary hover:text-text flex items-center transition-colors"
        >
          <BranchIcon size={12} />
        </TooltipButton>
        {item.text && <CopyButton text={item.text} size="sm" />}
        {item.timestamp != null && (
          <span
            className="text-text-tertiary text-sm leading-none"
            data-tooltip={absoluteTime(item.timestamp)}
          >
            {relativeTime(item.timestamp)}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * One assistant prose block, with the hover meta pill.
 *
 * The pill copies the WHOLE message's prose (not just this block), since that
 * is what a reader means by "copy the answer" when a turn interleaves text
 * with tool calls.
 */
function AssistantText({
  item,
  block,
  isLastInItem,
}: {
  item: AssistantItem
  block: Extract<AssistantBlock, { type: 'text' }>
  isLastInItem: boolean
}): React.JSX.Element {
  const fullText = item.blocks
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('\n\n')
  const streamingTail = item.streaming && isLastInItem && !block.closed
  // Paced reveal, not raw deltas: the Claude Code provider hands prose over
  // in ~100-char slabs half a second apart, and rendering each on arrival is
  // what made those turns land in harsh chunks. See useSmoothedText.
  const shownText = useSmoothedText(block.text, item.streaming && !block.closed)

  return (
    <div className="group/msg relative">
      <div data-find-segment={SEGMENT.body} className={clsx(streamingTail && 'streaming-tail')}>
        <Markdown text={shownText} streaming={item.streaming && !block.closed} />
      </div>

      {/*
       * Copy sits in the transcript's right GUTTER, not over the prose.
       *
       * It used to be a bordered pill ("⧉ Copy · 8/3/2026") at `-top-2 right-0`,
       * which landed squarely on the first line of every answer it belonged
       * to. The scroller's column carries 24px of padding on each side
       * (`px-6` in MessageList, with rows inset to the content box), so a 20px
       * button offset by 22px sits entirely inside that padding: it can never
       * cover a word, and it still cannot reflow the virtualized transcript
       * because it stays absolutely positioned.
       *
       * The timestamp moved into the tooltip. Shown inline it was the widest
       * thing in the affordance, and the user message it answers carries the
       * turn's time already.
       */}
      {!item.streaming && fullText && (
        <div className="pointer-events-none absolute -right-[22px] top-0 z-10 opacity-0 transition-opacity focus-within:pointer-events-auto focus-within:opacity-100 group-hover/msg:pointer-events-auto group-hover/msg:opacity-100">
          <CopyButton
            text={fullText}
            size="icon"
            title={
              item.timestamp != null
                ? `Copy message · ${absoluteTime(item.timestamp)}`
                : 'Copy message'
            }
          />
        </div>
      )}
    </div>
  )
}

/** How an assistant turn ended, when it did not end cleanly. */
function AssistantOutcome({ item }: { item: AssistantItem }): React.JSX.Element | null {
  if (item.stopReason === 'error') return <ErrorBlock message={item.errorMessage} />
  if (item.stopReason === 'aborted') {
    return (
      <div className="text-text-tertiary my-1 flex items-center gap-2.5 text-sm">
        <span className="bg-border h-px flex-1" />
        stopped
        <span className="bg-border h-px flex-1" />
      </div>
    )
  }
  return null
}

/**
 * Failed turn. When the message names a failure Phosphor knows the fix for, that
 * fix is offered inline instead of leaving the user to go find it: a runnable
 * command for the shell-fixable ones (expired AWS SSO token, missing pi login),
 * for configuration failures that no command can fix (Bedrock's account-level
 * data retention mode) a docs link plus a pointer at the model menu.
 */
export function ErrorBlock({ message }: { message?: string }): React.JSX.Element {
  const workspacePath = useActiveWorkspace()
  const [awsProfile, setAwsProfile] = useState<string | undefined>(undefined)

  useEffect(() => {
    void window.phosphor.invoke('app:userInfo').then((info) => setAwsProfile(info.awsProfile))
  }, [])

  // Match remedies against the raw text: some patterns ('data retention mode')
  // appear in fields the human sentence does not carry.
  const remedy = matchErrorRemedy(message, { awsProfile })
  const parsed = parseErrorMessage(message)

  return (
    <div className="bg-danger-soft border-danger/25 mt-2 rounded-lg border px-3.5 py-2.5 text-lg">
      <span className="text-danger font-medium">Error</span>
      <span className="text-text-secondary">
        {' — '}
        <span data-find-segment={SEGMENT.body}>{parsed.text}</span>
      </span>
      {parsed.unwrapped && <RawErrorDetails raw={message!} parsed={parsed} />}
      {remedy && (
        <>
          <div className="text-text-secondary mt-1.5 text-base leading-relaxed">{remedy.hint}</div>
          {remedy.command !== undefined && (
            <RunCommandRow
              command={remedy.command}
              label={remedy.label}
              workspacePath={workspacePath ?? undefined}
            />
          )}
          {(remedy.docsUrl || remedy.suggestModelSwitch) && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-base">
              {remedy.docsUrl && (
                <a
                  href={remedy.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent hover:underline"
                  data-tooltip="Open link"
                >
                  {remedy.label}
                </a>
              )}
              {remedy.suggestModelSwitch && (
                <span className="text-text-tertiary">
                  Switch models from the picker in the composer below.
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

/**
 * The provider payload we unwrapped, kept one click away.
 *
 * Hiding it entirely would be the easy version and the wrong one: the type and
 * request id are exactly what a provider asks for when you report a failure,
 * and they appear nowhere else in the app.
 */
function RawErrorDetails({ raw, parsed }: { raw: string; parsed: ParsedError }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const facts = [
    parsed.status !== undefined ? `HTTP ${parsed.status}` : undefined,
    parsed.type,
    parsed.requestId,
  ].filter((fact): fact is string => fact !== undefined)

  return (
    <div className="mt-1.5">
      <TooltipButton
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        tooltip={open ? 'Hide provider response' : 'Show provider response'}
        aria-expanded={open}
        className="text-text-tertiary hover:text-text-secondary text-sm transition-colors"
      >
        {open ? 'Hide' : 'Show'} provider response
        {!open && facts.length > 0 && (
          <span className="text-text-tertiary/70"> · {facts.join(' · ')}</span>
        )}
      </TooltipButton>
      {open && (
        <div className="border-danger/20 mt-1.5 rounded-md border">
          <div className="border-danger/20 flex items-center justify-between border-b px-2 py-1">
            <span className="text-text-tertiary text-sm">{facts.join(' · ') || 'Response'}</span>
            <CopyButton text={raw} size="sm" />
          </div>
          <pre className="text-text-secondary max-h-48 overflow-auto whitespace-pre-wrap break-all px-2 py-1.5 font-mono text-sm leading-relaxed">
            {raw}
          </pre>
        </div>
      )}
    </div>
  )
}
