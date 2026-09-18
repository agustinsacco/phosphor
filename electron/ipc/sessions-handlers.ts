import { handle } from './handle'
import { unwatchWorkspaceSessions, watchWorkspaceSessions } from '../pi/session-watcher'
import { listSessions, readSessionTree, workspaceStats } from '../pi/session-scanner'
import { deleteLane } from '../pi/delete-lane'
import { appendBranchJump, appendLabel, forkSessionAt } from '../pi/session-writer'
import { claudeSessionIdFor } from '../pi/claude-session-map'
import { forkClaudeLedgerForClone, resetClaudeLedgerPairing } from '../pi/claude-ledger'
import { log } from '../debug-log'

/** On-disk session discovery, tree reading and history rewrites. */
export function registerSessionsHandlers(): void {
  handle('sessions:list', (_event, workspacePath: string) => listSessions(workspacePath))

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

  handle('sessions:appendLabel', async (_event, sessionFilePath, targetId, label) => {
    await appendLabel(sessionFilePath, targetId, label)
  })

  handle('sessions:jump', async (_event, sessionFilePath, targetId) => {
    await appendBranchJump(sessionFilePath, targetId)
  })

  handle('sessions:forkAt', (_event, sessionFilePath, targetId) =>
    forkSessionAt(sessionFilePath, targetId),
  )

  handle('sessions:claudeSessionId', (_event, piSessionId: string) =>
    claudeSessionIdFor(piSessionId),
  )

  handle('sessions:forkClaudeLedger', (_event, cloneSessionFile: string) =>
    forkClaudeLedgerForClone(cloneSessionFile),
  )

  handle('sessions:resetClaudeContext', async (_event, sessionFilePath: string) => {
    const result = await resetClaudeLedgerPairing(sessionFilePath)
    // Worth a log line: the next turn's token cost jumps, and this is the only
    // record of why.
    log('claude', 'context reset', { sessionFilePath, ...result })
    return result
  })
}
