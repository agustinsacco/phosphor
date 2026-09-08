import { useEffect, useState } from 'react'
import type { WorktreeInfo } from '@shared/models'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { Button, TextInput } from '@/components/form'
import { useAsyncAction } from '@/components/useAsyncAction'
import { useWorktreesStore } from '@/stores/worktrees'
import { RemoveWorktreeModal } from './RemoveWorktreeModal'

type Phase =
  | { step: 'commit'; dirtyCount: number }
  | { step: 'ready' }
  | { step: 'main-dirty'; dirtyCount: number }
  | { step: 'conflict'; conflicts: string[] }
  | { step: 'merged'; sha: string }

/**
 * Guided merge of a worktree branch into the main tree's CURRENT branch:
 * commit the worktree (user-typed message) → preflight (main must be clean —
 * Phosphor never checks out or stashes for the user) → `merge --no-ff`.
 * Conflicts abort immediately, so the repo is never left mid-merge.
 */
export function MergeWorktreeModal({
  repoPath,
  worktree,
  onClose,
}: {
  repoPath: string
  worktree: WorktreeInfo
  onClose: () => void
}): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>(
    worktree.dirtyCount > 0
      ? { step: 'commit', dirtyCount: worktree.dirtyCount }
      : { step: 'ready' },
  )
  const [message, setMessage] = useState('')
  // One busy/error pair for both steps: they are sequential, never concurrent.
  const { busy, error, run } = useAsyncAction()
  const [removing, setRemoving] = useState(false)
  const [freshWorktree, setFreshWorktree] = useState(worktree)

  const branch = worktree.branch

  // Refresh the worktree row after commit so the remove shortcut sees clean.
  useEffect(() => {
    if (phase.step !== 'merged') return
    void window.phosphor.invoke('git:listWorktrees', repoPath).then((list) => {
      const updated = list.find((w) => w.path === worktree.path)
      if (updated) setFreshWorktree(updated)
    })
  }, [phase.step, repoPath, worktree.path])

  const commit = (): Promise<void> =>
    run(async () => {
      await window.phosphor.invoke('git:commitAll', worktree.path, message)
      setPhase({ step: 'ready' })
    })

  const merge = (): Promise<void> =>
    run(async () => {
      if (!branch) return
      const result = await window.phosphor.invoke('git:mergeBranch', repoPath, branch)
      if (result.merged) {
        setPhase({ step: 'merged', sha: result.sha })
        void useWorktreesStore.getState().refresh(repoPath)
      } else if (result.reason === 'dirty') {
        setPhase({ step: 'main-dirty', dirtyCount: result.dirtyCount })
      } else {
        setPhase({ step: 'conflict', conflicts: result.conflicts })
      }
    })

  if (removing) {
    return <RemoveWorktreeModal repoPath={repoPath} worktree={freshWorktree} onClose={onClose} />
  }

  if (!branch) {
    return (
      <ModalOverlay onClose={onClose}>
        <ModalPanel width={460} title="Merge worktree">
          <div className="text-text-secondary px-4 py-3 text-lg">
            This worktree has a detached HEAD — check out a branch in it before merging.
          </div>
        </ModalPanel>
      </ModalOverlay>
    )
  }

  return (
    <ModalOverlay onClose={onClose}>
      <ModalPanel
        width={460}
        title={`Merge ${branch}`}
        footer={
          <>
            <Button onClick={onClose}>
              {phase.step === 'merged' || phase.step === 'conflict' ? 'Done' : 'Cancel'}
            </Button>
            {phase.step === 'commit' && (
              <Button
                variant="primary"
                onClick={() => void commit()}
                disabled={busy || !message.trim()}
              >
                {busy ? 'Committing…' : 'Commit'}
              </Button>
            )}
            {(phase.step === 'ready' || phase.step === 'main-dirty') && (
              <Button variant="primary" onClick={() => void merge()} disabled={busy}>
                {busy ? 'Merging…' : phase.step === 'main-dirty' ? 'Retry merge' : 'Merge'}
              </Button>
            )}
            {phase.step === 'merged' && (
              <Button onClick={() => setRemoving(true)}>Remove worktree…</Button>
            )}
          </>
        }
      >
        <div className="space-y-3 px-4 py-3 text-lg">
          {phase.step === 'commit' && (
            <>
              <div className="text-text-secondary text-base">
                The worktree has {phase.dirtyCount} uncommitted change
                {phase.dirtyCount === 1 ? '' : 's'}. Commit them to{' '}
                <span className="font-mono">{branch}</span> first:
              </div>
              <TextInput
                autoFocus
                size="lg"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && message.trim()) void commit()
                }}
                placeholder="Commit message"
                className="w-full"
              />
            </>
          )}

          {phase.step === 'ready' && (
            <div className="text-text-secondary text-base">
              Merge <span className="font-mono">{branch}</span> into the main tree&apos;s current
              branch with <span className="font-mono">--no-ff</span>. The main tree must be clean;
              Phosphor never checks out or stashes for you.
            </div>
          )}

          {phase.step === 'main-dirty' && (
            <div className="bg-warning/10 border-warning/30 rounded-lg border px-3 py-2.5 text-base">
              The main tree has {phase.dirtyCount} uncommitted change
              {phase.dirtyCount === 1 ? '' : 's'}. Commit or stash them there, then retry.
            </div>
          )}

          {phase.step === 'conflict' && (
            <div className="bg-danger-soft border-danger/25 rounded-lg border px-3 py-2.5 text-base">
              <div className="text-danger font-medium">
                Merge conflicts — aborted cleanly, nothing changed.
              </div>
              {phase.conflicts.length > 0 && (
                <ul className="text-text-secondary mt-1 max-h-32 list-inside list-disc overflow-y-auto font-mono text-sm">
                  {phase.conflicts.map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
              )}
              <div className="text-text-secondary mt-1">
                Resolve in a terminal (merge manually) or rebase the branch first.
              </div>
            </div>
          )}

          {phase.step === 'merged' && (
            <div className="text-base">
              <span className="text-success font-medium">Merged ✓</span>
              <span className="text-text-secondary font-mono"> {phase.sha.slice(0, 8)}</span>
              <div className="text-text-secondary mt-1">
                The worktree is no longer needed — remove it to tidy up.
              </div>
            </div>
          )}

          {error && <div className="text-danger text-base">{error}</div>}
        </div>
      </ModalPanel>
    </ModalOverlay>
  )
}
