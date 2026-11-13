import { useMemo, useState } from 'react'
import clsx from 'clsx'
import type { GhPrRef, SessionMeta, WorktreeInfo } from '@shared/models'
import { useSessionsStore } from '@/stores/sessions'
import { useChatStore } from '@/stores/chat'
import { useLayoutStore } from '@/stores/layout'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { usePullRequestsStore, repoPullRequests } from '@/stores/pullRequests'
import { usePrStatusStore } from '@/stores/prStatus'
import { usePrStatusRefresh, useRepoPrRefresh } from '@/features/sessions/repoPrRefresh'
import { laneStatusRefs, resolveLanePrs } from '@/features/sessions/lanePrs'
import { useWorktreesStore, repoWorktrees } from '@/stores/worktrees'
import { hasDelegatedWork, SUBAGENT_ASYNC_WIDGET_KEY } from '@/features/chat/subagentRuns'
import { MergeWorktreeModal } from '@/features/worktrees/MergeWorktreeModal'
import { Button } from '@/components/form'
import { PrBadge } from '@/features/sessions/PrBadge'
import { LaneCard } from './LaneCard'
import { LaneActivity } from './LaneActivity'
import {
  LANE_STATE_LABEL,
  buildLaneBoard,
  retainLaneOrder,
  type WorkbenchLane,
  type LaneBoard as Board,
  type LaneInput,
} from './laneState'

export interface LaneBoardData {
  board: Board
  /** Session file path → its meta, for opening a lane. */
  metaByPath: Map<string, SessionMeta>
  /** The project's main checkout — the repo every lane here belongs to. */
  projectRoot: string
  /** Every recorded lane of this project, for the ledger's per-lane spend. */
  lanes: SessionMeta[]
}

/** Join existing projections only. No dashboard polling or second session registry. */
export function useLaneBoard(workspacePath: string): LaneBoardData {
  const disk = useSessionsStore((s) => s.disk)
  const gitByCwd = useSessionsStore((s) => s.gitByCwd)
  const live = useSessionsStore((s) => s.live)
  const chatSessions = useChatStore((s) => s.sessions)
  const dialogs = useExtensionUiStore((s) => s.dialogs)
  const widgets = useExtensionUiStore((s) => s.widgets)
  const projectRoot = gitByCwd[workspacePath]?.mainRepoPath ?? workspacePath
  const prSlice = usePullRequestsStore((s) => repoPullRequests(s, projectRoot))
  const prStatus = usePrStatusStore((s) => s.byKey)

  const covered = useLayoutStore((s) => s.page !== null)
  useRepoPrRefresh(covered ? [] : [projectRoot])

  const lanes = useMemo(() => {
    const out: SessionMeta[] = []
    for (const [folder, list] of Object.entries(disk)) {
      if ((gitByCwd[folder]?.mainRepoPath ?? folder) === projectRoot) out.push(...list)
    }
    return out
  }, [disk, gitByCwd, projectRoot])

  const { board, refs } = useMemo(() => {
    const refs: GhPrRef[] = []
    const liveByDisk = new Map<string, string>()
    for (const entry of Object.values(live)) {
      if (entry.diskPath) liveByDisk.set(entry.diskPath, entry.phosphorId)
    }
    const asking = new Set(dialogs.map((d) => d.sessionId))
    const input = (meta: LaneInput['meta'], phosphorId?: string): LaneInput => {
      const git = gitByCwd[meta.cwd]
      const chat = phosphorId ? chatSessions[phosphorId] : undefined
      const prs = resolveLanePrs({
        signals: 'pullRequests' in meta ? (meta as SessionMeta).pullRequests : undefined,
        branch: git?.branch,
        slice: prSlice,
        status: prStatus,
      })
      refs.push(...laneStatusRefs(prs))
      return {
        meta: { ...meta, name: chat?.meta?.sessionName ?? meta.name },
        git,
        phosphorId,
        prs: prs.owned,
        isStreaming: !!(chat?.isStreaming || chat?.promptSentAt),
        hasPendingQuestion: phosphorId ? asking.has(phosphorId) : false,
        hasDelegatedWork: phosphorId
          ? hasDelegatedWork(widgets[phosphorId]?.[SUBAGENT_ASYNC_WIDGET_KEY]?.lines)
          : false,
      }
    }
    const inputs = lanes.map((meta) => input(meta, liveByDisk.get(meta.path)))
    const paths = new Set(lanes.map((meta) => meta.path))
    // Pi saves at turn end. First-turn lanes must not vanish from the workbench.
    for (const entry of Object.values(live)) {
      if (entry.diskPath && paths.has(entry.diskPath)) continue
      if ((gitByCwd[entry.workspacePath]?.mainRepoPath ?? entry.workspacePath) !== projectRoot)
        continue
      const chat = chatSessions[entry.phosphorId]
      inputs.push(
        input(
          {
            path: entry.diskPath ?? entry.phosphorId,
            cwd: entry.workspacePath,
            firstUserText: chat?.items.find((item) => item.kind === 'user')?.text,
            cost: 0,
            lastActivityAt: '',
            mtimeMs: 0,
          },
          entry.phosphorId,
        ),
      )
    }
    return { board: buildLaneBoard(inputs), refs }
  }, [lanes, gitByCwd, live, chatSessions, dialogs, widgets, prSlice, prStatus, projectRoot])
  usePrStatusRefresh(covered ? [] : refs)

  const metaByPath = useMemo(() => new Map(lanes.map((m) => [m.path, m])), [lanes])
  return { board, metaByPath, projectRoot, lanes }
}

