import type { LaneCreatePhase, LaneOp } from '@phosphor/shared/host-protocol'
import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
import { prepareCreationFolder } from './create-folder'
import type { RepositoryLocks } from './repository-lock'
import { gitTracksFolder, type LaneFolder } from './worktree'
import type { Controller, HostStore, StoredLane } from './store'

export interface LaneSessions {
  start(input: {
    repository: string
    provider?: string
    model?: string
    thinkingLevel?: string
    name?: string
  }): Promise<{ sessionId: string; sessionFile: string | null }>
  attach(laneId: string, sessionId: string): Promise<void>
  stop(sessionId: string): Promise<void>
}
type CreateOp = Extract<LaneOp, { type: 'lane.create' }>
type CreateLanePorts = {
  store: HostStore
  sessions: LaneSessions
  log: RuntimeLog
  /** Serializes worktree work per repository; see repository-lock.ts. */
  folders: RepositoryLocks
  closed?: () => boolean
}

export async function createLane(
  ports: CreateLanePorts,
  input: {
    root: string
    op: CreateOp
    controller: Controller
    onStored?: (laneId: string) => void
    /** Progress for the creating client. It is a report only: a throw is ignored. */
    phase?: (phase: LaneCreatePhase) => void
  },
): Promise<StoredLane> {
  const { op, controller } = input
  const phase = (reached: LaneCreatePhase) => {
    try {
      input.phase?.(reached)
    } catch {
      // Progress cannot change the creation.
    }
  }
  // Clients offer "new branch" for every Host folder. Where git does not track the
  // folder, the lane runs in place, as This Mac does when it hides that toggle.
  const worktree = op.worktree && (await gitTracksFolder(input.root)) ? op.worktree : null
  const folder = await prepareCreationFolder({
    root: input.root,
    worktree,
    locks: ports.folders,
    phase,
    log: ports.log,
  })
  let sessionId: string | undefined
  let laneId: string | undefined
  try {
    phase('starting')
    const session = await ports.sessions.start(startOptions(op, folder.cwd))
    sessionId = session.sessionId
    if (ports.closed?.()) throw new Error('lane commands closed')
    const lane = ports.store.ensureLane(
      {
        repositoryId: op.repositoryId,
        cwd: folder.cwd,
        sessionFile: session.sessionFile,
        worktree: worktree !== null,
        title: op.name ?? null,
        branch: folder.branch,
        provider: op.provider !== undefined && op.model !== undefined ? op.provider : null,
        model: op.provider !== undefined && op.model !== undefined ? op.model : null,
      },
      { controller },
    )
    laneId = lane.laneId
    input.onStored?.(laneId)
    if (ports.closed?.()) throw new Error('lane commands closed')
    await ports.sessions.attach(laneId, sessionId)
    return lane
  } catch (error) {
    await rollBack(ports, { laneId, sessionId, folder })
    throw error
  }
}

function startOptions(op: CreateOp, repository: string): Parameters<LaneSessions['start']>[0] {
  return {
    repository,
    ...(op.provider === undefined || op.model === undefined ? {} : { provider: op.provider }),
    ...(op.model === undefined ? {} : { model: op.model }),
    ...(op.thinkingLevel === undefined ? {} : { thinkingLevel: op.thinkingLevel }),
    ...(op.name === undefined ? {} : { name: op.name }),
  }
}

/** Undo what a failed creation made. Cleanup errors never replace the original one. */
async function rollBack(
  ports: CreateLanePorts,
  made: { laneId: string | undefined; sessionId: string | undefined; folder: LaneFolder },
): Promise<void> {
  if (made.laneId !== undefined && !ports.closed?.()) {
    try {
      ports.store.markRemoved(made.laneId)
    } catch {
      // Cleanup cannot replace the start or attachment error.
    }
  }
  if (made.sessionId !== undefined) {
    try {
      await ports.sessions.stop(made.sessionId)
    } catch {
      // Stop may throw before returning a promise.
    }
  }
  await made.folder.undo()
}
