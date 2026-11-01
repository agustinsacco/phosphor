import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { TooltipButton } from '@/components/Tooltip'
import { Spinner } from '@/components/icons'
import type { MoveTarget } from '@/lib/claudeGateway'
import { errorText } from '@shared/errors'

/**
 * The one "Switch account" control for a Claude lane, on This Mac and on a Host.
 * Only where accounts come from and how a move is sent differ; each caller
 * passes those in. Targets are read when the picker opens (and, for a Host, once
 * `ready` says the grant to read them is live), never on every popover open.
 */
export function AccountSwitcher(props: {
  summary: string
  warn?: boolean
  /** Why switching is off, or undefined when it is allowed. */
  blocked?: string
  /** Asked before the picker opens; false keeps it closed. */
  beforeOpen?: () => Promise<boolean>
  /** Targets may be read now. */
  ready?: boolean
  load: () => Promise<MoveTarget[]>
  move: (accountId: string) => Promise<void>
  /** The account routing would pick next, marked in the list. */
  nextId?: string
  where?: string
}): React.JSX.Element {
  const { summary, warn, blocked, beforeOpen, ready = true, load, move, nextId, where } = props
  const { picking, targets, moving, error, open, choose } = useAccountPicker(
    ready,
    load,
    move,
    beforeOpen,
  )

  return (
    <div className="mt-1.5 text-sm">
      <div className="flex items-start justify-between gap-2">
        {/* Wraps rather than truncates: a held summary names where the next lane goes. */}
        <span className={clsx('flex-1 leading-snug', warn ? 'text-warning' : 'text-text-tertiary')}>
          {blocked ?? summary}
        </span>
        <TooltipButton
          onClick={() => void open()}
          disabled={blocked !== undefined}
          className="text-accent shrink-0 hover:underline disabled:opacity-50"
          aria-expanded={picking}
        >
          {picking ? 'Cancel' : 'Switch account'}
        </TooltipButton>
      </div>
      {error && <div className="text-danger mt-1 leading-snug">{error}</div>}
      {picking && (
        <TargetList
          targets={targets}
          moving={moving}
          nextId={nextId}
          where={where}
          onChoose={(id) => void choose(id)}
        />
      )}
    </div>
  )
}

function TargetList(props: {
  targets: MoveTarget[] | null
  moving: string | null
  nextId?: string
  where?: string
  onChoose: (id: string) => void
}): React.JSX.Element {
  const { targets, moving, nextId, where, onChoose } = props
  return (
    <div className="border-border/60 mt-1.5 space-y-0.5 rounded-md border p-1">
      {targets === null ? (
        <div className="text-text-tertiary flex items-center gap-1.5 px-1 py-0.5">
          <Spinner className="text-text-tertiary" /> Reading accounts
          {where ? ` on ${where}` : ''}…
        </div>
      ) : targets.length === 0 ? (
        <div className="text-text-tertiary px-1 py-0.5">
          No other signed-in Claude account{where ? ` on ${where}` : ''}.
        </div>
      ) : (
        <>
          {targets.map((target) => (
            <TooltipButton
              key={target.id}
              disabled={moving !== null}
              onClick={() => onChoose(target.id)}
              className="hover:bg-bg-secondary flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left transition-colors disabled:opacity-50"
            >
              {/* Fixed slot so a row does not jump when its spinner appears. */}
              <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                {moving === target.id && <Spinner className="text-accent" />}
              </span>
              <span className="text-text flex-1 truncate">{target.label}</span>
              {target.held && <span className="text-warning shrink-0 text-2xs">held</span>}
              {nextId === target.id && !target.held && (
                <span className="text-text-tertiary shrink-0 text-2xs">next in routing</span>
              )}
            </TooltipButton>
          ))}
          <div className="text-text-tertiary px-1.5 pt-0.5 text-2xs leading-snug">
            Restarts this lane on the chosen account: same session file, one full re-read of the
            thread. In-flight work is interrupted.
          </div>
        </>
      )}
    </div>
  )
}

/** Open/close, lazy target loading and the move in flight, with any error to show. */
function useAccountPicker(
  ready: boolean,
  load: () => Promise<MoveTarget[]>,
  move: (accountId: string) => Promise<void>,
  beforeOpen?: () => Promise<boolean>,
) {
  const [picking, setPicking] = useState(false)
  const [targets, setTargets] = useState<MoveTarget[] | null>(null)
  const [moving, setMoving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!picking || !ready || targets !== null) return
    let cancelled = false
    load().then(
      (list) => !cancelled && setTargets(list),
      (e: unknown) => {
        if (cancelled) return
        setTargets([])
        setError(errorText(e))
      },
    )
    return () => {
      cancelled = true
    }
  }, [picking, ready, targets, load])

  const open = async (): Promise<void> => {
    setError(null)
    if (picking) return setPicking(false)
    try {
      if (beforeOpen && !(await beforeOpen())) return
    } catch (e) {
      return setError(errorText(e))
    }
    setTargets(null)
    setPicking(true)
  }

  const choose = async (id: string): Promise<void> => {
    setMoving(id)
    setError(null)
    try {
      await move(id)
      setPicking(false)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setMoving(null)
    }
  }

  return { picking, targets, moving, error, open, choose }
}
