import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import type { ImageContent } from '@shared/rpc'
import { useChatStore } from '@/stores/chat'
import { fuzzyFilter } from '@/lib/fuzzy'
import { QueueChips } from './composer/QueueChips'
import { ModelPicker } from './composer/ModelPicker'
import { ContextMeter } from './composer/ContextMeter'
import { submitBehavior } from './composer/submitBehavior'
import {
  buildCommandEntries,
  CommandMenu,
  filterCommandEntries,
  type CommandEntry,
  type NativeCommand,
} from './composer/CommandMenu'
import { FileMentionMenu } from './composer/FileMentionMenu'
import { RetryStrip } from './RetryStrip'
import { recallNext, recallPrevious } from './promptHistory'
import { AgentLaunchStrip, WorkingIndicator } from './WorkingIndicator'
import { BootingIndicator, useSessionBooting } from './BootingIndicator'
import { Spinner } from '@/components/icons'
import { AttachButton, StopIconButton, SubmitIconButton } from '@/components/ComposerButtons'
import { useChatUiStore } from './uiState'
import { WidgetSlot } from '@/features/extension-ui/ExtensionUiHosts'
import { exportSessionHtml, renameSession } from '@/features/sessions/sessionActions'
import { piCallOk } from '@/lib/rpc'
import { formatShortcut } from '@/lib/shortcuts'
import {
  composePrompt,
  fromImageContents,
  toImageContents,
  type PendingAttachment,
} from './attachments'
import { AttachmentChips, DropOverlay } from './composer/AttachmentChips'
import { useAttachments } from './composer/useAttachments'
import { ComposerField } from './composer/ComposerField'
import { sessionDraftKey, useDraftsStore } from '@/stores/drafts'
import { useSessionsStore } from '@/stores/sessions'
import { errorText } from '@shared/errors'

interface MentionState {
  /** Index of the '@' in the textarea value. */
  anchor: number
  query: string
}

interface CommandState {
  query: string
}

