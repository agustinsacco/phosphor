import { handle } from './handle'
import { checkoutMissing, retainedWorkspaces, setCompleted } from '../maintenance/conversations'
import { decorateSession } from '../maintenance/history'
import { restoreWorktree } from '../maintenance/removal'
import { unwatchWorkspaceSessions, watchWorkspaceSessions } from '../pi/session-watcher'
import {
  listSessions,
  readSessionTree,
  readSavedTranscript,
  workspaceStats,
} from '../pi/session-scanner'
import { deleteLane } from '../pi/delete-lane'
import { appendBranchJump, appendLabel, forkSessionAt } from '../pi/session-writer'
import { withOfflineSessionMutation, withSessionForkSource } from '../pi/session-mutation'
import { claudeSessionIdFor } from '../pi/claude-session-map'
import { forkClaudeLedgerForClone } from '../pi/claude-ledger'

/** On-disk session discovery, tree reading and history rewrites. */
export function registerSessionsHandlers(): void {
  handle('sessions:list', async (_event, workspacePath: string) =>
    (await listSessions(workspacePath)).map((meta) =>
      decorateSession(meta, checkoutMissing(workspacePath)),
    ),
  )
  handle('sessions:setCompleted', (_event, path, completed) => setCompleted(path, completed))
  handle('sessions:retainedWorkspaces', (_event, repoPath) => retainedWorkspaces(repoPath))
  handle('sessions:restoreWorktree', (_event, path) => restoreWorktree(path))

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
  handle('sessions:appendLabel', async (_event, sessionFilePath, targetId, label) => {
    await withOfflineSessionMutation(sessionFilePath, () =>
      appendLabel(sessionFilePath, targetId, label),
    )
  })

  handle('sessions:jump', async (_event, sessionFilePath, targetId) => {
    await withOfflineSessionMutation(sessionFilePath, () =>
      appendBranchJump(sessionFilePath, targetId),
    )
  })

  handle('sessions:forkAt', (_event, sessionFilePath, targetId) =>
    withSessionForkSource(sessionFilePath, () => forkSessionAt(sessionFilePath, targetId)),
  )

  handle('sessions:claudeSessionId', (_event, piSessionId: string) =>
    claudeSessionIdFor(piSessionId),
  )

  handle('sessions:forkClaudeLedger', (_event, cloneSessionFile: string) =>
    forkClaudeLedgerForClone(cloneSessionFile),
  )
}
