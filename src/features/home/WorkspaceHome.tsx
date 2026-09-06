import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import type { WorkspaceSessionStats } from '@shared/models'
import { useWorktreesStore } from '@/stores/worktrees'
import { prefetchTrunk, startChat } from '@/features/sessions/startChat'
import { useStartingChatStore } from '@/stores/startingChat'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { errorText } from '@shared/errors'
import { useSessionsStore } from '@/stores/sessions'
import { AttachButton, SubmitIconButton } from '@/components/ComposerButtons'
import { HomeModelPicker } from './HomeModelPicker'
import { LaneBoard, useLaneBoard } from './LaneBoard'
import { Ledger } from './Ledger'
import { boardHeadline } from './laneState'
import { formatCost, formatTokens } from '@/lib/format'
import { StatTile } from '@/components/StatTile'
import { projectName } from '@/lib/path'
import { WorkspaceChip } from '@/features/workspaces/WorkspaceChip'
import { BranchControl } from '@/features/worktrees/BranchControl'
import { composePrompt, toImageContents, type PendingAttachment } from '@/features/chat/attachments'
import { AttachmentChips, DropOverlay } from '@/features/chat/composer/AttachmentChips'
import { useAttachments } from '@/features/chat/composer/useAttachments'
import { ComposerField } from '@/features/chat/composer/ComposerField'
import { homeDraftKey, useDraftsStore } from '@/stores/drafts'

