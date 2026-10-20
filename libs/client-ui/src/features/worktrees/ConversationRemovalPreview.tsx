import { useEffect, useState } from 'react'
import type { SessionMeta, WorktreeInfo } from '@shared/models'
import { sessionTitle } from '@/lib/sessionTitle'
import { Button } from '@/components/form'

export function checkoutIsLive(
  live: Record<string, { workspacePath: string }>,
  worktree: Pick<WorktreeInfo, 'path' | 'realPath'>,
): boolean {
  return Object.values(live).some((entry) =>
    [worktree.path, worktree.realPath].includes(entry.workspacePath),
  )
}

/** Manual checkout deletion must name the histories it affects, even when stopped. */
export function ConversationRemovalPreview({
  path,
  onConfirm,
}: {
  path: string
  onConfirm: (confirmed: boolean) => void
}): React.JSX.Element {
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let cancelled = false
    onConfirm(false)
    void window.phosphor
      .invoke('sessions:list', path)
      .then((result) => {
        if (!cancelled) {
          setSessions(result)
          setError('')
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(String(cause))
      })
    return () => {
      cancelled = true
    }
  }, [path, attempt, onConfirm])
  if (error)
    return (
      <div>
        {error} <Button onClick={() => setAttempt((value) => value + 1)}>Retry</Button>
      </div>
    )
  if (!sessions) return <div>Checking affected conversations…</div>
  return (
    <div className="space-y-2 text-base">
      <p>
        Conversation history is retained. Restoring this checkout will require reinstalling
        dependencies. Uncommitted files cannot be restored.
      </p>
      <ul>
        {sessions.map((session) => (
          <li key={session.path}>
            {sessionTitle(session)}
            {session.completedAt ? ' (finished)' : ' (unfinished)'}
          </li>
        ))}
      </ul>
      <label className="flex items-center gap-2">
        <input type="checkbox" onChange={(event) => onConfirm(event.target.checked)} />
        Remove checkout for {sessions.length} conversation{sessions.length === 1 ? '' : 's'}
      </label>
    </div>
  )
}
