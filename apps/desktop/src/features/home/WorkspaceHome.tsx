import { useHomeSubmissionsStore } from '@/stores/homeSubmissions'
import { HostHome } from './HostHome'
import { HostFolderBrowser } from '@/features/machines/HostFolderBrowser'
import { useComposerMachine } from './useComposerMachine'
import { MachinePicker } from '@/features/machines/MachinePicker'
import { RemoteModelPicker, useRemoteModel } from '@/features/machines/RemoteModelPicker'
import { ChoiceMenu } from '@/components/ChoiceMenu'
import { useRemoteLanesStore, machineLabel } from '@/stores/remoteLanes'
import { startRemoteChat } from './startRemoteChat'
import { TooltipSummary, TooltipLabel, tooltipProps } from '@/components/Tooltip'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import type { WorkspaceSessionStats } from '@shared/models'
import { useWorktreesStore } from '@/stores/worktrees'
import { prefetchTrunk, startChat } from '@/features/sessions/startChat'
import { notifyLane } from '@/features/sessions/laneNotices'
import { useStartingChatStore } from '@/stores/startingChat'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { ipcErrorText } from '@shared/errors'
import { useSessionsStore } from '@/stores/sessions'
import { SubmitIconButton } from '@/components/ComposerButtons'
import { HomeModelPicker } from './HomeModelPicker'
import { LaneBoard, useLaneBoard } from './LaneBoard'
import { Ledger } from './Ledger'
import { boardHeadline } from './laneState'
import { formatCost, formatTokens } from '@/lib/format'
import { StatTile } from '@/components/StatTile'
import { Button } from '@/components/form'
import { projectName } from '@/lib/path'
import { WorkspaceChip } from '@/features/workspaces/WorkspaceChip'
import { BranchControl } from '@/features/worktrees/BranchControl'
import { composePrompt, toImageContents, type PendingAttachment } from '@/features/chat/attachments'
import { ComposerInput } from '@/features/chat/composer/ComposerInput'
import { useWritingStore } from '@/stores/writing'
import { ContextSourcesMenu } from '@/features/chat/composer/ContextSourcesMenu'
import { buildCommandEntries } from '@/features/chat/composer/CommandMenu'
import { useSlashMenu } from '@/features/chat/composer/useSlashMenu'
import { NO_COMMANDS, usePiCommandsStore } from '@/stores/piCommands'
import { homeDraftKey, useDraftsStore } from '@/stores/drafts'

