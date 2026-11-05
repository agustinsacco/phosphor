import { useState } from 'react'
import { Button } from '@/components/form'
import { RunCommandRow } from '@/components/RunCommandRow'
import { piCallOk } from '@/lib/rpc'
import { useChatStore } from '@/stores/chat'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { terminalAccess } from '@/stores/terminal'
import { useLaneControl } from '@/features/machines/useLaneControl'
import type { ErrorRemedy } from './errorRemedies'
import { useSignInAction } from './useSignInAction'

/**
 * A known failure's fix, the same on every machine: sign in again in Settings →
 * Accounts for the lane's machine, run the command in the lane's terminal (on
 * the lane's machine), and retry the failed turn once the fix is in.
 */
export function ErrorRemedyActions({
  remedy,
  message,
  sessionId,
  hostId,
  workspacePath,
}: {
  remedy: ErrorRemedy
  message: string | undefined
  sessionId: string | undefined
  /** The lane's Host; undefined on This Mac. */
  hostId: string | undefined
  workspacePath: string | null | undefined
}): React.JSX.Element {
  // The play button runs where this window may type into the lane's terminal.
  const canRun = useRemoteLanesStore(() =>
    sessionId ? terminalAccess(sessionId) === 'control' : true,
  )
  const signIn = useSignInAction(hostId ?? 'local')

  return (
    <>
      <div className="text-text-secondary mt-1.5 text-base leading-relaxed">{remedy.hint}</div>
      {remedy.retryAfter && sessionId && (
        <RetryFailedTurn sessionId={sessionId} message={message} />
      )}
      {remedy.signIn && (
        <Button size="sm" onClick={signIn.run}>
          {remedy.label}
        </Button>
      )}
      {remedy.command !== undefined && (
        <RunCommandRow
          command={remedy.command}
          label={remedy.label}
          workspacePath={canRun ? (workspacePath ?? undefined) : undefined}
        />
      )}
      {(remedy.docsUrl || remedy.suggestModelSwitch) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-base">
          {remedy.docsUrl && (
            <a
              href={remedy.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:underline"
              data-tooltip="Open link"
            >
              {remedy.label}
            </a>
          )}
          {remedy.suggestModelSwitch && (
            <span className="text-text-tertiary">
              Switch models from the picker in the composer below.
            </span>
          )}
        </div>
      )}
    </>
  )
}

/**
 * Resends the last failed prompt, once the fix is in: only for the turn that
 * failed with this message, while the lane is idle and this window controls it.
 */
function RetryFailedTurn({
  sessionId,
  message,
}: {
  sessionId: string
  message: string | undefined
}): React.JSX.Element | null {
  const control = useLaneControl(sessionId)
  const controlling = control ? control.controlling : true
  // A Host lane is idle when its Host says so; This Mac's when no turn streams.
  const idle = control ? control.activity === 'idle' : true
  const chat = useChatStore((s) => s.sessions[sessionId])
  const [retrying, setRetrying] = useState(false)
  const last = chat?.items.at(-1)
  const retryUser =
    last?.kind === 'assistant' &&
    last.stopReason === 'error' &&
    last.errorMessage === message &&
    !chat?.isStreaming
      ? chat?.items.findLast((item) => item.kind === 'user')
      : undefined
  if (!idle || retryUser?.kind !== 'user' || !controlling) return null
  return (
    <Button
      size="sm"
      disabled={retrying}
      onClick={() => {
        if (retrying) return
        setRetrying(true)
        void piCallOk(sessionId, {
          type: 'prompt',
          message: retryUser.text,
          images: retryUser.images,
        }).finally(() => setRetrying(false))
      }}
    >
      Retry failed turn
    </Button>
  )
}
