import { create } from 'zustand'
import type { GitInfo, SessionMeta, SessionScanStatus, SessionPush } from '@shared/models'
import type { ImageContent, PiEvent } from '@shared/rpc'
import { useChatStore } from './chat'
import { useNamingStore } from './naming'
import { drop } from './keyedSlice'
import { piCallOk, rehydrateTranscript } from '@/lib/rpc'
import { sessionTitle } from '@/lib/sessionTitle'
import { clearBurnSamples, recordBurnSample } from '@/lib/burnRate'
import {
  clearLiveStats,
  hasUsageDeltas,
  liveBilledTokens,
  recordMessageEnd,
  recordPolledStats,
  recordUsageDelta,
} from '@/lib/liveStats'
import { isArtifactWriteTool } from '@/lib/artifactTools'
import { useLayoutStore } from './layout'
import { lanePrefs } from './lanePrefs'

/**
 * Whether an event should trigger a stats refresh.
 *
 * `get_session_stats` reads pi's in-memory session state (no I/O — verified
 * against pi's own rpc-mode.js, `session.getSessionStats()`), so refreshing
 * on every completed sub-step keeps the context meter and working indicator
 * climbing live instead of jumping once per turn. Exported as a pure
 * predicate so the trigger set is unit-testable without mocking IPC.
 */
export function shouldRefreshStatsOn(
  eventType: PiEvent['type'],
  usageArrivesOnDeltas: boolean,
): boolean {
  // With usage riding every delta (pi >= 0.84.2, detected per session rather
  // than version-checked), the meter climbs from the stream and the poll only
  // needs to re-sync at boundaries where pi computes things the stream cannot
  // carry — the authoritative post-turn context estimate, message counts, and
  // the post-compaction reset. Without it, the old per-sub-step polling is
  // the only thing that moves the meter mid-turn, so it stays.
  if (usageArrivesOnDeltas) {
    return eventType === 'agent_end' || eventType === 'compaction_end'
  }
  return (
    eventType === 'agent_end' ||
    eventType === 'compaction_end' ||
    eventType === 'message_end' ||
    eventType === 'tool_execution_end'
  )
}

/**
 * Live pi subprocesses + on-disk session catalogue.
 * Multiple sessions stream concurrently; switching is instant because chat
 * state is keyed by Phosphor session id and background handlers keep reducing.
 */

interface LiveSessionEntry {
  phosphorId: string
  workspacePath: string
  /** Disk session file, learned from get_state after spawn. */
  diskPath?: string
}

interface SessionsState {
  activeSessionId: string | null
  /** phosphorId → live entry. */
  live: Record<string, LiveSessionEntry>
  /** workspacePath → on-disk metas (sidebar). */
  disk: Record<string, SessionMeta[]>
  /** workspacePath → latest scan attempt; absence = never attempted. */
  scanStatus: Record<string, SessionScanStatus>
  /** phosphorId → unread activity count for background sessions. */
  unread: Record<string, number>
  /** phosphorId → git session baseline ref (null = not a repo). */
  baselines: Record<string, string | null>
  pinned: string[]
  /**
   * Session file path → EXPLICIT lane marker. Absent means "never chose" and
   * the row derives one from the branch; an empty string means "no marker, on
   * purpose". See `lib/laneMarker.ts`.
   */
  laneMarkers: Record<string, string>
  /** sessionPath → epoch ms last viewed (mirrors the persisted pref). */
  seenSessions: Record<string, number>
  /** cwd → cached git summary for sidebar subtitles. */
  gitByCwd: Record<string, GitInfo>
  creating: boolean

