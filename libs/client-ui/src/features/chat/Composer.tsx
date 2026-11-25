import { useComposerSlash } from './useComposerSlash'
import { sendComposerPrompt } from './sendComposerPrompt'
import { offersLaneEditing } from './hostLaneEditing'
import { useRemoteLanesStore, canControlSession } from '@/stores/remoteLanes'
import { HostWaitNote, useRemoteLock } from '@/features/machines/HostWaitNote'
import { TooltipButton } from '@/components/Tooltip'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore } from '@/stores/chat'
import { ModelPicker } from './composer/ModelPicker'
import { ContextMeter } from './composer/ContextMeter'
import { ContinueButton } from './composer/ContinueButton'
import { ContextSourcesMenu } from './composer/ContextSourcesMenu'
import { namedProvider } from './composer/ModelChip'
import { submitBehavior } from './composer/submitBehavior'
import { promptHistory, recallNext, recallPrevious } from './promptHistory'
import { useSessionBooting } from './BootingIndicator'
import { ComposerStrips } from './ComposerStrips'
import { Spinner } from '@/components/icons'
import { StopIconButton, SubmitIconButton } from '@/components/ComposerButtons'
import { useChatUiStore } from './uiState'
import { WidgetSlot } from '@/features/extension-ui/ExtensionUiHosts'
import { stopRun } from './composer/queueActions'
import { formatShortcut } from '@/lib/shortcuts'
import { softKeyboard } from '@/lib/softKeyboard'
import { fromImageContents, type PendingAttachment } from './attachments'
import { ComposerInput } from './composer/ComposerInput'
import { composerDraftKey, useDraftsStore } from '@/stores/drafts'
import { useSessionsStore } from '@/stores/sessions'
import { ipcErrorText } from '@shared/errors'
import { createReceiptGuard } from './receiptGuard'
import { runShellCommand } from './composer/runShellCommand'
import {
  sessionTransitionPending,
  useSessionTransition,
} from '@/features/sessions/sessionTransition'
import { SessionTransitionBanner } from '@/features/sessions/SessionTransitionBanner'

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
  const entry = useSessionsStore((s) => s.live[sessionId])
  const remote = entry?.target?.kind === 'remote'
  const host = useRemoteLanesStore((s) =>
    entry?.target?.kind === 'remote' ? s.hosts[entry.target.hostId] : undefined,
  )
  const lock = useRemoteLock(sessionId)
  const transition = useSessionTransition((s) => s.bySession[sessionId])
  const resuming = useChatStore((s) => s.sessions[sessionId]?.resuming)
  const restoring = !!transition || !!resuming
  const remoteAttachments =
    remote &&
    host?.state === 'ready' &&
    host.capabilities.includes('workspaces.write') &&
    host.capabilities.includes('sessions.control') &&
    canControlSession(sessionId)
  const awaiting = useRef(createReceiptGuard())
  const draftKey = composerDraftKey(entry, sessionId)
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

  const slash = useComposerSlash(sessionId, piCommands, setText, () => textareaRef.current?.focus())

  const send = useCallback(
    async (behavior?: 'steer' | 'followUp') => {
      if (!canControlSession(sessionId) || sessionTransitionPending(sessionId)) return
      const message = text.trim()
      if (!message && images.length === 0) return

      // `!command` / `!!command` → RPC bash execution.
      if (message.startsWith('!') && !isStreaming) {
        const exclude = message.startsWith('!!')
        const shellCommand = message.slice(exclude ? 2 : 1).trim()
        if (!shellCommand) return
        useDraftsStore.getState().clear(draftKey)
        await runShellCommand(sessionId, shellCommand, exclude)
        return
      }

      setAttachWarning(null)
      slash.close()
      setHistoryIndex(null)
      await sendComposerPrompt(
        {
          sessionId,
          draftKey,
          remote,
          remoteAttachments,
          behavior: isStreaming ? (behavior ?? 'steer') : undefined,
        },
        awaiting.current,
      )
    },
    [sessionId, text, images, isStreaming, draftKey, remote, remoteAttachments],
  )

  const abort = useCallback(async () => {
    const chat = useChatStore.getState()
    try {
      // An abort before pi ever started the run gets no agent event back, so
      // clear the booting state here or the strip waits forever.
      chat.clearPromptSent(sessionId)
      // Escape semantics: queued messages come back into the composer.
      await stopRun(sessionId, (queuedText) => {
        const current = useDraftsStore.getState().get(draftKey).text
        setText(current ? current + '\n' + queuedText : queuedText)
        textareaRef.current?.focus()
      })
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
      const recalled = recallPrevious(
        promptHistory(useChatStore.getState().sessions[sessionId]?.items ?? []),
        historyIndex,
      )
      if (!recalled) return false
      event.preventDefault()
      if (!browsing) draftRef.current = text
      setHistoryIndex(recalled.index)
      setText(recalled.text)
      return true
    }
    if (plainArrow && event.key === 'ArrowDown' && browsing) {
      const recalled = recallNext(
        promptHistory(useChatStore.getState().sessions[sessionId]?.items ?? []),
        historyIndex,
        draftRef.current,
      )
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
    // Esc Esc → rewind; leave the first press alone.
    const now = Date.now()
    if ((!remote || offersLaneEditing(host)) && now - lastEscapeRef.current < DOUBLE_ESCAPE_MS) {
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
  const swarmTarget = useMemo(() => ({ sessionId }), [sessionId])
  const continueButton = useMemo(() => <ContinueButton sessionId={sessionId} />, [sessionId])
  const readouts = useMemo(
    () => (
      <>
        <ContextMeter sessionId={sessionId} />
        <ContextSourcesMenu workspacePath={workspacePath} sessionId={sessionId} />
      </>
    ),
    [sessionId, workspacePath],
  )

  // A soft keyboard has no Alt or Esc and its Return adds a line: name only what it can do.
  const placeholder = isStreaming
    ? softKeyboard()
      ? 'Steer or queue a follow-up…'
      : `Steer with Enter · queue follow-up with ${formatShortcut('alt', 'Enter')} · Esc to stop`
    : booting
      ? 'Starting pi…'
      : 'Describe a task…'

  return (
    <div className="composer shrink-0 px-3 pb-4 pt-1 sm:px-5">
      <ComposerStrips sessionId={sessionId} />

      <HostWaitNote sessionId={sessionId} className="mx-auto mb-1.5 max-w-3xl" />
      <SessionTransitionBanner sessionId={sessionId} />
      <fieldset
        {...lock}
        disabled={lock.disabled || restoring || (remote && booting)}
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
          swarm={swarmTarget}
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
              <span
                className="composer-divider bg-border mx-0.5 h-4 w-px shrink-0"
                aria-hidden="true"
              />
              {isStreaming ? (
                <StopIconButton onClick={() => void abort()} />
              ) : (
                <SubmitIconButton
                  disabled={(!text.trim() && !images.length) || !canControlSession(sessionId)}
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
        <div className="composer-status text-text-tertiary @container flex min-h-6 flex-wrap items-center gap-x-3 gap-y-0.5 px-2 pt-1.5 text-sm">
          {text.startsWith('!') ? (
            <span className="text-text-secondary">
              <span className="font-mono">!cmd</span> runs in {remote ? "the Host's" : 'your'} shell
              and enters context on the next prompt · <span className="font-mono">!!cmd</span> keeps
              the output out of context
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
              {text === '' && !isStreaming && (
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

const BelowEditorWidgets = memo(function BelowEditorWidgets({
  sessionId,
}: {
  sessionId: string
}): React.JSX.Element {
  return <WidgetSlot sessionId={sessionId} placement="belowEditor" />
})

/** Two Escapes inside this window count as the rewind chord, not two aborts. */
const DOUBLE_ESCAPE_MS = 600

/** Stable empty list: a fresh `[]` per render would remount the chip row. */
const EMPTY_ATTACHMENTS: PendingAttachment[] = []
