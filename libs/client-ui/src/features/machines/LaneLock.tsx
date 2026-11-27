import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/form'
import { Spinner, strokeProps } from '@/components/icons'
import { composerDraftKey, useDraftsStore } from '@/stores/drafts'
import { useSessionHostLane } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { laneLockCopy, takeOverQuestion, type LaneLockCopy } from './laneLockCopy'
import { useLaneControl } from './useLaneControl'

function LockGlyph(): React.JSX.Element {
  return (
    <svg {...strokeProps(14)} className="text-text-tertiary shrink-0" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  )
}

/**
 * Who took this lane from this client while it was open here. It stays set
 * until this client holds the lane again or opens another one; the lock only
 * names it while that same holder still has the lane.
 */
export function useTakenBy(sessionId: string): string | null {
  const controller = useSessionHostLane(sessionId)?.lane?.control.controller
  const self = controller?.self === true
  const [seen, setSeen] = useState({ sessionId, self })
  const [takenBy, setTakenBy] = useState<string | null>(null)
  if (seen.sessionId !== sessionId || seen.self !== self) {
    setSeen({ sessionId, self })
    const lost = seen.sessionId === sessionId && seen.self && controller && !self
    setTakenBy(lost ? controller.label : null)
  }
  return takenBy
}

/**
 * The composer of a lane this client only reads: the same place and shape at
 * every width, locked. It names who holds the lane and offers the one action
 * that unlocks typing. Taking from a connected holder asks first.
 */
export function LaneLock({
  sessionId,
  takenBy,
  onTaken,
}: {
  sessionId: string
  takenBy: string | null
  /** The Host confirmed the take; the composer replaces this lock shortly. */
  onTaken?: () => void
}): React.JSX.Element {
  const control = useLaneControl(sessionId)
  const entry = useSessionsStore((s) => s.live[sessionId])
  const drafted = useDraftsStore((s) => !!s.drafts[composerDraftKey(entry, sessionId)]?.text.trim())
  const [confirming, setConfirming] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const copy = laneLockCopy({
    controller: control?.controller,
    canTake: !!control?.transfer && control.enabled,
    takenBy,
    hint: control?.hint,
  })
  const { holder, action } = copy
  // A holder who disconnects while this asks no longer needs asking.
  const asking = confirming && !!action?.confirm && holder !== null
  useEffect(() => {
    if (asking) confirmRef.current?.focus()
  }, [asking])

  async function take(): Promise<void> {
    setConfirming(false)
    if (await control?.act('hosts:takeControl')) onTaken?.()
  }

  const message =
    takenBy && holder === takenBy && drafted ? `${copy.message} Your draft is kept.` : copy.message
  return (
    <div className="lane-lock composer shrink-0 px-3 pb-4 pt-1 sm:px-5" data-testid="lane-lock">
      <div
        className="border-border-strong mx-auto flex min-w-0 max-w-3xl flex-wrap items-center gap-x-3 gap-y-2 rounded-composer border border-dashed px-3 py-2.5"
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || !asking) return
          event.stopPropagation()
          setConfirming(false)
        }}
      >
        <p
          role="status"
          className="text-text-secondary flex min-w-48 flex-1 items-center gap-2 text-base"
        >
          {!asking && <LockGlyph />}
          <span>
            {asking ? (
              takeOverQuestion(holder)
            ) : (
              <>
                {holder && <b className="text-text font-semibold">{holder}</b>}
                {holder && ' '}
                {message}
              </>
            )}
          </span>
        </p>
        <LockActions
          busy={!!control?.busy}
          asking={asking}
          action={action}
          confirmRef={confirmRef}
          onAsk={setConfirming}
          onTake={() => void take()}
        />
        {control?.error && (
          <p role="alert" className="text-danger basis-full text-sm">
            {control.error}
          </p>
        )}
      </div>
    </div>
  )
}

/** The lock's buttons: busy, the inline question, or the one take action. */
function LockActions({
  busy,
  asking,
  action,
  confirmRef,
  onAsk,
  onTake,
}: {
  busy: boolean
  asking: boolean
  action: LaneLockCopy['action']
  confirmRef: React.RefObject<HTMLButtonElement | null>
  onAsk: (asking: boolean) => void
  onTake: () => void
}): React.JSX.Element | null {
  if (busy)
    return (
      <Button variant="primary" size="sm" disabled className="flex items-center gap-1.5">
        <Spinner className="text-accent-text" />
        Taking control…
      </Button>
    )
  if (asking)
    return (
      <>
        <Button size="sm" className="border-transparent" onClick={() => onAsk(false)}>
          Cancel
        </Button>
        <Button ref={confirmRef} variant="primary" size="sm" onClick={onTake}>
          Take over
        </Button>
      </>
    )
  if (!action) return null
  return (
    <Button
      variant={action.confirm ? 'secondary' : 'primary'}
      size="sm"
      onClick={() => (action.confirm ? onAsk(true) : onTake())}
    >
      {action.label}
    </Button>
  )
}