  hydratePinned: () => Promise<void>
  /** Record that the user is looking at this session right now. */
  markSeen: (sessionPath: string) => void
  /** Refresh batched git summaries for these cwds. */
  refreshGitInfo: (cwds: string[]) => Promise<void>
  refreshDisk: (workspacePath: string) => Promise<void>
  /** Scan many workspaces in parallel (capped); powers the grouped sidebar. */
  refreshAllDisk: (workspacePaths: string[], limit?: number) => Promise<void>
  /** Scan only workspaces with no scan attempt recorded yet. */
  refreshMissing: (workspacePaths: string[]) => Promise<void>
  /** Start session-dir watchers for these workspaces (idempotent). */
  watchWorkspaces: (workspacePaths: string[]) => void
  /** Stop watching these workspaces (collapsed sidebar groups). */
  unwatchWorkspaces: (workspacePaths: string[]) => void
  createSession: (
    workspacePath: string,
    options?: {
      sessionPath?: string
      forkFrom?: string
      name?: string
      firstPrompt?: string
      firstImages?: ImageContent[]
      /**
       * Generate a title for this session once its first message exists.
       * Defaults to true. `startChat` sets it false because it owns naming for
       * the chats it creates — the title has to reach the branch as well as
       * the session, and two naming passes would mean two different names.
       */
      autoName?: boolean
    },
  ) => Promise<string>
  openDiskSession: (workspacePath: string, meta: SessionMeta) => Promise<string>
  /**
   * Take ownership of a session the MAIN process spawned (today: a project's
   * orchestrator), so the renderer can show it like any other.
   *
   * Everything keyed on `live` breaks without this — most visibly
   * `useActiveWorkspace()`, which resolves the active session's folder and
   * returns null for a session it has never heard of, dropping the whole app
   * to the workspace picker. Idempotent.
   */
  adoptSession: (sessionId: string, workspacePath: string, diskPath?: string) => Promise<void>
  activate: (sessionId: string | null) => void
  disposeSession: (sessionId: string) => Promise<void>
  /**
   * Reclaim a session's ~200MB pi subprocess while keeping its sidebar row.
   * Reopening resumes from disk (measured ~940ms), so this is cheap to undo.
   */
  suspendSession: (sessionId: string) => Promise<void>
  /** Session paths suspended this run, so the UI can label them. */
  suspendedPaths: string[]
  /**
   * Restart a lane on a Claude account — the same one ("re-prime") or another.
   *
   * A running lane cannot change account: its credential is fixed by the
   * environment pi was spawned with, and the Claude CLI process is parked for
   * the lane's whole life. So the move is a dispose and a resume from the same
   * session file, with the binding rewritten first so the new spawn routes
   * where the user asked. Returns the new Phosphor session id, or null when the
   * lane has no file yet and therefore nothing to resume.
   */
  moveSessionToAccount: (sessionId: string, accountId: string) => Promise<string | null>
  deleteDiskSession: (workspacePath: string, meta: SessionMeta) => Promise<void>
  togglePin: (path: string) => void
  /**
   * Set or clear a lane's explicit marker. `null` forgets the choice, so the
   * lane goes back to its derived marker; `''` is a real choice meaning "no
   * marker". Those are deliberately different.
   */
  setLaneMarker: (path: string, marker: string | null) => void
  /**
   * Live progress of a bulk delete, or null when none is running.
   *
   * Published rather than returned because the confirm dialog has to render
   * it: a bulk delete disposes a subprocess and runs git per lane, so a
   * ten-lane delete is seconds of apparently-frozen UI otherwise.
   */
  bulkDelete: BulkDeleteProgress | null
  /** Stop after the lane currently in flight. */
  cancelBulkDelete: () => void
  /** Clear a finished run's summary. */
  dismissBulkDelete: () => void
  /** Bulk delete. See the implementation for the ordering guarantee. */
  deleteManySessions: (
    workspacePath: string,
    lanes: Array<{ path: string; title: string; worktreePath?: string; mainRepoPath?: string }>,
    options: { removeWorktree: boolean; deleteBranch: boolean; discardChanges: boolean },
  ) => Promise<LaneDeleteResult[]>
}

export interface LaneDeleteResult {
  path: string
  title: string
  ok: boolean
  /** Set on failure, and also on success when the branch could not be removed. */
  error?: string
}

export interface BulkDeleteProgress {
  total: number
  done: number
  /** Lane currently being deleted; empty once finished. */
  current: string
  /**
   * Every selected lane, in run order, published up front.
   *
   * The progress modal used to render only finished rows, so it grew by a row
   * every time a lane completed — the panel crept downward for the whole run
   * and the progress bar never sat still. Knowing the full list on the first
   * frame lets it reserve its final height and fill rows in place.
   */
  lanes: Array<{ path: string; title: string }>
  results: LaneDeleteResult[]
  running: boolean
  cancelled: boolean
}

/**
 * Cancellation flag for the in-flight bulk delete.
 *
 * Module scope rather than store state: the loop reads it between lanes, and
 * routing that through a zustand read per iteration would make cancellation
 * depend on render timing.
 */
let bulkDeleteCancelled = false

const unsubscribers = new Map<string, () => void>()
/** Workspaces already being watched, so repeat calls are no-ops. */
const watchedWorkspaces = new Set<string>()

/**
 * (Re)learn this session's live state from pi — `sessionFile`, model
 * catalogue, commands, stats, thinking levels.
 *
 * Called once after a session is created or adopted, and again by
 * `rewindToEntry`/`ForkPickerModal` after a successful `fork` RPC: pi's own
 * `fork` command always branches onto a brand-new session file, even for a
 * single-message "rewind" — verified against the installed pi core's
 * `agent-session-runtime.js`, `SessionManager.createBranchedSession()` — it
 * never truncates the live file in place. Without a second call here,
 * `live[phosphorId].diskPath` keeps pointing at the abandoned pre-fork file, so
 * the sidebar highlights that stale file as "live" while the real, actively
 * written branch shows up as an unclaimed extra row — read by a user as the
 * chat having been duplicated.
 *
 * The one sanctioned exemption from the `piCall` rule (CLAUDE.md fact 3): this
 * batch wants the raw envelopes, both because `Promise.allSettled` reasons over
 * them and because a per-command failure is expected here — older pi builds
 * simply lack some of these commands, and surfacing five chat errors while a
 * session is still opening would be worse than the graceful degradation below.
 */
