import { app } from 'electron'
import { parseLaneMoveRequest } from '@shared/lane-move'
import type { createHostManager } from '../hosts/manager'
import { createLaneMoves } from '../lane-move/move'
import { getPrefs } from '../store'
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
  })
  handle('hosts:laneMovePlan', (_event, request) => {
    const parsed = parseLaneMoveRequest(request)
    if (!parsed) throw new Error(INVALID)
    return moves.plan(parsed)
  })
  handle('hosts:laneMove', (_event, request) => {
    const parsed = parseLaneMoveRequest(request)
    if (!parsed) throw new Error(INVALID)
    return moves.move(parsed)
  })
}
