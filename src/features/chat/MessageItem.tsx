import { memo, useEffect, useState } from 'react'
import clsx from 'clsx'
import type { AssistantBlock, AssistantItem, CustomItem, ToolState, UserItem } from './reducer'
import { Markdown } from '@/components/markdown/Markdown'
import { useSmoothedText } from './useSmoothedText'
import { CopyButton } from '@/components/CopyButton'
import { PiSpark } from '@/components/PiSpark'
import { absoluteTime, relativeTime } from '@/lib/time'
import { useChatStore } from '@/stores/chat'
import { useChatUiStore } from './uiState'
import { formatShortcut } from '@/lib/shortcuts'
import { entryIdForUserMessageOrdinal, rewindToEntry } from './rewind'
import { ActivityGroup } from './items/ActivityGroup'
import { ChatImage } from './ChatImage'
import { UserText } from './UserText'
import type { TranscriptRow } from './items/transcriptRows'
import { RunCommandRow } from '@/components/RunCommandRow'
import { matchErrorRemedy } from './errorRemedies'
import { parseErrorMessage, type ParsedError } from './errorMessage'
import { useActiveWorkspace } from '@/stores/workspaces'
import { BranchIcon, RewindIcon } from '@/components/icons'
import { BashExecution } from './items/BashExecution'
import { Divider } from './items/Divider'

interface MessageItemProps {
  row: TranscriptRow
  tools: Record<string, ToolState>
  hideThinking: boolean
  sessionId: string
  activityActive?: boolean
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
          // Only reached for an empty streaming turn (spinner placeholder).
          return (
            <div className="py-1">
              <PiSpark />
            </div>
          )
        case 'bash':
          return <BashExecution item={row.item} />
        case 'divider':
          return <Divider item={row.item} />
        case 'custom':
          return <CustomMessageItem item={row.item} />
      }
  }
})

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
            title="This message is included in the model's context"
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
      {item.text && <Markdown text={item.text} />}
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
      // The ordinal is computed from the currently rendered items rather
      // than carried on the item itself: `item.id` is a client-side counter
      // (see `newItemId`), not pi's own entry id, so it can't be sent to pi
      // directly. Non-optimistic user items map 1:1, in order, onto
      // `get_fork_messages`'s list — both come from the same on-disk entries.
      const items = useChatStore.getState().sessions[sessionId]?.items ?? []
      let ordinal = -1
      for (const it of items) {
        if (it.kind !== 'user' || it.optimistic) continue
        ordinal++
        if (it.id === item.id) break
      }
      const entryId = ordinal >= 0 ? await entryIdForUserMessageOrdinal(sessionId, ordinal) : null
      if (!entryId) {
        useChatStore.getState().setError(sessionId, 'Could not locate this message to rewind.')
        return
      }
      await rewindToEntry(sessionId, entryId, item.images)
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
        /*
         * `break-words` is not optional, and it lives HERE rather than on the
         * spans inside `UserText` because `overflow-wrap` inherits: one rule
         * covers the plain text, the list items, and anything added later.
         * Without it a pasted URL or token is one unbreakable word, so
         * `max-w-[85%]` caps the BOX while the text paints straight through
         * it — out of the bubble, past the column, and into a horizontal
         * scrollbar under the whole transcript (the scroller's `overflow-y`
         * makes its `overflow-x` `auto`). Same failure as the wide-image cap
         * in ChatImage, one axis over.
         */
        <div
          data-testid="user-message"
          className="bg-user-bubble max-w-[85%] break-words rounded-xl px-4 py-2.5 text-lg"
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
          <button
            onClick={() => void rewind()}
            disabled={busy}
            title="Rewind to here"
            className="text-text-tertiary hover:text-text flex items-center transition-colors disabled:opacity-50"
          >
            <RewindIcon size={12} />
          </button>
        )}
        <button
          onClick={() => useChatUiStore.getState().openForkPicker(sessionId)}
          title={`Rewind to an earlier message… (${formatShortcut('Esc Esc')})`}
          className="text-text-tertiary hover:text-text flex items-center transition-colors"
        >
          <BranchIcon size={12} />
        </button>
        {item.text && <CopyButton text={item.text} size="sm" />}
        {item.timestamp != null && (
          <span
            className="text-text-tertiary text-sm leading-none"
            title={absoluteTime(item.timestamp)}
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
      <div className={clsx(streamingTail && 'streaming-tail')}>
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
 * and for configuration failures that no command can fix (Bedrock's
 * account-level data retention mode) a docs link plus a pointer at the model
 * menu, which is the actual workaround.
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
      <span className="text-text-secondary"> — {parsed.text}</span>
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
      <button
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-expanded={open}
        className="text-text-tertiary hover:text-text-secondary text-sm transition-colors"
      >
        {open ? 'Hide' : 'Show'} provider response
        {!open && facts.length > 0 && (
          <span className="text-text-tertiary/70"> · {facts.join(' · ')}</span>
        )}
      </button>
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