export async function bootstrapSession(phosphorId: string): Promise<void> {
  const chat = useChatStore.getState()
  // get_state is awaited on its own, ahead of the rest: it carries
  // `sessionFile`, and "reopen my last session" depends on that path being
  // persisted. Batching it with the slower catalogue calls meant a window
  // closed before the batch settled lost the pref entirely — a race the
  // relaunch e2e caught on Linux CI once a fifth call joined the batch.
  const statePromise = window.phosphor.piCommand(phosphorId, { type: 'get_state' })
  const restPromise = Promise.allSettled([
    window.phosphor.piCommand(phosphorId, { type: 'get_available_models' }),
    window.phosphor.piCommand(phosphorId, { type: 'get_commands' }),
    window.phosphor.piCommand(phosphorId, { type: 'get_session_stats' }),
    window.phosphor.piCommand(phosphorId, { type: 'get_available_thinking_levels' }),
  ])

  const state = await statePromise.then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason }),
  )
  if (state.status === 'fulfilled' && state.value.success && state.value.data) {
    chat.setMeta(phosphorId, state.value.data)
    const diskPath = state.value.data.sessionFile
    if (diskPath) {
      useSessionsStore.setState((s) => ({
        live: {
          ...s.live,
          [phosphorId]: { ...(s.live[phosphorId] ?? { phosphorId, workspacePath: '' }), diskPath },
        },
      }))
      // Same reason the Claude account binding happens here: main picked the
      // account at spawn, but the file it has to be recorded against did not
      // exist yet. No-op for a session that is not on the Claude provider.
      void window.phosphor.invoke('claude:bindSession', diskPath, phosphorId)
      // The path only becomes known here (get_state resolves after spawn), so
      // persist it now if this session is the one on screen.
      if (useSessionsStore.getState().activeSessionId === phosphorId) {
        void window.phosphor.invoke('app:setLastSession', diskPath)
        useSessionsStore.getState().markSeen(diskPath)
      }
      // Re-scan the folder so the session gets a real sidebar row rather than
      // the placeholder one. The dir watcher is the usual source of this, but
      // it cannot be the only one: `ignoreInitial` means a file already written
      // by the time the watcher attaches raises no event, which is the normal
      // case for a brand-new worktree (the folder becomes watched only once
      // the session that created it exists). Without this the row stayed a
      // `PendingSessionRow` — no context menu, no right-click — until some
      // unrelated re-render happened to re-scan.
      const workspacePath = useSessionsStore.getState().live[phosphorId]?.workspacePath
      if (workspacePath) void useSessionsStore.getState().refreshDisk(workspacePath)
    }
  }
  const [models, commands, stats, thinkingLevels] = await restPromise
  if (models.status === 'fulfilled' && models.value.success && models.value.data) {
    chat.setModels(phosphorId, models.value.data.models)
  }
  if (commands.status === 'fulfilled' && commands.value.success && commands.value.data) {
    chat.setCommands(phosphorId, commands.value.data.commands)
  }
  if (stats.status === 'fulfilled' && stats.value.success && stats.value.data) {
    recordPolledStats(phosphorId, stats.value.data)
    chat.setStats(phosphorId, stats.value.data)
  }
  // Older pi builds lack this command; leaving it null makes the picker derive
  // the levels locally instead of showing a wrong hardcoded list.
  if (
    thinkingLevels.status === 'fulfilled' &&
    thinkingLevels.value.success &&
    thinkingLevels.value.data
  ) {
    chat.setThinkingLevels(phosphorId, thinkingLevels.value.data.levels)
  }
}

/**
 * Re-ask pi which thinking levels are selectable.
 *
 * Must run after every model switch: the supported set is per-model, so a
 * stale list would offer levels the new model silently clamps away.
 *
 * Raw `piCommand` on purpose: the failure mode is "pi is too old to know this
 * command", which the picker already handles by deriving the levels locally.
 */
export async function refreshThinkingLevels(phosphorId: string): Promise<void> {
  try {
    const response = await window.phosphor.piCommand(phosphorId, {
      type: 'get_available_thinking_levels',
    })
    if (response.success && response.data) {
      useChatStore.getState().setThinkingLevels(phosphorId, response.data.levels)
    }
  } catch {
    // Session gone, or pi too old — the picker's local derivation covers it.
  }
}

/**
 * Generate and apply a title for a brand-new session's first message.
 *
 * The one-shot completion (`pi:generateTitle`) can take seconds; by the time
 * it lands the user may have renamed the session (guard: explicit
 * `sessionName` wins) or closed it (guard: still live). Existing titles ride
 * along so the model avoids duplicating a sibling session's name.
 */