/** Greeting home for a workspace: stats card + heatmap + first-prompt composer. */
export function WorkspaceHome({ workspacePath }: { workspacePath: string }): React.JSX.Element {
  const [stats, setStats] = useState<WorkspaceSessionStats | null>(null)
  const [username, setUsername] = useState('')
  const laneBoard = useLaneBoard(workspacePath)
  const headline = boardHeadline(laneBoard.board)
  /*
   * The first-prompt draft, per workspace, persisted.
   *
   * It used to be local state with one escape hatch: a failed session start
   * pushed the text back through `startingChat`. Everything else lost it —
   * switching workspace, opening a session, quitting the app. Keyed by folder
   * so composing against two projects keeps two drafts.
   */
  const draftKey = homeDraftKey(workspacePath)
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
  const [warning, setWarning] = useState<string | null>(null)
  const [isRepo, setIsRepo] = useState(false)
  const isolate = useWorktreesStore((s) => s.preferWorktree)
  // From the store, not local state: `begin` unmounts this screen, so a local
  // flag could never be read again. It stays true for the frame between the
  // keystroke and the swap.
  const starting = useStartingChatStore((s) => s.starting !== null)
  const failedDraft = useStartingChatStore((s) => s.draft)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const attachments = useAttachments({
    attachments: images,
    onChange: setImages,
    onReject: setWarning,
  })
  // The project, never the worktree folder this home screen may be pointed at.
  const git = useSessionsStore((s) => s.gitByCwd[workspacePath])
  const workspaceName = projectName(workspacePath, git)

  useEffect(() => {
    void window.pidex.invoke('sessions:stats', workspacePath).then(setStats)
    void window.pidex
      .invoke('app:userInfo')
      .then((info) => setUsername(prettifyName(info.username)))
    // Only a git repo can offer isolation, so the toggle stays hidden until we
    // know this folder is one.
    void window.pidex
      .invoke('git:info', workspacePath)
      .then((info) => setIsRepo(info.isRepo))
      .catch(() => setIsRepo(false))
    // Fetch trunk now, while the user is still typing, so the send itself
    // never waits on the network for it (see prefetchTrunk). Throttled in
    // main to once per 3 minutes per repo, so mounting this screen repeatedly
    // costs nothing.
    prefetchTrunk(workspacePath)
    textareaRef.current?.focus()
  }, [workspacePath])

  /**
   * Take back a message whose session failed to start.
   *
   * The composer that sent it no longer exists — committing a send unmounts
   * this screen — so the text comes back through the store. Scoped to the
   * folder it was composed in: a failure must not paste itself into a
   * different project's composer if the user moved on.
   */
  useEffect(() => {
    if (!failedDraft || failedDraft.workspacePath !== workspacePath) return
    useDraftsStore.getState().patch(draftKey, {
      text: failedDraft.text,
      attachments: failedDraft.attachments,
      workspacePath,
    })
    setWarning(failedDraft.message)
    useStartingChatStore.getState().clearDraft()
    textareaRef.current?.focus()
  }, [failedDraft, workspacePath, draftKey])

  const start = async (): Promise<void> => {
    const message = text.trim()
    if (!message || starting) return
    setWarning(null)

    const prompt = composePrompt(message, images)
    const sent = toImageContents(images)
    // The send is committed here, before any await, and the screen changes at
    // once: `StartingChat` replaces this screen with the message already in
    // the place the transcript will show it. Everything after this is off the
    // user's path.
    //
    // It also closes the double-send window the old `setPhase` guard only
    // half-covered — `startChat` reported its first phase after a git round
    // trip, so until then a second Enter started a second session and a
    // second branch. This screen is gone before the next keystroke lands.
    useStartingChatStore.getState().begin({ workspacePath, prompt, images: sent })
    // The send is committed, so the draft is spent. A failure re-fills it
    // through `startingChat` below.
    useDraftsStore.getState().clear(draftKey)
    try {
      // Resolves once the session is live and its first prompt is away (see
      // startChat) — the branch is cut from the message slug first because a
      // session is bound to the cwd it spawns in. The generated name arrives
      // afterwards, on its own, and renames the branch to match; nothing here
      // waits for it.
      await startChat({
        workspacePath,
        prompt,
        images: sent,
        onPhase: (next) => useStartingChatStore.getState().setPhase(next),
        // A toast, not an inline note under the composer: the session did
        // start, so this screen is already gone by the time the warning
        // exists and an inline note would flash and vanish unread.
        onWarning: (reason) => useExtensionUiStore.getState().pushToast(reason, 'warning'),
      })
      useStartingChatStore.getState().finish()
    } catch (error) {
      // The session never started, so the message would otherwise be gone.
      // This component is already unmounted (`begin` swapped the screen), so
      // the draft goes back through the store and the remounted greeting
      // screen picks it up below.
      useStartingChatStore.getState().restore({
        workspacePath,
        text: message,
        attachments: images,
        message: `Couldn't start this session. ${errorText(error)}`,
      })
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Scrolls on its own, so a tall project-stats block never pushes the
          composer below the fold. The composer below is a sibling, not a
          child of this scroll container, so it stays put. */}
      <div className="flex flex-1 flex-col items-center overflow-y-auto px-8">
        <div className="w-full max-w-3xl pt-10 pb-6">
          {/* The board's own summary when it has one: "3 ready to merge" is a
              better greeting than a question, and it saves the reader from
              counting the columns themselves. */}
          <h1 className="text-center text-4xl font-semibold tracking-tight">
            <span className="text-accent mr-2">✳</span>
            {headline ?? `What's up next${username ? `, ${username}` : ''}?`}
          </h1>

          <LaneBoard data={laneBoard} />
          <Ledger workspacePath={workspacePath} stats={stats} lanes={laneBoard.lanes} />

          {stats && stats.sessionCount > 0 && (
            <details className="border-border bg-bg-secondary/60 mt-6 rounded-xl border p-4">
              <summary className="text-text-tertiary cursor-pointer text-sm">Project stats</summary>
              <div className="mt-3 grid grid-cols-4 gap-2">
                <StatTile label="Sessions" value={formatNumber(stats.sessionCount)} />
                <StatTile label="Messages" value={formatNumber(stats.messages)} />
                <StatTile label="Total tokens" value={formatTokens(stats.tokens)} />
                <StatTile label="Active days" value={String(stats.activeDays)} />
              </div>
              <Heatmap activityByDay={stats.activityByDay} />
              {stats.cost > 0 && (
                <div className="text-text-tertiary mt-2 px-1 text-sm">
                  You&apos;ve spent {formatCost(stats.cost)} thinking out loud in {workspaceName}.
                </div>
              )}
            </details>
          )}

          {stats && stats.sessionCount === 0 && (
            <p className="text-text-secondary mt-4 text-center text-lg">
              Start your first session in <span className="font-medium">{workspaceName}</span> —
              describe a task below.
            </p>
          )}
        </div>
      </div>

      <div className="flex flex-col items-center px-4 pb-6 pt-4 sm:px-6">
        <div className="w-full max-w-2xl">
          {/*
            Folder, branch and isolation, on one row above the composer.

            This narrowly reverses the "no chips above the composer" decision
            in WORKTREES.md, which moved both controls to the top bar so that
            "which branch will this run on?" could not have two answers. The
            top bar is still the one owner — these are the SAME controls, not
            second copies — but on the home screen they are the subject of the
            screen rather than window furniture: this is the moment you decide
            where a chat will run, and the top bar's compact chips sit far from
            the composer and get clipped behind the OS window controls.
          */}
          <div className="mb-2 flex flex-wrap items-center gap-1.5 px-0.5">
            <WorkspaceChip workspacePath={workspacePath} />
            {isRepo && <BranchControl workspacePath={workspacePath} />}
            {isRepo && (
              <IsolateToggle checked={isolate} disabled={starting} workspacePath={workspacePath} />
            )}
          </div>
          {/* One seamless card: the submit affordance sits inside the field
              (a quiet ⏎ glyph), never as a second bordered row. */}
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
              onChange={setText}
              onSubmit={() => void start()}
              onPasteFiles={attachments.addFiles}
              placeholder="Describe a task or ask a question"
              rows={2}
              className="composer-field text-text placeholder:text-text-secondary block w-full resize-none overflow-y-auto bg-transparent px-4 pb-1 pt-3.5 text-lg outline-none"
            />

            {/* Footer mirrors the chat composer: attachments on the left,
                model + thinking on the right, submit at the far right. */}
            <div className="flex flex-wrap items-center justify-between gap-2 px-2.5 pb-2">
              <div className="flex min-w-0 items-center gap-1.5">
                <AttachButton onFiles={attachments.addFiles} />
              </div>

              <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-0.5">
                <HomeModelPicker
                  override={draft?.model}
                  onPick={(model) => useDraftsStore.getState().patch(draftKey, { model })}
                />
                <SubmitIconButton
                  busy={starting}
                  disabled={!text.trim()}
                  onClick={() => void start()}
                  label="Start session"
                />
              </div>
            </div>
          </div>
          {/* Why a message came back rather than becoming a session. */}
          {warning && <p className="text-warning mt-2 px-1 text-sm">{warning}</p>}
        </div>
      </div>
    </div>
  )
}

