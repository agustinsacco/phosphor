import {
  useRemoteLanesStore,
  canControlSession,
  REMOTE_NOT_READY,
  REMOTE_UNAVAILABLE,
} from '@/stores/remoteLanes'
import { hostResourceKey } from '@shared/remote-host'
import { TooltipButton } from '@/components/Tooltip'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ImageContent } from '@shared/rpc'
import { useChatStore } from '@/stores/chat'
import { QueueChips } from './composer/QueueChips'
import { ModelPicker } from './composer/ModelPicker'
import { ContextMeter } from './composer/ContextMeter'
import { ContinueButton } from './composer/ContinueButton'
import { ContextSourcesMenu } from './composer/ContextSourcesMenu'
import { namedProvider } from './composer/ModelChip'
import { submitBehavior } from './composer/submitBehavior'
import { buildCommandEntries, type NativeCommand } from './composer/CommandMenu'
import { useSlashMenu } from './composer/useSlashMenu'
import { RetryStrip } from './RetryStrip'
import { recallNext, recallPrevious } from './promptHistory'
import { AgentLaunchStrip, WorkingIndicator } from './WorkingIndicator'
import { BackgroundWorkIndicator } from './BackgroundWorkIndicator'
import { BootingIndicator, useSessionBooting } from './BootingIndicator'
import { Spinner } from '@/components/icons'
import { StopIconButton, SubmitIconButton } from '@/components/ComposerButtons'
import { useChatUiStore } from './uiState'
import { WidgetSlot } from '@/features/extension-ui/ExtensionUiHosts'
import { exportSessionHtml, renameSession } from '@/features/sessions/sessionActions'
import { piCallAccepted, piCallOk } from '@/lib/rpc'
import { formatShortcut } from '@/lib/shortcuts'
import {
  composePrompt,
  remotePromptAttachments,
  fromImageContents,
  toImageContents,
  type PendingAttachment,
} from './attachments'
import { ComposerInput } from './composer/ComposerInput'
import { sessionDraftKey, useDraftsStore } from '@/stores/drafts'
import { refreshSessionCommands, useSessionsStore } from '@/stores/sessions'
import { useWritingStore } from '@/stores/writing'
import { ipcErrorText } from '@shared/errors'

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
  const entry = useSessionsStore((s) => s.live[sessionId])
  const remote = entry?.target?.kind === 'remote'
  const host = useRemoteLanesStore((s) =>
    entry?.target?.kind === 'remote' ? s.hosts[entry.target.hostId] : undefined,
  )
  const disconnected = remote && host?.state !== 'ready'
  const remoteAttachments =
    remote &&
    host?.state === 'ready' &&
    host.capabilities.includes('workspaces.write') &&
    host.capabilities.includes('sessions.control') &&
    canControlSession(sessionId)
  const uploading = useRef(false)
  const draftKey =
    entry?.target?.kind === 'remote' && entry.laneId
      ? hostResourceKey(entry.target, 'session', entry.laneId)
      : sessionDraftKey(diskPath, sessionId)
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
  // typed in the first moments is filed under the phosphorId. Move it rather than
  // stranding it under a key nothing will read again.
  const previousKey = useRef(draftKey)
  useEffect(() => {
    if (previousKey.current !== draftKey) {
      useDraftsStore.getState().rekey(previousKey.current, draftKey)
      previousKey.current = draftKey
    }
  }, [draftKey])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  /** ↑/↓ prompt recall: offset from the newest prompt, null = live draft. */
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const draftRef = useRef('')
  /** Timestamp of the last bare Escape, for Claude Code's Esc-Esc rewind. */
  const lastEscapeRef = useRef(0)
  const isStreaming = useChatStore((s) => s.sessions[sessionId]?.isStreaming ?? false)
  const booting = useSessionBooting(sessionId)
  const isCompacting = useChatStore((s) => s.sessions[sessionId]?.isCompacting ?? false)
  // Named in the status strip only when pi does not ship the provider: the
  // chip shows the model name alone, and two providers can offer one name.
  const provider = namedProvider(useChatStore((s) => s.sessions[sessionId]?.meta?.model?.provider))
  const piCommands = useChatStore((s) => s.sessions[sessionId]?.commands) ?? []

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
      ...(!remote
        ? [
            {
              name: 'export',
              description: 'Export this session as HTML',
              run: () => void exportSessionHtml(sessionId),
            },
          ]
        : []),
      {
        name: 'name',
        description: 'Rename this session',
        run: () => void renameSession(sessionId),
      },
    ],
    [sessionId, remote],
  )

  const commandEntries = useMemo(
    () => buildCommandEntries(piCommands, nativeCommands),
    [piCommands, nativeCommands],
  )
  const slash = useSlashMenu({
    entries: commandEntries,
    setText,
    // The session's list was fetched at bootstrap; `/mcp reconnect` since then
    // may have registered prompt commands it does not have. Throttled inside.
    onOpen: () => void refreshSessionCommands(sessionId),
    focus: () => textareaRef.current?.focus(),
  })

  const send = useCallback(
    async (behavior?: 'steer' | 'followUp') => {
      if (!canControlSession(sessionId)) return
      const message = text.trim()
      if ((!message && images.length === 0) || uploading.current) return

      const chat = useChatStore.getState()

      if (remote && message.startsWith('!')) {
        chat.setError(sessionId, REMOTE_UNAVAILABLE)
        return
      }

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
          const response = await window.phosphor.piCommand(sessionId, {
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
            output: ipcErrorText(error),
            exitCode: -1,
            running: false,
          })
        }
        return
      }

      // Remote sends await uploads and receipts while the next draft stays editable.
      const submitted = remote
        ? images.map((a) => ({
            ...a,
            draftAttachmentId: a.draftAttachmentId ?? crypto.randomUUID(),
          }))
        : images
      const submittedIds = new Set(submitted.map((a) => a.draftAttachmentId))
      let textEdited = false
      const unsubscribe = remote
        ? useDraftsStore.subscribe((next, previous) => {
            if (next.drafts[draftKey]?.text !== previous.drafts[draftKey]?.text) textEdited = true
          })
        : () => undefined
      if (remote) setImages(submitted)
      let consumed = false
      const finishRemoteDraft = (success: boolean) => {
        if (!remote) return
        const current = useDraftsStore.getState().get(draftKey)
        useDraftsStore.getState().patch(draftKey, {
          ...(success && !textEdited ? { text: '' } : {}),
          attachments: current.attachments.filter(
            (a) =>
              !submittedIds.has(a.draftAttachmentId) ||
              (!success && !(consumed && a.kind === 'file' && a.data !== undefined)),
          ),
        })
      }
      const imagePayload: ImageContent[] = toImageContents(submitted)
      // Non-image attachments ride along as paths in the prompt: pi's protocol
      // has no document type, so the agent opens them with its own tools.
      let messageWithFiles: string
      try {
        if (remote && images.length && !remoteAttachments)
          throw new Error('Attachment upload unavailable.')
        uploading.current = true
        const attached = remote
          ? await remotePromptAttachments(submitted, (files) => {
              consumed = true
              return window.phosphor.invoke('hosts:uploadAttachments', sessionId, files)
            })
          : images
        messageWithFiles = composePrompt(message, attached)
      } catch (error) {
        finishRemoteDraft(false)
        chat.setError(sessionId, ipcErrorText(error))
        unsubscribe()
        uploading.current = false
        return
      }

      if (!remote) useDraftsStore.getState().clear(draftKey)
      setAttachWarning(null)
      slash.close()
      setHistoryIndex(null)

      // Local idle prompts render now; remote prompts wait for the Host echo,
      // which can arrive before the receipt. A steer or follow-up does not:
      // pi holds it in a queue (shown as a chip) and the reducer appends the
      // bubble at its `message_end`, where pi actually delivered it. Drawing it
      // at send time put it above work the agent did before reading it, so a
      // follow-up looked like a steer and an aborted queue showed it twice.
      if (!remote && !isStreaming) {
        chat.addUserMessage(
          sessionId,
          messageWithFiles,
          imagePayload.length ? imagePayload : undefined,
        )
      }

      try {
        const accepted = await piCallAccepted(sessionId, {
          type: 'prompt',
          message: messageWithFiles,
          ...(imagePayload.length ? { images: imagePayload } : {}),
          ...(isStreaming ? { streamingBehavior: behavior ?? 'steer' } : {}),
        })
        // A refused prompt keeps a remote draft and its attachments for another try.
        if (!accepted) {
          finishRemoteDraft(false)
          return
        }
        finishRemoteDraft(true)
        // Only once pi took it, so a failed send typed again is not learned twice.
        useWritingStore.getState().recordPrompt(message)
        // An extension command consumed it: no run starts, so no event will
        // ever clear the booting strip or confirm the bubble.
        if (accepted.data?.disposition === 'handled') {
          chat.promptHandled(sessionId, messageWithFiles)
        }
      } catch (error) {
        finishRemoteDraft(false)
        // IPC-level rejections (a dead process or an outdated provider) land here.
        chat.setError(sessionId, ipcErrorText(error))
      } finally {
        unsubscribe()
        uploading.current = false
      }
    },
    [sessionId, text, images, isStreaming, draftKey, remote, remoteAttachments, setImages],
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
      chat.setError(sessionId, ipcErrorText(error))
    }
  }, [sessionId, draftKey, setText])

  /** Popup navigation is shared; session history is handled here. */
  const handleKeyDownFirst = (event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
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
    if (!remote && now - lastEscapeRef.current < DOUBLE_ESCAPE_MS) {
      event.preventDefault()
      lastEscapeRef.current = 0
      useChatUiStore.getState().openForkPicker(sessionId)
      return
    }
    lastEscapeRef.current = now
  }

  /*
   * Everything that does not read the draft is built once per session, so a
   * keystroke re-renders the field and not every strip around it. React bails
   * out of an element it has seen before, and these subscribe to the chat
   * store themselves; while a turn streams, re-rendering them on every key
   * competed with the transcript for the same frames.
   */
  const modelPicker = useMemo(() => <ModelPicker sessionId={sessionId} />, [sessionId])
  const continueButton = useMemo(() => <ContinueButton sessionId={sessionId} />, [sessionId])
  const readouts = useMemo(
    () => (
      <>
        <ContextMeter sessionId={sessionId} />
        {!remote && <ContextSourcesMenu workspacePath={workspacePath} sessionId={sessionId} />}
      </>
    ),
    [sessionId, workspacePath, remote],
  )

  const placeholder = isStreaming
    ? `Steer with Enter · queue follow-up with ${formatShortcut('alt', 'Enter')} · Esc to stop`
    : booting
      ? 'Starting pi…'
      : 'Describe a task…'

  return (
    <div className="shrink-0 px-3 pb-4 pt-1 sm:px-5">
      <ComposerStrips sessionId={sessionId} />

      {disconnected && <p className="mx-auto max-w-3xl text-sm">{REMOTE_NOT_READY}</p>}
      <fieldset
        disabled={remote && !canControlSession(sessionId)}
        className="relative mx-auto min-w-0 max-w-3xl"
      >
        <ComposerInput
          workspacePath={workspacePath}
          remoteAttachments={remoteAttachments}
          value={text}
          textareaRef={textareaRef}
          onChange={(value) => {
            setText(value)
            setHistoryIndex(null)
          }}
          onSubmit={(event) => void send(submitBehavior(event))}
          onKeyDown={handleKeyDownFirst}
          onKeyDownFallthrough={handleKeyDownLast}
          autocomplete={historyIndex === null}
          placeholder={placeholder}
          attachments={images}
          onAttachmentsChange={setImages}
          onWarning={setAttachWarning}
          slash={slash}
          swarm={remote ? { enabled: false, onChange: () => undefined } : { sessionId }}
          scopeStatus={
            isCompacting && (
              <span className="text-text-secondary flex items-center gap-1.5 px-1 text-base">
                <Spinner /> compacting…
              </span>
            )
          }
          modelPicker={modelPicker}
          actions={
            <div className="flex shrink-0 items-center gap-0.5">
              {booting && !isStreaming && <Spinner />}
              {continueButton}
              <span className="bg-border mx-0.5 h-4 w-px shrink-0" aria-hidden="true" />
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
          }
        >
          {/* Only while a turn is running AND there is something to send: an
              always-present disabled row cost every reader a line of chrome
              for a control they could not use. */}
          {isStreaming && (text.trim() !== '' || images.length > 0) && (
            <div
              className="flex flex-wrap justify-end gap-1 px-2.5 pb-1"
              role="group"
              aria-label="Send to running agent"
            >
              <TooltipButton
                type="button"
                onClick={() => {
                  void send('steer')
                  textareaRef.current?.focus()
                }}
                title="Steer the current turn (Enter)"
                className="text-text-secondary hover:bg-bg-secondary hover:text-text min-h-7 rounded-md px-2 text-base"
              >
                Steer now
              </TooltipButton>
              <TooltipButton
                type="button"
                onClick={() => {
                  void send('followUp')
                  textareaRef.current?.focus()
                }}
                title={`Queue after this turn (${formatShortcut('alt', 'Enter')})`}
                className="text-text-secondary hover:bg-bg-secondary hover:text-text min-h-7 rounded-md px-2 text-base"
              >
                Queue follow-up
              </TooltipButton>
            </div>
          )}
        </ComposerInput>

        {attachWarning && (
          <div className="text-warning px-2 pt-1.5 text-base" role="alert">
            {attachWarning}
          </div>
        )}
        {/* The status strip: every readout, one line under the box, each
            opening the popover it always had. A draft starting with `!` takes
            the line over to explain itself; an empty field lends its right
            end to the cheat sheet that used to crowd the placeholder. */}
        <div className="text-text-tertiary @container flex min-h-6 flex-wrap items-center gap-x-3 gap-y-0.5 px-2 pt-1.5 text-sm">
          {!remote && text.startsWith('!') ? (
            <span className="text-text-secondary">
              <span className="font-mono">!cmd</span> runs in your shell and enters context on the
              next prompt · <span className="font-mono">!!cmd</span> keeps the output out of context
            </span>
          ) : (
            <>
              {readouts}
              {provider && (
                <span className="truncate font-mono" data-tooltip={`Served by ${provider}`}>
                  {provider}
                </span>
              )}
              {/* Yields before it wraps: it fills what the readouts leave and
                  truncates, and a strip narrower than 36rem drops it. */}
              {!remote && text === '' && !isStreaming && (
                <span className="@xl:inline ml-auto hidden min-w-0 flex-1 basis-0 truncate text-right">
                  <span className="font-mono">/</span> commands ·{' '}
                  <span className="font-mono">@</span> files · <span className="font-mono">!</span>{' '}
                  shell
                </span>
              )}
            </>
          )}
        </div>
        <BelowEditorWidgets sessionId={sessionId} />
      </fieldset>
    </div>
  )
}

/**
 * The status strips above the field. Memoised on the session id: they read
 * the chat store directly, so the draft changing is never a reason to render
 * them again.
 */
const ComposerStrips = memo(function ComposerStrips({
  sessionId,
}: {
  sessionId: string
}): React.JSX.Element {
  return (
    <>
      <WorkingIndicator sessionId={sessionId} />
      <BootingIndicator sessionId={sessionId} />
      <BackgroundWorkIndicator sessionId={sessionId} />
      <AgentLaunchStrip sessionId={sessionId} />
      <RetryStrip sessionId={sessionId} />
      <WidgetSlot sessionId={sessionId} placement="aboveEditor" />
      <QueueChips sessionId={sessionId} />
    </>
  )
})

const BelowEditorWidgets = memo(function BelowEditorWidgets({
  sessionId,
}: {
  sessionId: string
}): React.JSX.Element {
  return <WidgetSlot sessionId={sessionId} placement="belowEditor" />
})

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
 * without Phosphor persisting anything of its own.
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