async function autoNameSession(
  phosphorId: string,
  workspacePath: string,
  firstPrompt: string,
): Promise<void> {
  const existing = (useSessionsStore.getState().disk[workspacePath] ?? [])
    .map((m) => sessionTitle({ explicitName: m.name, firstUserText: m.firstUserText }))
    .filter((t): t is string => Boolean(t))
  useNamingStore.getState().start(phosphorId, workspacePath)
  const title = await window.phosphor
    .invoke('pi:generateTitle', workspacePath, firstPrompt, existing)
    .catch(() => null)
  useNamingStore.getState().finish(phosphorId)
  if (!title) return
  if (useChatStore.getState().sessions[phosphorId]?.meta?.sessionName) return
  if (!useSessionsStore.getState().live[phosphorId]) return
  if (await piCallOk(phosphorId, { type: 'set_session_name', name: title })) {
    // The visible rename; the disk scan may not carry it for a while yet.
    // See the same call in features/sessions/startChat.ts.
    useChatStore.getState().patchMeta(phosphorId, { sessionName: title })
    void useSessionsStore.getState().refreshDisk(workspacePath)
  }
}

/**
 * Raw `piCommand` on purpose: this fires on every completed sub-step of a turn,
 * so routing failures to the chat surface would paint an error per token batch.
 * A stale context meter is the better failure.
 */
async function refreshStats(phosphorId: string): Promise<void> {
  try {
    const response = await window.phosphor.piCommand(phosphorId, { type: 'get_session_stats' })
    if (response.success && response.data) {
      // Re-seed the live overlay's baseline BEFORE displaying, so a delta
      // arriving between here and the next poll stacks on current truth.
      recordPolledStats(phosphorId, response.data)
      useChatStore.getState().setStats(phosphorId, response.data)
      const { input, output, cacheRead, cacheWrite } = response.data.tokens
      recordBurnSample(phosphorId, {
        at: Date.now(),
        billed: input + output + cacheRead + cacheWrite,
        output,
        cacheWrite,
      })
    }
  } catch {
    // session gone
  }
}

/** Record a suspended session so its sidebar row can say so until reopened. */
function markSuspended(diskPath: string): void {
  useSessionsStore.setState((s) => ({
    suspendedPaths: s.suspendedPaths.includes(diskPath)
      ? s.suspendedPaths
      : [...s.suspendedPaths, diskPath],
  }))
}

/**
 * Drop everything the renderer holds for a session whose process is gone.
 *
 * Session-scoped side state: kill its PTYs, drop its artifacts, and clear
 * its extension UI. Lazy imports keep this store free of load-order
 * cycles; AWAITED so the cleanup cannot outlive the caller (fire-and-forget
 * raced test teardown, and would equally race app shutdown).
 */
async function cleanupLocalSessionState(sessionId: string): Promise<void> {
  unsubscribers.get(sessionId)?.()
  unsubscribers.delete(sessionId)
  useChatStore.getState().remove(sessionId)
  const [{ useTerminalStore }, { useArtifactsStore }, { useExtensionUiStore }, { useLayoutStore }] =
    await Promise.all([
      import('./terminal'),
      import('./artifacts'),
      import('./extensionUi'),
      import('./layout'),
    ])
  await useTerminalStore.getState().removeSession(sessionId)
  useArtifactsStore.getState().remove(sessionId)
  // The right pane is per session too, so its slice needs dropping here or
  // it outlives the session that owned it.
  useLayoutStore.getState().removeSession(sessionId)
  // `clearSession` existed but was never wired up, so statuses and widgets
  // (which hold extension-supplied line arrays) accumulated until quit.
  useExtensionUiStore.getState().clearSession(sessionId)
  clearBurnSamples(sessionId)
  clearLiveStats(sessionId)
  useSessionsStore.setState((s) => ({
    live: drop(s.live, sessionId),
    unread: drop(s.unread, sessionId),
    // Was missing: every disposed session left a permanent baselines entry.
    baselines: drop(s.baselines, sessionId),
    activeSessionId: s.activeSessionId === sessionId ? null : s.activeSessionId,
  }))
}

