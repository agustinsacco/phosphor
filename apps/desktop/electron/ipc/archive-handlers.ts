import { archiveLocalLane, purgeLocalArchive, restoreLocalArchive } from '../archive/operations'
import { localArchives } from '../archive/state'
import { handle } from './handle'

export function registerArchiveHandlers(): void {
  handle('sessions:archive', (_event, cwd, path, sessionId) =>
    archiveLocalLane(cwd, path, sessionId),
  )
  handle('sessions:archives', (_event, measure) => localArchives().inventory.list(measure))
  handle('sessions:restoreArchive', (_event, id) => restoreLocalArchive(id))
  handle('sessions:purgeArchive', (_event, id, removeWorktree) =>
    purgeLocalArchive(id, removeWorktree),
  )
}
