import { useEffect, useState } from 'react'
import type { GhPullRequest } from '@shared/models'
import { MenuRow } from '@/components/PopupMenu'

/**
 * Pull-request status for a branch, read through the `gh` CLI.
 *
 * Everything here degrades to nothing: no gh, no auth, no remote, no PR — all
 * render as absent rather than as an error, because "this branch has no PR" is
 * the common case, not a failure. Clicking opens the PR in the real browser;
 * the app never mutates PR state.
 */
export function PrRow({
  repoPath,
  branch,
}: {
  repoPath: string
  branch: string
}): React.JSX.Element | null {
  const [pr, setPr] = useState<GhPullRequest | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void window.phosphor
      .invoke('gh:prForBranch', repoPath, branch)
      .then((result) => {
        if (!cancelled) setPr(result)
      })
      .catch(() => {
        if (!cancelled) setPr(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [repoPath, branch])

  if (loading) {
    return (
      <div className="text-text-tertiary px-3 py-1 text-sm">
        <span className="skeleton inline-block h-3 w-28 rounded" />
      </div>
    )
  }
  if (!pr) return null

  const checks = pr.checks
  return (
    <MenuRow active={false} onClick={() => void window.phosphor.invoke('app:openExternal', pr.url)}>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className={`${stateColor(pr.state)} shrink-0 text-sm font-medium`}>#{pr.number}</span>
        <span className="text-text min-w-0 flex-1 truncate text-lg" title={pr.title}>
          {pr.title}
        </span>
      </span>
      <span className="shrink-0 text-sm">
        <span className={stateColor(pr.state)}>{pr.state.toLowerCase()}</span>
        {checks && checks.total > 0 && (
          <>
            {' '}
            {checks.failed > 0 ? (
              <span className="text-danger">✕{checks.failed}</span>
            ) : checks.pending > 0 ? (
              <span className="text-warning">•{checks.pending}</span>
            ) : (
              <span className="text-success">✓{checks.passed}</span>
            )}
          </>
        )}
      </span>
    </MenuRow>
  )
}

function stateColor(state: GhPullRequest['state']): string {
  if (state === 'MERGED') return 'text-accent'
  if (state === 'CLOSED') return 'text-danger'
  if (state === 'DRAFT') return 'text-text-tertiary'
  return 'text-success'
}
