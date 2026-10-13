import type { LaneOp } from '@phosphor/shared/host-protocol'
import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
import { prepareLaneFolder } from './worktree'
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
export async function createLane(
  ports: { store: HostStore; sessions: LaneSessions; log: RuntimeLog },
  input: { root: string; op: Extract<LaneOp, { type: 'lane.create' }>; controller: Controller },
): Promise<StoredLane> {
  const { op, controller } = input
  const folder = await prepareLaneFolder({
    root: input.root,
    worktree: op.worktree,
    log: ports.log,
  })
  let sessionId: string | undefined
  let laneId: string | undefined
  try {
    const session = await ports.sessions.start({
      repository: folder.cwd,
      ...(op.provider === undefined || op.model === undefined ? {} : { provider: op.provider }),
      ...(op.model === undefined ? {} : { model: op.model }),
      ...(op.thinkingLevel === undefined ? {} : { thinkingLevel: op.thinkingLevel }),
      ...(op.name === undefined ? {} : { name: op.name }),
    })
    sessionId = session.sessionId
    const lane = ports.store.ensureLane(
      {
        repositoryId: op.repositoryId,
        cwd: folder.cwd,
        sessionFile: session.sessionFile,
        worktree: op.worktree !== null,
        title: op.name ?? null,
        branch: folder.branch,
        provider: op.provider !== undefined && op.model !== undefined ? op.provider : null,
        model: op.provider !== undefined && op.model !== undefined ? op.model : null,
      },
      { controller },
    )
    laneId = lane.laneId
    await ports.sessions.attach(laneId, sessionId)
    return lane
  } catch (error) {
    if (laneId !== undefined) {
      try {
        ports.store.markRemoved(laneId)
      } catch {
        // Cleanup cannot replace the start or attachment error.
      }
    }
    if (sessionId !== undefined) {
      try {
        await ports.sessions.stop(sessionId)
      } catch {
        // Stop may throw before returning a promise.
      }
    }
    await folder.undo()
    throw error
  }
}
