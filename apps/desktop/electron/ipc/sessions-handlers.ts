import { registerArchiveHandlers } from './archive-handlers'
import { handle } from './handle'
import { checkoutMissing, retainedWorkspaces, setCompleted } from '../maintenance/conversations'
import { decorateSession } from '../maintenance/history'
import { restoreWorktree } from '../maintenance/removal'
import { recreateWorktree, worktreeRecovery } from '../maintenance/recovery'
import { unwatchWorkspaceSessions, watchWorkspaceSessions } from '../pi/session-watcher'
import {
  listSessions,
  readSessionTree,
  readSavedTranscript,
  workspaceStats,
} from '../pi/session-scanner'
import { deleteLane } from '../pi/delete-lane'
import { appendBranchJump, appendLabel, forkSessionAt } from '../pi/session-mutation'
import { claudeSessionIdFor } from '@phosphor/session-runtime/claude/session-map'
import { forkClaudeLedgerForClone } from '@phosphor/session-runtime/claude/ledger'

/** On-disk session discovery, tree reading and history rewrites. */
export function registerSessionsHandlers(): void {
  registerArchiveHandlers()
  handle('sessions:list', async (_event, workspacePath: string) =>
    (await listSessions(workspacePath)).map((meta) =>
      decorateSession(meta, checkoutMissing(workspacePath)),
    ),
  )
  handle('sessions:setCompleted', (_event, path, completed) => setCompleted(path, completed))
  handle('sessions:retainedWorkspaces', (_event, repoPath) => retainedWorkspaces(repoPath))
  handle('sessions:restoreWorktree', (_event, path) => restoreWorktree(path))
  handle('sessions:worktreeRecovery', (_event, path) => worktreeRecovery(path))
  handle('sessions:recreateWorktree', (_event, path, source) => recreateWorktree(path, source))

  handle('sessions:stats', (_event, workspacePath: string) => workspaceStats(workspacePath))

  handle('sessions:watch', (_event, workspacePath: string) => {
    watchWorkspaceSessions(workspacePath)
  })

  handle('sessions:unwatch', async (_event, workspacePath: string) => {
    await unwatchWorkspaceSessions(workspacePath)
  })

  handle('sessions:delete', (_event, sessionFilePath, sessionId) =>
    deleteLane(sessionFilePath, sessionId),
  )

  handle('sessions:readTree', (_event, sessionFilePath: string) => readSessionTree(sessionFilePath))
  handle('sessions:readTranscript', (_event, path) => readSavedTranscript(path))

  // The lock is taken synchronously, before any await, so call order is lock order.
  handle('sessions:appendLabel', (_event, sessionFilePath, targetId, label) =>
    appendLabel(sessionFilePath, targetId, label),
  )
  handle('sessions:jump', (_event, sessionFilePath, targetId) =>
    appendBranchJump(sessionFilePath, targetId),
  )
  handle('sessions:forkAt', (_event, sessionFilePath, targetId) =>
    forkSessionAt(sessionFilePath, targetId),
  )

  handle('sessions:claudeSessionId', (_event, piSessionId: string) =>
    claudeSessionIdFor(piSessionId),
  )

  handle('sessions:forkClaudeLedger', (_event, cloneSessionFile: string) =>
    forkClaudeLedgerForClone(cloneSessionFile),
  )
}