/** Workspace workbench with the existing first-prompt composer kept in reach. */
export function WorkspaceHome({ workspacePath }: { workspacePath: string }): React.JSX.Element {
  const [composerMachine, setComposerMachine] = useComposerMachine()
  const remoteHost = useRemoteLanesStore((s) => s.hosts[composerMachine])
  const selection = useRemoteModel(composerMachine === 'local' ? '' : composerMachine)
  const [repository, setRepository] = useState<{ hostId: string; id: string } | null>(null)
  const repositoryId =
    repository?.hostId === composerMachine ? repository.id : (remoteHost?.repositories[0]?.id ?? '')
  const [addingFolder, setAddingFolder] = useState(false)
  useEffect(() => setAddingFolder(false), [composerMachine])
  const [stats, setStats] = useState<WorkspaceSessionStats | null>(null)
  const [username, setUsername] = useState('')
  /*
   * The first-prompt draft, per workspace, persisted.
   *
   * It used to be local state with one escape hatch: a failed session start
   * pushed the text back through `startingChat`. Everything else lost it —
   * switching workspace, opening a session, quitting the app. Keyed by folder
   * so composing against two projects keeps two drafts.
   */
  const draftKey = homeDraftKey(workspacePath)
  const remoteBusy = useHomeSubmissionsStore((s) => !!s.pending[draftKey])
  const filter = useRemoteLanesStore((s) => s.filter)
  const homeHostId = filter === 'local' || filter === 'all' ? null : filter
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
  const swarm = draft?.swarm ?? false
  /*
   * The `/` menu, same component and same keymap as the chat composer.
   *
   * The entries cannot come from where the chat composer gets them — that list
   * is answered by the session's own pi process, and here there is no session
   * yet — so they come from a workspace-scoped probe instead, loaded on the
   * first `/` rather than on mount (it spawns a pi). No native commands:
   * /compact, /export and /name all act on a session that does not exist.
   */
  const piCommands = usePiCommandsStore((s) => s.byWorkspace[workspacePath] ?? NO_COMMANDS)
  const commandsStatus = usePiCommandsStore((s) => s.status[workspacePath] ?? 'idle')
  const commandsError = usePiCommandsStore((s) => s.error[workspacePath])
  const commandEntries = useMemo(() => buildCommandEntries(piCommands, []), [piCommands])
  const slash = useSlashMenu({
    entries: commandEntries,
    setText,
    onOpen: () => void usePiCommandsStore.getState().load(workspacePath),
    focus: () => textareaRef.current?.focus(),
  })

  // The project, never the worktree folder this home screen may be pointed at.
  const git = useSessionsStore((s) => s.gitByCwd[workspacePath])
  const workspaceName = projectName(workspacePath, git)

  useEffect(() => {
    if (homeHostId) return
    void window.phosphor.invoke('sessions:stats', workspacePath).then(setStats)
    void window.phosphor
      .invoke('app:userInfo')
      .then((info) => setUsername(prettifyName(info.username)))
    // Only a git repo can offer isolation, so the toggle stays hidden until we
    // know this folder is one.
    void window.phosphor
      .invoke('git:info', workspacePath)
      .then((info) => setIsRepo(info.isRepo))
      .catch(() => setIsRepo(false))
    // Fetch trunk now, while the user is still typing, so the send itself
    // never waits on the network for it (see prefetchTrunk). Throttled in
    // main to once per 3 minutes per repo, so mounting this screen repeatedly
    // costs nothing.
    prefetchTrunk(workspacePath)
    textareaRef.current?.focus()
  }, [workspacePath, homeHostId])

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
      swarm: failedDraft.swarm,
      workspacePath,
    })
    setWarning(failedDraft.message)
    useStartingChatStore.getState().clearDraft()
    textareaRef.current?.focus()
  }, [failedDraft, workspacePath, draftKey])

  const start = async (): Promise<void> => {
    const message = text.trim()
    if (
      (!message && images.length === 0) ||
      starting ||
      useHomeSubmissionsStore.getState().pending[draftKey]
    )
      return
    if (composerMachine !== 'local') {
      if (!repositoryId || !selection.model) {
        setWarning(selection.hint)
        return
      }
      if (!useHomeSubmissionsStore.getState().begin(draftKey)) return
      const revision = useDraftsStore.getState().revisions[draftKey]
      try {
        await startRemoteChat(
          composerMachine,
          {
            repositoryId,
            provider: selection.model.provider,
            model: selection.model.id,
            thinkingLevel: selection.thinking,
          },
          message,
          images,
          () => {
            if (useDraftsStore.getState().revisions[draftKey] === revision)
              useDraftsStore.getState().clear(draftKey)
          },
        )
      } catch {
        const error = 'The Host could not confirm this. Check the lane before retrying.'
        setWarning(error)
        useExtensionUiStore.getState().pushToast(error, 'warning')
      } finally {
        useHomeSubmissionsStore.getState().finish(draftKey)
      }
      return
    }
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
    // Claimed HERE, at the keystroke, not inside `createSession` several
    // seconds of git later. Anything that would put this lane on screen checks
    // the claim first, so clicking another lane while this one builds now
    // sticks instead of being undone when the new process comes up.
    const nav = useSessionsStore.getState().claimNav()
    try {
      // Resolves once the session is live and its first prompt is away (see
      // startChat) — the branch is cut from the message slug first because a
      // session is bound to the cwd it spawns in. The generated name arrives
      // afterwards, on its own, and renames the branch to match; nothing here
      // waits for it.
      const started = await startChat({
        workspacePath,
        prompt,
        images: sent,
        swarm,
        nav,
        onPhase: (next) => useStartingChatStore.getState().setPhase(next),
        // A toast, not an inline note under the composer: the session did
        // start, so this screen is already gone by the time the warning
        // exists and an inline note would flash and vanish unread.
        onWarning: (reason) => useExtensionUiStore.getState().pushToast(reason, 'warning'),
      })
      useStartingChatStore.getState().finish()
      // Only once the lane started: a failure puts the draft back, and sending
      // it again must not learn the same prompt twice.
      useWritingStore.getState().recordPrompt(message)
      // The lane came up behind whatever the user moved on to, so say so once
      // rather than pulling them back to it.
      if (useSessionsStore.getState().navSeq !== nav) {
        notifyLane(started.sessionId, { message: 'Your new lane is running.' })
      }
    } catch (error) {
      // The session never started, so the message would otherwise be gone.
      // This component is already unmounted (`begin` swapped the screen), so
      // the draft goes back through the store and the remounted greeting
      // screen picks it up below.
      useStartingChatStore.getState().restore({
        workspacePath,
        text: message,
        attachments: images,
        swarm,
        message: `Couldn't start this session. ${ipcErrorText(error)}`,
      })
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Scrolls on its own, so a tall project-stats block never pushes the
          composer below the fold. The composer below is a sibling, not a
          child of this scroll container, so it stays put. */}
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-4 sm:px-8">
        <div className="w-full max-w-6xl pt-8 pb-6">
          {homeHostId ? (
            <HostHome hostId={homeHostId} />
          ) : (
            <LocalHomeDashboard
              workspacePath={workspacePath}
              workspaceName={workspaceName}
              stats={stats}
              username={username}
              onNew={() => textareaRef.current?.focus()}
            />
          )}
        </div>
      </div>

      <div className="flex flex-col items-center px-4 pb-6 pt-4 sm:px-6">
        <div className="relative w-full max-w-3xl">
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
            <MachinePicker
              placement="above"
              value={composerMachine}
              capability="sessions.control"
              onChange={(id) => {
                setComposerMachine(id)
              }}
            />
            {composerMachine !== 'local' && (
              <ChoiceMenu
                label="Repository"
                value={repositoryId}
                choices={[
                  ...(remoteHost?.repositories ?? []).map((repo) => ({
                    value: repo.id,
                    label: repo.name,
                  })),
                  {
                    value: '__add__',
                    label: `Add folder on ${machineLabel(composerMachine)}…`,
                    disabled:
                      remoteHost?.state !== 'ready' ||
                      !remoteHost?.capabilities.includes('workspaces.write'),
                  },
                ]}
                onChange={(id) => {
                  if (id === '__add__') setAddingFolder(true)
                  else setRepository({ hostId: composerMachine, id })
                }}
              >
                {remoteHost?.repositories.find((repo) => repo.id === repositoryId)?.name ??
                  'Choose repository'}
              </ChoiceMenu>
            )}
            {composerMachine === 'local' && (
              <>
                <WorkspaceChip workspacePath={workspacePath} />
                {isRepo && <BranchControl workspacePath={workspacePath} />}
                {isRepo && (
                  <IsolateToggle
                    checked={isolate}
                    disabled={starting}
                    workspacePath={workspacePath}
                  />
                )}
              </>
            )}
          </div>
          {addingFolder && composerMachine !== 'local' && (
            <HostFolderBrowser
              key={composerMachine}
              hostId={composerMachine}
              onClose={() => setAddingFolder(false)}
              onAdded={(id) => setRepository({ hostId: composerMachine, id })}
            />
          )}
          <ComposerInput
            workspacePath={composerMachine === 'local' ? workspacePath : undefined}
            remoteAttachments={composerMachine !== 'local'}
            value={text}
            textareaRef={textareaRef}
            onChange={setText}
            onSubmit={() => void start()}
            placeholder="Describe a task or ask a question"
            rows={2}
            attachments={images}
            onAttachmentsChange={setImages}
            onWarning={setWarning}
            slash={
              composerMachine === 'local'
                ? slash
                : { ...slash, visible: false, sync: () => undefined, handleKeyDown: () => false }
            }
            commandStatus={commandsStatus}
            commandError={commandsError}
            swarm={{
              enabled: swarm,
              onChange: (enabled) => useDraftsStore.getState().patch(draftKey, { swarm: enabled }),
            }}
            modelPicker={
              composerMachine !== 'local' ? (
                <RemoteModelPicker selection={selection} />
              ) : (
                <HomeModelPicker
                  override={draft?.model}
                  onPick={(model) => useDraftsStore.getState().patch(draftKey, { model })}
                />
              )
            }
            actions={
              <SubmitIconButton
                busy={starting || remoteBusy}
                disabled={!text.trim() && images.length === 0}
                onClick={() => void start()}
                label="Start session"
              />
            }
          />
          {/* The status strip, as under the chat composer. No session yet, so
              only what new lanes will load. */}
          <div className="text-text-tertiary @container flex min-h-6 flex-wrap items-center gap-x-3 gap-y-0.5 px-2 pt-1.5 text-sm">
            {composerMachine === 'local' && <ContextSourcesMenu workspacePath={workspacePath} />}
            {composerMachine === 'local' && text === '' && (
              <span className="@xl:inline ml-auto hidden min-w-0 flex-1 basis-0 truncate text-right">
                <span className="font-mono">/</span> commands · <span className="font-mono">@</span>{' '}
                files
              </span>
            )}
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
    <TooltipLabel
      {...tooltipProps(
        checked
          ? {
              label: `New worktree off ${trunk ?? 'main'}`,
              description: 'Not the folder shown beside it',
            }
          : { label: 'Run in the open folder', description: 'On its current branch' },
      )}
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
    </TooltipLabel>
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
    void window.phosphor
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
              data-tooltip={`${cell.key}: ${cell.count} messages`}
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

/** Mounted only for This Mac: remote home never subscribes to the local lane board. */
function LocalHomeDashboard({
  workspacePath,
  workspaceName,
  stats,
  username,
  onNew,
}: {
  workspacePath: string
  workspaceName: string
  stats: WorkspaceSessionStats | null
  username: string
  onNew: () => void
}): React.JSX.Element {
  const laneBoard = useLaneBoard(workspacePath)
  const headline = boardHeadline(laneBoard.board)
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-text-secondary mb-2 font-mono text-xs uppercase tracking-wider">
            {workspaceName}
          </p>
          <h1 className="text-4xl font-semibold tracking-tight">
            {laneBoard.board.lanes.length
              ? 'Your workbench'
              : `What's up next${username ? `, ${username}` : ''}?`}
          </h1>
          <p className="text-text-secondary mt-2 text-lg">
            {headline ?? 'Give each task a lane. Keep the work in view.'}
          </p>
        </div>
        <Button onClick={onNew}>New lane</Button>
      </div>

      <LaneBoard key={laneBoard.projectRoot} data={laneBoard} />
      <Ledger workspacePath={workspacePath} stats={stats} lanes={laneBoard.lanes} />

      {stats && stats.sessionCount > 0 && (
        <details className="border-border bg-bg-secondary/60 mt-6 rounded-xl border p-4">
          <TooltipSummary className="text-text-tertiary cursor-pointer text-sm">
            Project stats
          </TooltipSummary>
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

      {stats && stats.sessionCount === 0 && laneBoard.board.lanes.length === 0 && (
        <p className="text-text-secondary mt-4 text-center text-lg">
          Start your first session in <span className="font-medium">{workspaceName}</span> —
          describe a task below.
        </p>
      )}
    </>
  )
}
