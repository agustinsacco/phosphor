import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { git } from '@phosphor/session-runtime/git/git-exec'
import { listWorktrees, removeWorktree } from '../fs/git-worktrees'
import { registry } from '../registry'
import { sessionPathKey } from '../pi/session-path-lock'
import { conversationFacts, conversationSnapshot } from './conversations'
import { notifyWorkspaceSessions } from '../pi/session-watcher'
import type { WorktreeInfo } from '@shared/models'
import { workspaceGeneration } from './history'
import { history, saveRemoval, withWorkspace, type RemovalRecord } from './history'
import { selectReclaimable, type PolicyOptions, type WorktreeFacts } from './policy'

type RemoveOptions = NonNullable<Parameters<typeof removeWorktree>[2]>

async function auditedRemoval(
  repoPath: string,
  path: string,
  branch: string,
  reason: RemovalRecord['reason'],
  options: RemoveOptions,
  beforeRemove: (target: WorktreeInfo, record: RemovalRecord) => void,
): ReturnType<typeof removeWorktree> {
  const conversations = await conversationFacts(path)
  const id = randomUUID()
  const recoveryRef = `refs/phosphor/recovery/${id}`
  const tip = await git(path, ['rev-parse', 'HEAD'], { trim: true })
  // A hash alone can be garbage-collected after branch deletion.
  await git(repoPath, ['update-ref', recoveryRef, tip])
  const record: RemovalRecord = {
    id,
    repoPath,
    path,
    branch,
    tip,
    recoveryRef,
    sessions: conversations.sessions,
    reason,
    attemptedAt: Date.now(),
    outcome: 'pending',
  }
  // Persist identity BEFORE removal; a crash leaves a recoverable pending record.
  saveRemoval(record)
  try {
    const result = await removeWorktree(repoPath, path, options, (target) => {
      if (target.head !== record.tip || (target.branch ?? '(detached)') !== record.branch)
        throw new Error('Checkout identity changed; kept for safety.')
      beforeRemove(target, record)
    })
    saveRemoval({ ...record, outcome: result.removed ? 'removed' : 'kept' })
    if (result.removed) notifyWorkspaceSessions(path)
    return result
  } catch (error) {
    saveRemoval({ ...record, outcome: 'error', detail: String(error) })
    throw error
  }
}

/** Fresh checks and removal share Desktop's workspace admission gate. */
export async function removeCompletedWorktree(
  repoPath: string,
  path: string,
  inspect: () => Promise<WorktreeFacts | undefined>,
  policy: () => PolicyOptions,
): ReturnType<typeof removeWorktree> {
  const generation = workspaceGeneration(path)
  return withWorkspace(path, async () => {
    const fresh = await inspect()
    if (!fresh || !selectReclaimable([fresh], policy()).candidates.length)
      throw new Error('Worktree eligibility changed; kept for safety.')
    return auditedRemoval(
      repoPath,
      path,
      fresh.branch!,
      'explicitly-completed-and-merged',
      { deleteBranch: true },
      (target, record) => {
        const latest = conversationSnapshot(
          path,
          record.sessions.map((s) => s.path),
        )
        const live = registry
          .list()
          .some((s) => sessionPathKey(s.workspacePath) === sessionPathKey(path))
        if (
          live ||
          (fresh.head && fresh.head !== target.head) ||
          generation !== workspaceGeneration(path) ||
          !selectReclaimable([{ ...fresh, ...target, ...latest }], policy()).candidates.length
        )
          throw new Error('Conversation resumed or changed; kept for safety.')
      },
    )
  })
}

/** Explicit manual deletion is separate from automatic completion eligibility. */
export async function removeReviewedWorktree(
  repoPath: string,
  path: string,
  options: RemoveOptions,
): ReturnType<typeof removeWorktree> {
  const generation = workspaceGeneration(path)
  return withWorkspace(path, async () => {
    const target = (await listWorktrees(repoPath)).find(
      (w) => sessionPathKey(w.path) === sessionPathKey(path),
    )
    if (!target || target.isMain || target.locked)
      throw new Error('Worktree is missing, main or locked.')
    const assertOffline = (): void => {
      if (
        generation !== workspaceGeneration(path) ||
        registry.list().some((s) => sessionPathKey(s.workspacePath) === sessionPathKey(path))
      )
        throw new Error('Suspend all sessions before removing this checkout.')
    }
    assertOffline()
    return auditedRemoval(
      repoPath,
      path,
      target.branch ?? '(detached)',
      'manual-confirmation',
      options,
      assertOffline,
    )
  })
}

/** Restore the exact saved commit, never guess a replacement from origin/main. */
export async function restoreWorktree(path: string): Promise<void> {
  const record = history()
    .get('removals')
    .slice()
    .reverse()
    .find((entry) => entry.path === path)
  if (!record) throw new Error('No saved checkout identity. Restore this legacy checkout manually.')
  await withWorkspace(path, async () => {
    const tip = await git(record.repoPath, ['rev-parse', record.recoveryRef], { trim: true })
    if (tip !== record.tip) throw new Error('Saved recovery ref changed. Refusing to guess.')
    await mkdir(dirname(path), { recursive: true })
    // Detached avoids overwriting a reused branch or moving unrelated checkouts.
    await git(record.repoPath, ['worktree', 'add', '--detach', path, record.tip])
    saveRemoval({ ...record, restoredAt: Date.now() })
    notifyWorkspaceSessions(path)
  })
}
