import { app } from 'electron'
import { parseLaneMoveRequest } from '@shared/lane-move'
import { broadcast } from '../broadcast'
import { log } from '../debug-log'
import type { createHostManager } from '../hosts/manager'
import { createLaneMoves } from '../lane-move/move'
import { getPrefs, markSessionSeen, setLaneMarkers, setPinnedSessions } from '../store'
import { handle } from './handle'

const INVALID = 'This lane cannot move.'

/** Moving lanes between This Mac and Hosts, or between workspaces on one machine. */
export function registerLaneMoveHandlers(
  manager: Pick<ReturnType<typeof createHostManager>, 'connection' | 'label'>,
): void {
  const moves = createLaneMoves({
    connection: manager.connection,
    label: manager.label,
    branchPrefix: () => getPrefs().worktrees.branchPrefix,
    tempDir: () => app.getPath('temp'),
    log: (message, data) => log('lane-move', message, data),
  })
  handle('hosts:laneMovePlan', (_event, request) => {
    const parsed = parseLaneMoveRequest(request)
    if (!parsed) throw new Error(INVALID)
    return moves.plan(parsed)
  })
  handle('hosts:laneMove', async (_event, request) => {
    const parsed = parseLaneMoveRequest(request)
    if (!parsed) throw new Error(INVALID)
    const result = await moves.move(parsed)
    if ('sessionPath' in result) {
      const prefs = getPrefs()
      if (parsed.marks.pinned)
        setPinnedSessions([...new Set([...prefs.pinnedSessions, result.sessionPath])])
      if (parsed.marks.marker !== null)
        setLaneMarkers({ ...prefs.laneMarkers, [result.sessionPath]: parsed.marks.marker })
      markSessionSeen(result.sessionPath)
      // A new worktree is a folder no window watches yet; this is how the sidebar finds it.
      broadcast('sessions:changed', { workspacePath: result.workspace })
    }
    return result
  })
}