function attachSessionPushHandler(phosphorId: string): void {
  const unsubscribe = window.phosphor.onSessionPush(phosphorId, (push: SessionPush) => {
    const chatStore = useChatStore.getState()
    switch (push.kind) {
      case 'event': {
        chatStore.applyEvent(phosphorId, push.event)
        if (
          push.event.type === 'tool_execution_end' &&
          !push.event.isError &&
          isArtifactWriteTool(push.event.toolName)
        ) {
          void import('./artifacts').then(({ useArtifactsStore }) =>
            useArtifactsStore
              .getState()
              .ingest(
                phosphorId,
                (push.event as { toolName: string }).toolName,
                (push.event as { result?: { details?: unknown } }).result?.details,
              ),
          )
        }
        if (push.event.type === 'tool_execution_end') {
          // Bash can move/delete/create arbitrary paths, so its result cannot
          // name a safe minimal invalidation set. Re-read the root and loaded
          // lazy directories immediately; the watcher remains the targeted
          // fast path for ordinary external changes.
          const workspacePath = useSessionsStore.getState().live[phosphorId]?.workspacePath
          if (workspacePath) {
            void import('./files').then(({ useFilesStore }) =>
              useFilesStore.getState().refreshLoadedDirs(workspacePath),
            )
          }
        }
        const { activeSessionId } = useSessionsStore.getState()
        if (
          activeSessionId !== phosphorId &&
          (push.event.type === 'message_end' || push.event.type === 'agent_end')
        ) {
          useSessionsStore.setState((s) => ({
            unread: { ...s.unread, [phosphorId]: (s.unread[phosphorId] ?? 0) + 1 },
          }))
        }
        // NOTE: deliberately no markSeen() here. Marking the *active* session
        // seen on every message_end looked harmless but wrote to prefs on every
        // token-batch, and that write raced `setLastSession` during teardown —
        // a session closed right after a reply lost its resume path (caught by
        // the multi-workspace sidebar e2e). It is also redundant: opening a
        // session marks it seen via `activate` / `bootstrapSession`, and the
        // unseen pill only ever describes sessions you are NOT looking at.
        // Live stats from the stream itself (pi >= 0.84.2): every delta
        // carries the streaming message's cumulative usage, so the context
        // meter and burn rate move without an RPC round trip per sub-step.
        if (push.event.type === 'message_update' && push.event.usage) {
          const patched = recordUsageDelta(phosphorId, push.event.usage)
          if (patched) chatStore.setStats(phosphorId, patched)
          const billed = liveBilledTokens(phosphorId)
          if (billed !== null) {
            recordBurnSample(phosphorId, {
              at: Date.now(),
              billed,
              output: patched?.tokens.output ?? 0,
              cacheWrite: patched?.tokens.cacheWrite ?? 0,
            })
          }
        } else if (push.event.type === 'message_end') {
          const message = push.event.message
          const usage = message.role === 'assistant' ? message.usage : undefined
          const patched = recordMessageEnd(phosphorId, usage)
          if (patched) chatStore.setStats(phosphorId, patched)
        }
        if (shouldRefreshStatsOn(push.event.type, hasUsageDeltas(phosphorId))) {
          void refreshStats(phosphorId)
        }
        break
      }
      case 'exit':
        if (!push.expected) {
          chatStore.setError(
            phosphorId,
            `pi exited unexpectedly (code ${push.code ?? 'unknown'}). The session file is preserved.`,
          )
        }
        break
      case 'stderr':
        console.warn(`[pi stderr] ${push.text}`)
        break
      case 'extension-ui':
        void import('./extensionUi').then(({ useExtensionUiStore }) =>
          useExtensionUiStore.getState().handleRequest(phosphorId, push.request),
        )
        break
    }
  })
  unsubscribers.set(phosphorId, unsubscribe)
}