/**
 * Per-chat opt-out from branch isolation, next to the message it applies to.
 *
 * The same preference as the branch popup's "worktree" checkbox and the
 * Workspaces settings switch — deliberately one flag in three places rather
 * than three flags, since all three answer "does my work get its own branch?".
 * It lives here because the answer is worth changing per message: a quick
 * question does not deserve a branch, and the composer is where you know that.
 */
function IsolateToggle({
  checked,
  disabled,
  workspacePath,
}: {
  checked: boolean
  disabled: boolean
  workspacePath: string
}): React.JSX.Element {
  const trunk = useStartPoint(workspacePath)
  return (
    <label
      title={
        checked
          ? `This chat gets its own branch, off the latest ${trunk ?? 'main'}, in its own worktree. The branch chip beside this names the folder you are in now, which this chat will NOT run on.`
          : 'This chat runs in the folder that is already open, on its current branch.'
      }
      className={clsx(
        'flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors',
        disabled ? 'opacity-50' : 'hover:bg-bg-secondary',
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => useWorktreesStore.getState().setPreferWorktree(e.target.checked)}
        className="accent-[var(--px-accent)]"
      />
      {/*
        Names the base, not just the mode. "new branch" alone left the only
        other branch on the row — the chip beside it, which shows the folder's
        CURRENT branch — looking like the answer to "off what?", when
        `startChat` ignores it entirely and always branches from trunk.
      */}
      <span className="text-text-secondary text-base">
        {checked && trunk ? `new branch off ${trunk}` : 'new branch'}
      </span>
    </label>
  )
}

/**
 * The trunk a new chat's branch will start from, or null while unknown.
 *
 * Read from `git:startPoint`, the same call `startChat` makes, so the label
 * and the behaviour cannot disagree.
 */
function useStartPoint(workspacePath: string): string | null {
  const [trunk, setTrunk] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void window.pidex
      .invoke('git:startPoint', workspacePath)
      .then((point) => {
        if (!cancelled) setTrunk(point.defaultBranch)
      })
      // Unresolvable trunk means `startChat` falls back to HEAD; the label
      // then says plain "new branch", which stays true.
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [workspacePath])
  return trunk
}

const WEEKS = 26

function Heatmap({ activityByDay }: { activityByDay: Record<string, number> }): React.JSX.Element {
  const cells = useMemo(() => {
    const today = new Date()
    const days: { key: string; count: number }[] = []
    for (let i = WEEKS * 7 - 1; i >= 0; i--) {
      const date = new Date(today)
      date.setDate(today.getDate() - i)
      const key = date.toISOString().slice(0, 10)
      days.push({ key, count: activityByDay[key] ?? 0 })
    }
    return days
  }, [activityByDay])

  const max = Math.max(1, ...cells.map((c) => c.count))

  return (
    <div className="mt-3 overflow-x-auto px-1">
      <div className="grid grid-flow-col gap-[3px]" style={{ gridTemplateRows: 'repeat(7, 10px)' }}>
        {cells.map((cell) => {
          const intensity = cell.count === 0 ? 0 : Math.max(0.25, Math.min(1, cell.count / max))
          return (
            <div
              key={cell.key}
              title={`${cell.key}: ${cell.count} messages`}
              className={clsx(
                'h-[10px] w-[10px] rounded-[2.5px]',
                cell.count === 0 && 'bg-border/60',
              )}
              style={
                cell.count > 0
                  ? {
                      backgroundColor: `color-mix(in srgb, var(--px-accent) ${Math.round(intensity * 100)}%, var(--px-border) ${Math.round((1 - intensity) * 60)}%)`,
                    }
                  : undefined
              }
            />
          )
        })}
      </div>
    </div>
  )
}

function prettifyName(username: string): string {
  if (!username) return ''
  const cleaned = username.replace(/[._-]+/g, ' ').trim()
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1)
}

function formatNumber(n: number): string {
  return n.toLocaleString()
}

/** Stable empty list: a fresh `[]` per render would remount the chip row. */
const EMPTY_ATTACHMENTS: PendingAttachment[] = []
