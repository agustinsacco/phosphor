import { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import type { ClaudeAccountView, ClaudeUsageSnapshotResult } from '@shared/models'
import { Spinner } from '@/components/icons'
import { useAsyncAction } from '@/components/useAsyncAction'
import { useChatStore } from '@/stores/chat'
import { useSessionsStore } from '@/stores/sessions'
import { sessionTitle } from '@/lib/sessionTitle'
import { basename } from '@/lib/path'
import { moveTargets } from '@/lib/claudeGateway'
import {
  usageBarClass,
  usageTextClass,
  usageUnavailableReason,
  windowResetLabel,
  windowTitle,
} from '@/lib/claudeUsage'

/**
 * One account's own numbers and its own lanes — the body of an expanded
 * account row in Settings → Claude Code.
 *
 * The tab used to show a single Usage panel for whichever account routing
 * called primary, which on a multi-account install described a plan the user
 * was not spending. Usage is per account, so it renders per account, and it
 * only runs when a row is open: each snapshot is a `claude -p /usage` spawn
 * (zero quota, ~2 s, cached ~60 s in main), and fetching every account on tab
 * open would spawn one CLI per login for numbers nobody asked to see.
 */
export function ClaudeAccountPanel({
  accountId,
  views,
  sessionIds,
}: {
  accountId: string
  /** Every account, for the "move a lane there" targets. */
  views: ClaudeAccountView[]
  /** Live pidex sessions spawned onto this account. */
  sessionIds: string[]
}): React.JSX.Element {
  const [state, setState] = useState<ClaudeUsageSnapshotResult | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setState(
      await window.pidex
        .invoke('claude:usageSnapshot', accountId)
        // A rejected invoke is a failed run, never a permanent "Checking…".
        .catch((): ClaudeUsageSnapshotResult => ({ ok: false, error: 'run-failed' })),
    )
  }, [accountId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return (
    <div className="border-border/60 mt-2.5 space-y-3 border-t pt-2.5">
      {state === null ? (
        <div className="text-text-secondary flex items-center gap-2 text-sm">
          <Spinner /> Checking this account&apos;s usage…
        </div>
      ) : !state.ok || state.snapshot.windows.length === 0 ? (
        <p className="text-text-secondary text-sm">
          {usageUnavailableReason(state.ok ? 'no-usage' : state.error)}
        </p>
      ) : (
        <div className="space-y-2.5">
          {state.snapshot.stale && (
            <p className="text-warning text-sm">
              Last-known usage — the CLI could not refresh it just now.
            </p>
          )}
          {state.snapshot.windows.map((window) => {
            const percent = Math.round(window.percentUsed)
            const reset = windowResetLabel(window.resetsAt)
            return (
              <div key={window.label}>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-base">{windowTitle(window)}</span>
                  <span className={clsx('font-mono text-sm tabular-nums', usageTextClass(percent))}>
                    {percent}% used{reset ? ` · ${reset}` : ''}
                  </span>
                </div>
                <div className="bg-bg-secondary mt-1 h-1.5 overflow-hidden rounded-full">
                  <div
                    className={clsx('h-full rounded-full', usageBarClass(percent))}
                    style={{ width: `${Math.min(100, percent)}%` }}
                  />
                </div>
              </div>
            )
          })}
          {state.snapshot.contributing && (
            <details className="text-text-tertiary text-sm">
              <summary className="cursor-pointer">What&apos;s contributing</summary>
              <pre className="mt-1 max-h-52 overflow-auto whitespace-pre-wrap font-sans leading-snug">
                {state.snapshot.contributing}
              </pre>
            </details>
          )}
        </div>
      )}

      <LaneList accountId={accountId} views={views} sessionIds={sessionIds} />
    </div>
  )
}

/** The lanes spending this account right now, each with somewhere else to go. */
function LaneList({
  accountId,
  views,
  sessionIds,
}: {
  accountId: string
  views: ClaudeAccountView[]
  sessionIds: string[]
}): React.JSX.Element {
  const targets = moveTargets(views, accountId)
  const label = views.find((v) => v.account.id === accountId)?.account.label ?? 'this account'

  return (
    <div>
      <div className="text-text-tertiary text-2xs pb-1 font-mono uppercase tracking-wider">
        Sessions on this account
      </div>
      {sessionIds.length === 0 ? (
        <p className="text-text-tertiary text-sm">
          No live session is spending it. Closed sessions still bill it when reopened.
        </p>
      ) : (
        <div className="space-y-1">
          {sessionIds.map((sessionId) => (
            <LaneRow
              key={sessionId}
              sessionId={sessionId}
              accountId={accountId}
              accountLabel={label}
              targets={targets}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * One lane, and the two things you can do to it when its account is spent.
 *
 * Both are the same operation — dispose the pi subprocess and resume the same
 * session file — because a running lane's credential is fixed by the
 * environment it spawned with. "Restart" re-primes it on the account it is
 * already on (a wedged CLI, a window that has since reset); the move buttons
 * send it to another plan. Either way the next turn re-reads the whole thread,
 * so this is not free and the panel says so.
 */
function LaneRow({
  sessionId,
  accountId,
  accountLabel,
  targets,
}: {
  sessionId: string
  accountId: string
  accountLabel: string
  targets: { id: string; label: string; held: boolean }[]
}): React.JSX.Element {
  const entry = useSessionsStore((s) => s.live[sessionId])
  const moveSessionToAccount = useSessionsStore((s) => s.moveSessionToAccount)
  const sessionName = useChatStore((s) => s.sessions[sessionId]?.meta?.sessionName)
  const firstUserText = useChatStore((s) => {
    const first = s.sessions[sessionId]?.items.find((item) => item.kind === 'user')
    return first?.kind === 'user' ? first.text : undefined
  })
  const action = useAsyncAction()

  const title = sessionTitle({ explicitName: sessionName, firstUserText }) ?? 'Untitled session'
  const folder = entry?.workspacePath ? basename(entry.workspacePath) : null
  // No session file yet means no turn has ended yet: there is nothing on disk
  // to resume, so a restart would lose the lane rather than move it.
  const resumable = Boolean(entry?.diskPath)

  return (
    <div className="bg-surface-raised rounded-md px-2.5 py-1.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
        {folder && <span className="text-text-tertiary shrink-0 font-mono text-2xs">{folder}</span>}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <button
          onClick={() =>
            void action.run(async () => void (await moveSessionToAccount(sessionId, accountId)))
          }
          disabled={action.busy || !resumable}
          title={`Restart this session on ${accountLabel}`}
          className="text-text-secondary hover:text-text text-sm disabled:opacity-40"
        >
          Restart
        </button>
        {targets.map((target) => (
          <button
            key={target.id}
            onClick={() =>
              void action.run(async () => void (await moveSessionToAccount(sessionId, target.id)))
            }
            disabled={action.busy || !resumable}
            className="text-accent text-sm hover:underline disabled:opacity-40"
          >
            Move to {target.label}
            {target.held ? ' (also held)' : ''}
          </button>
        ))}
        {action.busy && <Spinner />}
      </div>
      {!resumable && (
        <p className="text-text-tertiary mt-0.5 text-2xs">
          Nothing saved yet — pi writes the session file when the first turn ends.
        </p>
      )}
      {action.error && <p className="text-danger mt-0.5 text-2xs">{action.error}</p>}
    </div>
  )
}