/** Stable tiles: completion changes a tile's state, not its position or presence. */
export function LaneBoard({ data }: { data: LaneBoardData }): React.JSX.Element | null {
  const { board, metaByPath, projectRoot } = data
  const [merging, setMerging] = useState<{ repoPath: string; worktree: WorktreeInfo } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  // Live identity survives the first disk scan. Local state holds only ordering.
  const [order, setOrder] = useState<ReturnType<typeof retainLaneOrder>>([])
  const next = retainLaneOrder(order, board.lanes)
  if (next !== order) setOrder(next)
  const byPath = new Map(board.lanes.map((lane) => [lane.path, lane]))
  if (board.lanes.length === 0) return null

  const openLane = (lane: WorkbenchLane): void => {
    const meta = metaByPath.get(lane.path)
    if (meta) void useSessionsStore.getState().openDiskSession(meta.cwd, meta)
    else if (lane.phosphorId) useSessionsStore.getState().activate(lane.phosphorId)
  }

  const act = async (lane: WorkbenchLane): Promise<void> => {
    if (lane.action === 'merge') {
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
    openLane(lane)
  }

  return (
    <section className="mt-6 w-full" aria-label="Lane workbench" data-testid="lane-board">
      <div className="text-text-secondary mb-3 flex flex-wrap justify-between gap-2 text-base">
        <span>
          {board.lanes.length} lane{board.lanes.length === 1 ? '' : 's'} ·{' '}
          {board.columns.running.length} running · {board.idleCount} idle
        </span>
        <span className="font-mono text-xs uppercase tracking-wider">
          Stable positions · live activity
        </span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,20rem),1fr))] gap-4">
        {next.map((position) => {
          const lane = byPath.get(position.path)!
          return (
            <LaneCard
              key={position.key}
              title={lane.title}
              onOpen={() => openLane(lane)}
              status={
                <>
                  <span className={clsx('uppercase tracking-wider', STATE_ACCENT[lane.state])}>
                    {lane.state === 'idle' ? 'Idle' : LANE_STATE_LABEL[lane.state]}
                  </span>
                  <PrBadge prs={lane.prs} />
                </>
              }
              detail={lane.detail}
              branch={lane.branch}
              action={
                <Button
                  size="sm"
                  disabled={busy === lane.path}
                  onClick={() => void act(lane)}
                  className="shrink-0"
                >
                  {busy === lane.path ? 'Updating…' : ACTION_LABEL[lane.action]}
                </Button>
              }
            >
              <LaneActivity lane={lane} />
            </LaneCard>
          )
        })}
      </div>
      {merging && (
        <MergeWorktreeModal
          repoPath={merging.repoPath}
          worktree={merging.worktree}
          onClose={() => setMerging(null)}
        />
      )}
    </section>
  )
}

const ACTION_LABEL: Record<WorkbenchLane['action'], string> = {
  answer: 'Answer',
  merge: 'Review merge',
  update: 'Update',
  open: 'Open lane',
}
const STATE_ACCENT: Record<WorkbenchLane['state'], string> = {
  blocked: 'text-accent',
  ready: 'text-success',
  attention: 'text-warning',
  review: 'text-info',
  running: 'text-accent',
  idle: 'text-text-secondary',
}