export function Composer({
  sessionId,
  workspacePath,
}: {
  sessionId: string
  workspacePath: string
}): React.JSX.Element {
  /*
   * Draft state lives in the store, not in `useState`.
   *
   * `App` renders `<ChatView key={activeSessionId}>`, so switching session
   * unmounts this whole subtree — a local draft went with it, silently, along
   * with any pasted image. Keyed by the session's FILE path once we know it,
   * because that is the only identity that survives a restart; `rekey` below
   * moves the draft across when pi finally tells us the path.
   */
  const diskPath = useSessionsStore((s) => s.live[sessionId]?.diskPath)
  const draftKey = sessionDraftKey(diskPath, sessionId)
  const draft = useDraftsStore((s) => s.drafts[draftKey])
  const text = draft?.text ?? ''
  const images = draft?.attachments ?? EMPTY_ATTACHMENTS
  const setText = useCallback(
    (next: string) => useDraftsStore.getState().setText(draftKey, next),
    [draftKey],
  )
  const setImages = useCallback(
    (next: PendingAttachment[]) => useDraftsStore.getState().setAttachments(draftKey, next),
    [draftKey],
  )
  const [attachWarning, setAttachWarning] = useState<string | null>(null)

  // The file path arrives asynchronously (see `bootstrapSession`), so a draft
  // typed in the first moments is filed under the pidexId. Move it rather than
  // stranding it under a key nothing will read again.
  const previousKey = useRef(draftKey)
  useEffect(() => {
    if (previousKey.current !== draftKey) {
      useDraftsStore.getState().rekey(previousKey.current, draftKey)
      previousKey.current = draftKey
    }
  }, [draftKey])
  const [mention, setMention] = useState<MentionState | null>(null)
  const [command, setCommand] = useState<CommandState | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const [workspaceFiles, setWorkspaceFiles] = useState<string[]>([])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  /** ↑/↓ prompt recall: offset from the newest prompt, null = live draft. */
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const draftRef = useRef('')
  /** Timestamp of the last bare Escape, for Claude Code's Esc-Esc rewind. */
  const lastEscapeRef = useRef(0)
  const attachments = useAttachments({
    attachments: images,
    onChange: setImages,
    onReject: setAttachWarning,
  })
  const isStreaming = useChatStore((s) => s.sessions[sessionId]?.isStreaming ?? false)
  const booting = useSessionBooting(sessionId)
  const isCompacting = useChatStore((s) => s.sessions[sessionId]?.isCompacting ?? false)
  const piCommands = useChatStore((s) => s.sessions[sessionId]?.commands) ?? []

  // Lazy-load the workspace file index the first time an @-mention opens.
  const filesLoaded = useRef(false)
  useEffect(() => {
    if (mention && !filesLoaded.current) {
      filesLoaded.current = true
      void window.pidex.invoke('fs:listFiles', workspacePath).then(setWorkspaceFiles)
    }
  }, [mention, workspacePath])

  // Prefill from a rewind (edit-and-resend) or extension set_editor_text.
  // Attachments are REPLACED, not appended: the prefill restores one specific
  // message, so anything already staged belongs to a draft the rewind just
  // discarded.
  const prefill = useChatUiStore((s) => s.prefill[sessionId])
  useEffect(() => {
    if (prefill === undefined) return
    const restored = useChatUiStore.getState().consumePrefill(sessionId)
    if (restored === undefined) return
    setText(restored.text)
    if (restored.images?.length) setImages(fromImageContents(restored.images))
    textareaRef.current?.focus()
  }, [prefill, sessionId, setText, setImages])

  const nativeCommands = useMemo<NativeCommand[]>(
    () => [
      {
        name: 'compact',
        description: 'Compact conversation context now',
        run: () => void runCompact(sessionId),
      },
      {
        name: 'export',
        description: 'Export this session as HTML',
        run: () => void exportSessionHtml(sessionId),
      },
      {
        name: 'name',
        description: 'Rename this session',
        run: () => void renameSession(sessionId),
      },
    ],
    [sessionId],
  )

  const commandEntries = useMemo(
    () => buildCommandEntries(piCommands, nativeCommands),
    [piCommands, nativeCommands],
  )

  const mentionMatches = useMemo(
    () => (mention ? fuzzyFilter(mention.query, workspaceFiles, (f) => f, 12) : []),
    [mention, workspaceFiles],
  )
  const commandMatches = useMemo(
    () => (command ? filterCommandEntries(command.query, commandEntries) : []),
    [command, commandEntries],
  )

  const updateOverlays = (value: string, caret: number): void => {
    // '/' command menu: only when the input starts with '/' and has no spaces yet.
    if (value.startsWith('/') && !/\s/.test(value)) {
      setCommand({ query: value.slice(1) })
    } else {
      setCommand(null)
    }
    // '@' mention: the token containing the caret starts with '@'.
    const before = value.slice(0, caret)
    const atMatch = /(^|\s)@([^\s@]*)$/.exec(before)
    if (atMatch) {
      setMention({ anchor: caret - atMatch[2]!.length - 1, query: atMatch[2]! })
    } else {
      setMention(null)
    }
    setActiveIndex(0)
  }

  const send = useCallback(
    async (behavior?: 'steer' | 'followUp') => {
      const message = text.trim()
      if (!message && images.length === 0) return

      const chat = useChatStore.getState()

      // `!command` / `!!command` → RPC bash execution.
      if (message.startsWith('!') && !isStreaming) {
        const exclude = message.startsWith('!!')
        const shellCommand = message.slice(exclude ? 2 : 1).trim()
        if (!shellCommand) return
        useDraftsStore.getState().clear(draftKey)
        const itemId = chat.addBashItem(sessionId, {
          command: shellCommand,
          output: '',
          exitCode: null,
          running: true,
          truncated: false,
          excludeFromContext: exclude,
        })
        try {
          // Deliberately raw rather than `piCall` (CLAUDE.md fact 3): a failed
          // `!command` belongs in the bash item's own output next to the
          // command that produced it, not on the session-wide error surface.
          const response = await window.pidex.piCommand(sessionId, {
            type: 'bash',
            command: shellCommand,
            excludeFromContext: exclude,
          })
          if (response.success && response.data) {
            chat.updateBashItem(sessionId, itemId, {
              output: response.data.output,
              exitCode: response.data.exitCode,
              running: false,
              truncated: response.data.truncated,
              fullOutputPath: response.data.fullOutputPath,
            })
          } else if (!response.success) {
            chat.updateBashItem(sessionId, itemId, {
              output: response.error,
              exitCode: -1,
              running: false,
            })
          }
        } catch (error) {
          chat.updateBashItem(sessionId, itemId, {
            output: errorText(error),
            exitCode: -1,
            running: false,
          })
        }
        return
      }

      const imagePayload: ImageContent[] = toImageContents(images)
      // Non-image attachments ride along as paths in the prompt: pi's protocol
      // has no document type, so the agent opens them with its own tools.
      const messageWithFiles = composePrompt(message, images)

      useDraftsStore.getState().clear(draftKey)
      setAttachWarning(null)
      setCommand(null)
      setMention(null)
      setHistoryIndex(null)

      // Only non-command prompts render as user bubbles immediately; extension
      // commands echo through the event stream if they produce messages.
      chat.addUserMessage(
        sessionId,
        messageWithFiles,
        imagePayload.length ? imagePayload : undefined,
      )

      try {
        await piCallOk(sessionId, {
          type: 'prompt',
          message: messageWithFiles,
          ...(imagePayload.length ? { images: imagePayload } : {}),
          ...(isStreaming ? { streamingBehavior: behavior ?? 'steer' } : {}),
        })
      } catch (error) {
        // `piCallOk` reports a rejected envelope; an IPC-level rejection (the
        // session's process died mid-send) still lands here.
        chat.setError(sessionId, errorText(error))
      }
    },
    [sessionId, text, images, isStreaming, draftKey],
  )

  const abort = useCallback(async () => {
    const chat = useChatStore.getState()
    const queues = chat.sessions[sessionId]?.queues
    const queuedText = [...(queues?.steering ?? []), ...(queues?.followUp ?? [])].join('\n')
    try {
      // An abort before pi ever started the run gets no agent event back, so
      // clear the booting state here or the strip waits forever.
      chat.clearPromptSent(sessionId)
      await piCallOk(sessionId, { type: 'abort' })
      // Escape semantics: restore queued messages into the composer.
      if (queuedText) {
        const current = useDraftsStore.getState().get(draftKey).text
        setText(current ? current + '\n' + queuedText : queuedText)
        textareaRef.current?.focus()
      }
    } catch (error) {
      chat.setError(sessionId, errorText(error))
    }
  }, [sessionId, draftKey, setText])

  const pickMention = (file: string): void => {
    if (!mention) return
    const after = text.slice(mention.anchor + 1 + mention.query.length)
    const next = text.slice(0, mention.anchor) + file + (after.startsWith(' ') ? '' : ' ') + after
    setText(next)
    setMention(null)
    textareaRef.current?.focus()
  }

  const pickCommand = (entry: CommandEntry): void => {
    setCommand(null)
    if (entry.native) {
      setText('')
      entry.native.run()
      return
    }
    // pi commands: prefill "/name " so the user can add arguments, or send on Enter.
    setText(`/${entry.name} `)
    textareaRef.current?.focus()
  }

  /** Runs before the field's own keymap; true means the key was consumed. */
  const handleKeyDownFirst = (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    // Popup navigation captures arrows/enter/escape while open.
    const popupItems = command ? commandMatches.length : mention ? mentionMatches.length : 0
    if (popupItems > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveIndex((i) => (i + 1) % popupItems)
        return true
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex((i) => (i - 1 + popupItems) % popupItems)
        return true
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault()
        if (command) {
          const entry = commandMatches[activeIndex]
          if (entry) pickCommand(entry)
        } else if (mention) {
          const file = mentionMatches[activeIndex]
          if (file) pickMention(file)
        }
        return true
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setCommand(null)
        setMention(null)
        return true
      }
    }

    // ↑/↓ recall earlier prompts (Claude Code's REPL history). Browsing starts
    // only from an empty composer and ends at the first keystroke (see the
    // textarea's onChange), so the arrows go back to moving the caret the
    // moment there is text of your own to move through.
    const plainArrow = !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey
    const browsing = historyIndex !== null
    if (plainArrow && event.key === 'ArrowUp' && (browsing || text === '')) {
      const recalled = recallPrevious(promptHistory(sessionId), historyIndex)
      if (!recalled) return false
      event.preventDefault()
      if (!browsing) draftRef.current = text
      setHistoryIndex(recalled.index)
      setText(recalled.text)
      return true
    }
    if (plainArrow && event.key === 'ArrowDown' && browsing) {
      const recalled = recallNext(promptHistory(sessionId), historyIndex, draftRef.current)
      if (!recalled) return false
      event.preventDefault()
      setHistoryIndex(recalled.index)
      setText(recalled.text)
      return true
    }

    return false
  }

  /** Runs for keys neither the popups nor the field's keymap claimed. */
  const handleKeyDownLast = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== 'Escape') return
    if (isStreaming) {
      event.preventDefault()
      lastEscapeRef.current = 0
      void abort()
      return
    }
    // Esc Esc → rewind, as in Claude Code. The first press is left alone so
    // it can still blur/close whatever else is listening.
    const now = Date.now()
    if (now - lastEscapeRef.current < DOUBLE_ESCAPE_MS) {
      event.preventDefault()
      lastEscapeRef.current = 0
      useChatUiStore.getState().openForkPicker(sessionId)
      return
    }
    lastEscapeRef.current = now
  }

  const placeholder = isStreaming
    ? `Steer with Enter · queue follow-up with ${formatShortcut('alt', 'Enter')} · Esc to stop`
    : booting
      ? 'Starting pi…  ( / commands · @ files · ! shell )'
      : 'Describe a task…  ( / commands · @ files · ! shell )'

  return (
    <div className="shrink-0 px-3 pb-4 pt-1 sm:px-5">
      <WorkingIndicator sessionId={sessionId} />
      <BootingIndicator sessionId={sessionId} />
      <AgentLaunchStrip sessionId={sessionId} />
      <RetryStrip sessionId={sessionId} />
      <WidgetSlot sessionId={sessionId} placement="aboveEditor" />
      <QueueChips sessionId={sessionId} />

      <div className="relative mx-auto max-w-3xl">
        {command && commandMatches.length > 0 && (
          <CommandMenu
            query={command.query}
            entries={commandEntries}
            activeIndex={activeIndex}
            onHover={setActiveIndex}
            onPick={pickCommand}
            onClose={() => setCommand(null)}
          />
        )}
        {mention && mentionMatches.length > 0 && (
          <FileMentionMenu
            files={mentionMatches}
            activeIndex={activeIndex}
            onHover={setActiveIndex}
            onPick={pickMention}
            onClose={() => setMention(null)}
          />
        )}

        <div
          onDragOver={attachments.handleDragOver}
          onDragLeave={attachments.handleDragLeave}
          onDrop={attachments.handleDrop}
          className={clsx(
            'bg-surface relative rounded-xl border shadow-sm transition-colors',
            attachments.dragging
              ? 'border-accent ring-accent/25 ring-2'
              : 'border-border hover:border-border-focus focus-within:border-border-focus',
          )}
        >
          <DropOverlay visible={attachments.dragging} />
          <AttachmentChips attachments={images} onRemove={attachments.remove} />

          <ComposerField
            value={text}
            textareaRef={textareaRef}
            onChange={(value, caret) => {
              setText(value)
              // Typing leaves history-browsing mode: the next ↑ starts again
              // from the newest prompt rather than from wherever it was.
              setHistoryIndex(null)
              updateOverlays(value, caret)
            }}
            onSubmit={(event) => {
              void send(submitBehavior(event))
            }}
            onKeyDown={handleKeyDownFirst}
            onKeyDownFallthrough={handleKeyDownLast}
            onPasteFiles={attachments.addFiles}
            placeholder={placeholder}
          />

          {isStreaming && (
            <div
              className="flex flex-wrap justify-end gap-1 px-2.5 pb-2"
              role="group"
              aria-label="Send to running agent"
            >
              <button
                type="button"
                disabled={!text.trim() && images.length === 0}
                onClick={() => {
                  void send('steer')
                  textareaRef.current?.focus()
                }}
                title="Steer the current turn (Enter)"
                className="text-text-secondary hover:bg-bg-secondary hover:text-text min-h-8 rounded-md px-2 text-base disabled:opacity-40"
              >
                Steer now
              </button>
              <button
                type="button"
                disabled={!text.trim() && images.length === 0}
                onClick={() => {
                  void send('followUp')
                  textareaRef.current?.focus()
                }}
                title={`Queue after this turn (${formatShortcut('alt', 'Enter')})`}
                className="text-text-secondary hover:bg-bg-secondary hover:text-text min-h-8 rounded-md px-2 text-base disabled:opacity-40"
              >
                Queue follow-up
              </button>
            </div>
          )}

          {/* Footer mirrors the reference: attach on the left, model +
              thinking + meter on the right, submit/stop as a quiet icon at
              the far right — never a filled pill. */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-2.5 pb-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <AttachButton onFiles={attachments.addFiles} />
              {isCompacting && (
                <span className="text-text-secondary flex items-center gap-1.5 px-1 text-base">
                  <Spinner /> compacting…
                </span>
              )}
            </div>

            <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-1.5">
              <ContextMeter sessionId={sessionId} />
              <ModelPicker sessionId={sessionId} />
              <div className="flex items-center gap-1.5">
                {/* Also while booting: the send button flipping back to its
                    idle self while pi is still starting is what made the
                    composer look like it had swallowed the prompt. */}
                {(isStreaming || booting) && <Spinner />}
                {isStreaming ? (
                  <StopIconButton onClick={() => void abort()} />
                ) : (
                  <SubmitIconButton
                    disabled={!text.trim() && images.length === 0}
                    onClick={() => void send()}
                    label="Send message"
                  />
                )}
              </div>
            </div>
          </div>
        </div>

        {attachWarning && (
          <div className="text-warning px-2 pt-1.5 text-base" role="alert">
            {attachWarning}
          </div>
        )}
        <div
          className={clsx(
            'text-text-secondary px-2 pt-1.5 text-base',
            !text.startsWith('!') && 'opacity-0',
          )}
        >
          <span className="font-mono">!cmd</span> runs in your shell and enters context on the next
          prompt · <span className="font-mono">!!cmd</span> keeps the output out of context
        </div>
        <WidgetSlot sessionId={sessionId} placement="belowEditor" />
      </div>
    </div>
  )
}

async function runCompact(sessionId: string): Promise<void> {
  await piCallOk(sessionId, { type: 'compact' })
}

/** Two Escapes inside this window count as the rewind chord, not two aborts. */
const DOUBLE_ESCAPE_MS = 600

/**
 * The prompts this session has already sent, oldest first.
 *
 * Read straight off the transcript rather than kept as a second list: every
 * send appends a user item (optimistically, before pi echoes it), so the
 * transcript is already the history — and a session resumed from disk has one
 * without pidex persisting anything of its own.
 */
function promptHistory(sessionId: string): string[] {
  const items = useChatStore.getState().sessions[sessionId]?.items ?? []
  const prompts: string[] = []
  for (const item of items) {
    if (item.kind !== 'user') continue
    const text = item.text.trim()
    // Consecutive duplicates (a retried prompt) would make ↑ look stuck.
    if (text && text !== prompts[prompts.length - 1]) prompts.push(text)
  }
  return prompts
}

/** Stable empty list: a fresh `[]` per render would remount the chip row. */
const EMPTY_ATTACHMENTS: PendingAttachment[] = []