export const useSessionsStore = create<SessionsState>((set, get) => ({
  activeSessionId: null,
  live: {},
  disk: {},
  scanStatus: {},
  unread: {},
  baselines: {},
  pinned: [],
  laneMarkers: {},
  bulkDelete: null,
  suspendedPaths: [],
  seenSessions: {},
  gitByCwd: {},
  creating: false,

  hydratePinned: async () => {
    const prefs = await window.phosphor.invoke('app:getPrefs')
    set({
      pinned: prefs.pinnedSessions,
      seenSessions: prefs.seenSessions ?? {},
      laneMarkers: prefs.laneMarkers ?? {},
    })
  },

  markSeen: (sessionPath) => {
    if (!sessionPath) return
    set((s) => ({ seenSessions: { ...s.seenSessions, [sessionPath]: Date.now() } }))
    void window.phosphor.invoke('app:markSessionSeen', sessionPath)
  },

  refreshGitInfo: async (cwds) => {
    const unique = [...new Set(cwds)].filter(Boolean)
    if (unique.length === 0) return
    try {
      const map = await window.phosphor.invoke('git:infoBatch', unique)
      set((s) => ({ gitByCwd: { ...s.gitByCwd, ...map } }))
    } catch {
      // git unavailable — subtitles just omit their git segments
    }
  },

  refreshDisk: async (workspacePath) => {
    try {
      const metas = await window.phosphor.invoke('sessions:list', workspacePath)
      set((s) => ({
        disk: { ...s.disk, [workspacePath]: metas },
        scanStatus: { ...s.scanStatus, [workspacePath]: 'ok' },
      }))
    } catch {
      // Leave the previous `disk` intact and record the failure so the
      // sidebar can show a retry instead of a permanent fake "Loading…".
      set((s) => ({
        scanStatus: { ...s.scanStatus, [workspacePath]: 'error' },
      }))
    }
  },

  /**
   * Scan several workspaces at once so the sidebar can list every project's
   * sessions, not just the active one.
   *
   * Capped and parallel: the scanner has an mtime+size cache so warm boots
   * are cheap, but a cold start with many known folders would otherwise do
   * unbounded directory walks before first paint.
   *
   * The cap is BY LIST POSITION, which is why lanes used to go missing: they
   * are discovered asynchronously and appended last, so a project with more
   * than a handful of them pushed its own lanes past the cap, and the
   * session-dir watcher (`ignoreInitial: true`) never backfills a file that
   * was already on disk. Collapsing and re-expanding the group was the only
   * thing that scanned them. `refreshMissing` is the other half of the fix:
   * the sidebar calls it for every folder of an EXPANDED group, uncapped.
   */
  refreshAllDisk: async (workspacePaths, limit = 8) => {
    const targets = workspacePaths.slice(0, limit)
    // Capture each `path` explicitly — a rejected inner promise would
    // otherwise drop the `{ path, metas }` wrapper (allSettled's `reason` has
    // no path), making per-workspace status impossible to record.
    const results = await Promise.all(
      targets.map(async (path) => {
        try {
          return {
            path,
            status: 'ok' as const,
            metas: await window.phosphor.invoke('sessions:list', path),
          }
        } catch {
          return { path, status: 'error' as const }
        }
      }),
    )
    set((s) => {
      const disk = { ...s.disk }
      const scanStatus = { ...s.scanStatus }
      for (const result of results) {
        // A workspace that has been deleted just yields no sessions.
        if (result.status === 'ok') {
          disk[result.path] = result.metas
          scanStatus[result.path] = 'ok'
        } else {
          scanStatus[result.path] = 'error'
        }
      }
      return { disk, scanStatus }
    })
  },

  /**
   * Scan only the folders nothing has looked at yet.
   *
   * Idempotent by construction: a scanned folder has a `scanStatus` entry, so
   * calling this on every render of an expanded group settles after one pass.
   * That is what lets the sidebar call it from an effect keyed on the groups
   * themselves without looping.
   */
  refreshMissing: async (workspacePaths) => {
    const { scanStatus } = get()
    const targets = [...new Set(workspacePaths)].filter((path) => !(path in scanStatus))
    if (targets.length === 0) return
    await get().refreshAllDisk(targets, targets.length)
  },

  watchWorkspaces: (workspacePaths) => {
    for (const path of workspacePaths) {
      if (watchedWorkspaces.has(path)) continue
      watchedWorkspaces.add(path)
      void window.phosphor.invoke('sessions:watch', path)
    }
  },

  unwatchWorkspaces: (workspacePaths) => {
    for (const path of workspacePaths) {
      if (!watchedWorkspaces.delete(path)) continue
      void window.phosphor.invoke('sessions:unwatch', path)
    }
  },

  createSession: async (workspacePath, options = {}) => {
    set({ creating: true })
    try {
      const info = await window.phosphor.invoke('pi:createSession', {
        workspacePath,
        sessionPath: options.sessionPath,
        forkFrom: options.forkFrom,
        name: options.name,
      })
      const phosphorId = info.sessionId
      // Resuming from disk means history is on its way; the transcript shows a
      // skeleton instead of the "nothing here yet" empty state until it lands.
      useChatStore.getState().ensure(phosphorId, { resuming: Boolean(options.sessionPath) })
      attachSessionPushHandler(phosphorId)

      // Git baseline for the Files Changed panel ("changes since session start").
      void window.phosphor
        .invoke('git:sessionBaseline', workspacePath)
        .then((ref) => set((s) => ({ baselines: { ...s.baselines, [phosphorId]: ref } })))
        .catch(() => set((s) => ({ baselines: { ...s.baselines, [phosphorId]: null } })))
      set((s) => ({
        live: {
          ...s.live,
          [phosphorId]: { phosphorId, workspacePath, diskPath: options.sessionPath },
        },
        activeSessionId: phosphorId,
        unread: { ...s.unread, [phosphorId]: 0 },
      }))
      // Resumed sessions already know their file; fresh ones learn it from
      // get_state in bootstrapSession, which persists it then.
      if (options.sessionPath) {
        void window.phosphor.invoke('app:setLastSession', options.sessionPath)
      }

      // Resume: hydrate history before metadata so the transcript paints fast.
      if (options.sessionPath) {
        try {
          const messages = await rehydrateTranscript(phosphorId)
          if (messages) {
            // Rebuild artifacts by replaying persisted toolResult messages.
            const { useArtifactsStore } = await import('./artifacts')
            useArtifactsStore.getState().ingestFromHistory(phosphorId, messages)
          }
        } catch {
          // non-fatal
        } finally {
          // hydrate() clears this, but a failed or empty get_messages must not
          // leave the transcript stuck behind a skeleton forever.
          useChatStore.getState().doneResuming(phosphorId)
        }
      }
      // Never rejects (it wraps get_state and allSettles the rest), so the
      // naming chain below can hang off it safely.
      const bootstrapped = bootstrapSession(phosphorId)
      void bootstrapped

      const firstPrompt = options.firstPrompt
      if (firstPrompt) {
        const images = options.firstImages?.length ? options.firstImages : undefined
        useChatStore.getState().addUserMessage(phosphorId, firstPrompt, images)
        void piCallOk(phosphorId, {
          type: 'prompt',
          message: firstPrompt,
          ...(images ? { images } : {}),
        })
        // A brand-new session (not a resume, not explicitly named) gets a
        // generated title once its first message exists. Fire-and-forget: the
        // first-message-derived title stands until (and unless) this lands.
        //
        // Deliberately sequenced AFTER bootstrap rather than fired alongside
        // it. autoNameSession's "pi already named this" guard reads
        // `meta.sessionName`, which ONLY get_state populates — starting both
        // at once made that guard a race it merely tended to win. It also
        // put a subprocess spawn (`pi -p`) in the middle of session startup,
        // competing with the get_state round-trip that "reopen my last
        // session" depends on.
        // `lanes.autoName` is the user preference; `options.autoName` is the
        // caller saying it owns naming itself (startChat does). Either one
        // being false means no pass here.
        const autoNameAllowed = lanePrefs().autoName
        if (
          autoNameAllowed &&
          options.autoName !== false &&
          !options.name &&
          !options.sessionPath
        ) {
          void bootstrapped.then(() => autoNameSession(phosphorId, workspacePath, firstPrompt))
        }
      }
      return phosphorId
    } finally {
      set({ creating: false })
    }
  },

  adoptSession: async (sessionId, workspacePath, diskPath) => {
    if (get().live[sessionId]) return
    useChatStore.getState().ensure(sessionId, { resuming: true })
    attachSessionPushHandler(sessionId)
    set((s) => ({
      // diskPath only when the caller already knows it; `bootstrapSession`'s
      // `get_state` is what supplies it for a reload re-adoption, and resume
      // matching waits on that round trip.
      live: { ...s.live, [sessionId]: { phosphorId: sessionId, workspacePath, diskPath } },
      unread: { ...s.unread, [sessionId]: 0 },
    }))
    try {
      // Works for both cases: a resumed orchestrator replays its history, a
      // freshly spawned one simply has none.
      await rehydrateTranscript(sessionId)
    } catch {
      // non-fatal
    } finally {
      useChatStore.getState().doneResuming(sessionId)
    }
    await bootstrapSession(sessionId)
  },

  openDiskSession: async (workspacePath, meta) => {
    get().markSeen(meta.path)
    // Reopening clears the suspended marker; the resume path below re-spawns pi
    // and the transcript shows its skeleton while history replays.
    if (get().suspendedPaths.includes(meta.path)) {
      set((s) => ({ suspendedPaths: s.suspendedPaths.filter((p) => p !== meta.path) }))
    }
    // Already live? Just activate.
    const existing = Object.values(get().live).find((l) => l.diskPath === meta.path)
    if (existing) {
      get().activate(existing.phosphorId)
      return existing.phosphorId
    }
    return get().createSession(workspacePath, { sessionPath: meta.path })
  },

  activate: (sessionId) => {
    // Activation means "show me this session" (or home, for null), so any
    // global page in the way closes. Direct call rather than a subscription:
    // re-activating the CURRENT session (clicking its sidebar row while a
    // page is up) changes no state a subscriber could see, but must still
    // bring the chat back.
    useLayoutStore.getState().setPage(null)
    set((s) => ({
      activeSessionId: sessionId,
      unread: sessionId ? { ...s.unread, [sessionId]: 0 } : s.unread,
    }))
    // Remember where to reopen next launch. Clearing the session (New) also
    // clears the memory, so we land on the home screen instead.
    const live = sessionId ? get().live[sessionId] : undefined
    void window.phosphor.invoke('app:setLastSession', live?.diskPath)
    if (live?.diskPath) get().markSeen(live.diskPath)
    // Keep the persisted workspace paired with the persisted session —
    // resumeTarget reunites the two on launch, and a stale lastWorkspacePath
    // would resume this session against another project's cwd.
    if (live?.workspacePath) {
      void window.phosphor.invoke('app:recordWorkspace', live.workspacePath)
    }
  },

  disposeSession: async (sessionId) => {
    await window.phosphor.invoke('pi:disposeSession', sessionId)
    await cleanupLocalSessionState(sessionId)
  },

  suspendSession: async (sessionId) => {
    const entry = get().live[sessionId]
    const diskPath = entry?.diskPath
    await get().disposeSession(sessionId)
    // Remember the path (not the phosphorId, which dies with the process) so the
    // sidebar can mark the row "suspended" until it is reopened.
    if (diskPath) markSuspended(diskPath)
  },

  moveSessionToAccount: async (sessionId, accountId) => {
    const entry = get().live[sessionId]
    const diskPath = entry?.diskPath
    if (!entry || !diskPath) return null
    // Binding first: `pi:createSession` reads it while spawning, so a failure
    // here must abort the move rather than restart the lane where it was.
    await window.phosphor.invoke('claude:assignSession', diskPath, accountId)
    await get().disposeSession(sessionId)
    return get().createSession(entry.workspacePath, { sessionPath: diskPath })
  },

  deleteDiskSession: async (workspacePath, meta) => {
    const live = Object.values(get().live).find((l) => l.diskPath === meta.path)
    if (live) await get().disposeSession(live.phosphorId)
    await window.phosphor.invoke('sessions:delete', meta.path)
    await get().refreshDisk(workspacePath)
  },

  /**
   * Delete several lanes, sequentially, reporting per lane.
   *
   * Three things here are deliberate:
   *
   * 1. **Sequential, not `Promise.all`.** Each lane disposes a subprocess and
   *    runs git; N of those at once is how you get a worktree removed while
   *    its own pi is still writing.
   * 2. **Worktree BEFORE session file.** `git worktree remove` is the step
   *    that actually fails in practice — a terminal cwd'd into the lane, or a
   *    dirty tree. Removing it first means a failure leaves the lane whole and
   *    still in the sidebar; the other order leaves a lane whose transcript is
   *    in the Trash and whose directory is still on disk, which is worse than
   *    doing nothing.
   * 3. **A failure is reported, never swallowed.** A row that silently stays
   *    put reads as the delete having worked and the UI being stale.
   */
  cancelBulkDelete: () => {
    bulkDeleteCancelled = true
    set((s) => (s.bulkDelete ? { bulkDelete: { ...s.bulkDelete, cancelled: true } } : s))
  },

  dismissBulkDelete: () => set({ bulkDelete: null }),

  deleteManySessions: async (workspacePath, lanes, options) => {
    const results: LaneDeleteResult[] = []
    bulkDeleteCancelled = false
    set({
      bulkDelete: {
        total: lanes.length,
        done: 0,
        current: lanes[0]?.title ?? '',
        lanes: lanes.map((lane) => ({ path: lane.path, title: lane.title })),
        results: [],
        running: true,
        cancelled: false,
      },
    })

    const publish = (current: string): void =>
      set((s) =>
        s.bulkDelete
          ? {
              bulkDelete: { ...s.bulkDelete, done: results.length, current, results: [...results] },
            }
          : s,
      )

    const { removeWorktree } = await import('./worktrees').then((m) => ({
      removeWorktree: m.useWorktreesStore.getState().removeWorktree,
    }))

    for (const lane of lanes) {
      // Checked between lanes, never mid-lane: stopping halfway through a
      // worktree removal is how you get a half-deleted lane.
      if (bulkDeleteCancelled) break
      publish(lane.title)

      const live = Object.values(get().live).find((l) => l.diskPath === lane.path)
      if (live) await get().disposeSession(live.phosphorId)

      if (options.removeWorktree && lane.worktreePath && lane.mainRepoPath) {
        try {
          const outcome = await removeWorktree(lane.mainRepoPath, lane.worktreePath, {
            force: options.discardChanges,
            deleteBranch: options.deleteBranch,
          })
          if (!outcome.removed) {
            results.push({
              path: lane.path,
              title: lane.title,
              ok: false,
              error: `worktree kept, ${outcome.dirtyCount} uncommitted change${
                outcome.dirtyCount === 1 ? '' : 's'
              }`,
            })
            publish(lane.title)
            continue
          }
          if (outcome.branchError) {
            // A branch that would not safe-delete is reported, but the lane is
            // still gone: `git branch -d` refusing is not a reason to keep the
            // transcript. Never escalate to -D here.
            await window.phosphor.invoke('sessions:delete', lane.path)
            results.push({
              path: lane.path,
              title: lane.title,
              ok: true,
              error: outcome.branchError,
            })
            publish(lane.title)
            continue
          }
        } catch (error) {
          results.push({ path: lane.path, title: lane.title, ok: false, error: String(error) })
          publish(lane.title)
          continue
        }
      }

      try {
        await window.phosphor.invoke('sessions:delete', lane.path)
        results.push({ path: lane.path, title: lane.title, ok: true })
      } catch (error) {
        results.push({ path: lane.path, title: lane.title, ok: false, error: String(error) })
      }
      publish(lane.title)
    }

    // Forget markers for lanes that are actually gone, so the prefs map does
    // not accumulate entries for paths that no longer exist.
    const gone = new Set(results.filter((r) => r.ok).map((r) => r.path))
    if (gone.size > 0) {
      set((s) => {
        const laneMarkers = { ...s.laneMarkers }
        for (const path of gone) delete laneMarkers[path]
        void window.phosphor.invoke('app:setLaneMarkers', laneMarkers)
        return { laneMarkers }
      })
    }

    await get().refreshDisk(workspacePath)
    set((s) =>
      s.bulkDelete
        ? {
            bulkDelete: {
              ...s.bulkDelete,
              done: results.length,
              current: '',
              results,
              running: false,
            },
          }
        : s,
    )
    return results
  },

  setLaneMarker: (path, marker) => {
    set((s) => {
      const laneMarkers = { ...s.laneMarkers }
      if (marker === null) delete laneMarkers[path]
      else laneMarkers[path] = marker
      void window.phosphor.invoke('app:setLaneMarkers', laneMarkers)
      return { laneMarkers }
    })
  },

  togglePin: (path) => {
    set((s) => {
      const pinned = s.pinned.includes(path)
        ? s.pinned.filter((p) => p !== path)
        : [...s.pinned, path]
      void window.phosphor.invoke('app:setPinnedSessions', pinned)
      return { pinned }
    })
  },
}))
