import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import type { SessionMeta, WorktreeInfo } from '@shared/models'
import { useSessionsStore } from '@/stores/sessions'
import { useChatStore } from '@/stores/chat'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { usePullRequestsStore, pullRequestFor } from '@/stores/pullRequests'
import { useWorktreesStore, repoWorktrees } from '@/stores/worktrees'
import { MergeWorktreeModal } from '@/features/worktrees/MergeWorktreeModal'
import {
  LANE_STATES,
  LANE_STATE_LABEL,
  buildLaneBoard,
  type BoardLane,
  type LaneBoard as Board,
  type LaneInput,
  type LaneState,
} from './laneState'

export interface LaneBoardData {
  board: Board
  /** Session file path → its meta, for opening a lane. */
  metaByPath: Map<string, SessionMeta>
  /** The project's main checkout — the repo every lane here belongs to. */
  projectRoot: string
  /** Every lane of this project, for the ledger's per-lane spend. */
  lanes: SessionMeta[]
}

/**
 * This project's lanes, joined from the projections the renderer already has.
 *
 * A hook rather than a store: the disk scan, `gitByCwd`, the PR store, the
 * dialog store and the chat store each already maintain one of these facts, so
 * a store of its own would be a fifth copy of the same state to keep in sync —
 * which is the mistake the fleet hub made and the reason it was removed.
 */
export function useLaneBoard(workspacePath: string): LaneBoardData {
  const disk = useSessionsStore((s) => s.disk)
  const gitByCwd = useSessionsStore((s) => s.gitByCwd)
  const live = useSessionsStore((s) => s.live)
  const chatSessions = useChatStore((s) => s.sessions)
  const dialogs = useExtensionUiStore((s) => s.dialogs)
  const prByRepo = usePullRequestsStore((s) => s.byRepo)

  /** This project is its main checkout plus every worktree folded into it. */
  const projectRoot = gitByCwd[workspacePath]?.mainRepoPath ?? workspacePath

  // The sidebar refreshes this map too, and the store collapses concurrent
  // and recent calls itself — so asking here costs nothing and stops the
  // board from depending on whether the project's group happens to be open.
  useEffect(() => {
    void usePullRequestsStore.getState().refresh(projectRoot)
  }, [projectRoot])

  const lanes = useMemo(() => {
    const out: SessionMeta[] = []
    for (const [folder, list] of Object.entries(disk)) {
      const git = gitByCwd[folder]
      if ((git?.mainRepoPath ?? folder) !== projectRoot) continue
      out.push(...list)
    }
    return out
  }, [disk, gitByCwd, projectRoot])

  const board = useMemo(() => {
    // Live sessions join their row by disk path, the same join the sidebar
    // uses. A session whose path has not landed yet simply has no card.
    const liveByDisk = new Map<string, string>()
    for (const entry of Object.values(live)) {
      if (entry.diskPath) liveByDisk.set(entry.diskPath, entry.phosphorId)
    }
    const asking = new Set(dialogs.map((d) => d.sessionId))
    const inputs: LaneInput[] = lanes.map((meta) => {
      const phosphorId = liveByDisk.get(meta.path)
      const git = gitByCwd[meta.cwd]
      const pr = pullRequestFor({ byRepo: prByRepo }, projectRoot, git?.branch)
      return {
        meta,
        ...(git ? { git } : {}),
        ...(phosphorId ? { phosphorId } : {}),
        ...(pr ? { pr } : {}),
        isStreaming: phosphorId ? (chatSessions[phosphorId]?.isStreaming ?? false) : false,
        hasPendingQuestion: phosphorId ? asking.has(phosphorId) : false,
      }
    })
    return buildLaneBoard(inputs)
  }, [lanes, gitByCwd, live, chatSessions, dialogs, prByRepo, projectRoot])

  const metaByPath = useMemo(() => new Map(lanes.map((m) => [m.path, m])), [lanes])
  return { board, metaByPath, projectRoot, lanes }
}

/**
 * The board itself: one column per state that has anything in it.
 *
 * Renders nothing when no lane needs anything. An empty board is a status
 * display, and the home screen already has one of those.
 */
export function LaneBoard({ data }: { data: LaneBoardData }): React.JSX.Element | null {
  const { board, metaByPath, projectRoot } = data
  const [merging, setMerging] = useState<{ repoPath: string; worktree: WorktreeInfo } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const filled = LANE_STATES.filter((state) => board.columns[state].length > 0)
  if (filled.length === 0) return null

  const openLane = (lane: BoardLane): void => {
    const meta = metaByPath.get(lane.path)
    if (meta) void useSessionsStore.getState().openDiskSession(meta.cwd, meta)
  }

  const act = async (lane: BoardLane): Promise<void> => {
    if (lane.action === 'merge') {
      // Reuse the sidebar's merge flow rather than writing a second one: it
      // already handles a dirty worktree, the commit step and the failures.
      await useWorktreesStore.getState().refresh(projectRoot)
      const worktree = repoWorktrees(useWorktreesStore.getState(), projectRoot).worktrees.find(
        (w) => w.realPath === lane.workspacePath,
      )
      if (worktree) setMerging({ repoPath: projectRoot, worktree })
      else openLane(lane)
      return
    }
    if (lane.action === 'update') {
      setBusy(lane.path)
      try {
        await useWorktreesStore.getState().updateFromMain(projectRoot, lane.workspacePath)
      } finally {
        setBusy(null)
      }
      return
    }
    // `answer` and `open` are the same motion: a question renders on the
    // session it belongs to, so opening the lane is what puts it on screen.
    openLane(lane)
  }

  return (
    <div className="mt-6 w-full" data-testid="lane-board">
      {/* Track count is data-dependent and Tailwind cannot see a computed
          class, so this is an inline style. Capped at four: all five states
          can be filled at once, and five columns in a 768px page is
          unreadable — the fifth wraps to a second row instead. */}
      <div
        className="grid gap-2"
        style={{ gridTemplateColumns: `repeat(${Math.min(filled.length, 4)}, minmax(0, 1fr))` }}
      >
        {filled.map((state) => (
          <div key={state} className="min-w-0">
            <div className="text-text-tertiary mb-1.5 flex items-center gap-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider">
              {LANE_STATE_LABEL[state]}
              <span className="text-accent">{board.columns[state].length}</span>
            </div>
            {board.columns[state].map((lane) => (
              <LaneCard
                key={lane.path}
                lane={lane}
                busy={busy === lane.path}
                onAct={() => void act(lane)}
                onOpen={() => openLane(lane)}
              />
            ))}
          </div>
        ))}
      </div>
      {board.idleCount > 0 && (
        <div className="text-text-tertiary mt-2 font-mono text-[11px]">
          {board.idleCount} idle lane{board.idleCount > 1 ? 's' : ''}
        </div>
      )}
      {merging && (
        <MergeWorktreeModal
          repoPath={merging.repoPath}
          worktree={merging.worktree}
          onClose={() => setMerging(null)}
        />
      )}
    </div>
  )
}

const ACTION_LABEL: Record<BoardLane['action'], string> = {
  answer: 'Answer',
  merge: 'Merge',
  update: 'Update',
  open: 'Open',
}

const STATE_ACCENT: Record<LaneState, string> = {
  blocked: 'border-info/40',
  ready: 'border-success/40',
  attention: 'border-warning/40',
  review: 'border-border',
  running: 'border-border',
}

function LaneCard({
  lane,
  busy,
  onAct,
  onOpen,
}: {
  lane: BoardLane
  busy: boolean
  onAct: () => void
  onOpen: () => void
}): React.JSX.Element {
  return (
    <div
      className={clsx('bg-surface mb-1.5 rounded-lg border p-2', STATE_ACCENT[lane.state])}
      data-testid="lane-board-card"
    >
      <button
        type="button"
        onClick={onOpen}
        className="text-text hover:text-accent block w-full truncate text-left text-sm"
        title={lane.title}
      >
        {lane.title}
      </button>
      <div className="text-text-tertiary mt-0.5 truncate font-mono text-[10px]">
        {lane.pr ? `#${lane.pr.number} · ` : ''}
        {lane.detail}
      </div>
      {lane.action !== 'open' && (
        <button
          type="button"
          onClick={onAct}
          disabled={busy}
          className="border-accent text-accent hover:bg-accent-soft mt-1.5 rounded-md border px-2.5 py-0.5 text-xs font-semibold disabled:opacity-50"
        >
          {busy ? '…' : ACTION_LABEL[lane.action]}
        </button>
      )}
    </div>
  )
}
