import { TooltipButton } from '@/components/Tooltip'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import './swarm.css'
import clsx from 'clsx'
import {
  SWARM_COMMAND,
  SWARM_STATUS_KEY,
  parseSwarmStatus,
  type SwarmStatus,
} from '@phosphor/pi-extensions/swarm'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useChatStore } from '@/stores/chat'
import { piCall, piCallOk } from '@/lib/rpc'
import { ipcErrorText } from '@shared/errors'

export function useSwarm(sessionId: string): SwarmStatus | null {
  const text = useExtensionUiStore((s) => s.statuses[sessionId]?.[SWARM_STATUS_KEY])
  return useMemo(() => parseSwarmStatus(text), [text])
}

/** The pill's four looks. Pending is a request pi holds until the turn ends. */
export type SwarmLook = 'unavailable' | 'off' | 'pending' | 'on'

export function swarmLook(state: SwarmStatus | null): SwarmLook {
  if (!state || (!state.available && !state.requested)) return 'unavailable'
  if (state.available && state.requested !== state.enabled) return 'pending'
  return state.enabled ? 'on' : 'off'
}

/** What a click does: the action hint's label. */
export function swarmAction(state: SwarmStatus | null): string {
  if (!state) return 'Swarm'
  if (!state.available) return state.requested ? 'Clear saved Swarm authorization' : 'Swarm'
  switch (swarmLook(state)) {
    case 'pending':
      return 'Cancel the pending change'
    case 'on':
      return 'Disable Swarm'
    default:
      return 'Enable Swarm'
  }
}

/** The state's sentence: the hint's description and the switch's accessible description. */
export function swarmHint(state: SwarmStatus | null): string {
  if (!state) return 'Restart this lane to load the Swarm control.'
  if (!state.available)
    return state.requested
      ? 'Swarm needs pi-subagents loaded in this lane. Switch off to clear the saved authorization.'
      : 'Swarm needs pi-subagents loaded in this lane.'
  switch (swarmLook(state)) {
    case 'pending':
      return `Swarm turns ${state.requested ? 'on' : 'off'} after this turn. Existing children are not stopped.`
    case 'on':
      return 'The agent may delegate to sub-agents on its own. Switching off stops authorizing new delegation; running children continue.'
    default:
      return 'Let the agent split work across sub-agents when it helps. Nothing launches just from switching on.'
  }
}

export function SwarmBadge({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const state = useSwarm(sessionId)
  if (!state?.enabled) return null
  return (
    <span
      className="bg-accent-soft text-text inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-sm"
      data-tooltip="Swarm authorization enabled for this lane"
    >
      <SwarmMark className="text-accent" /> Swarm
    </span>
  )
}

/**
 * The Beacon's nucleus and shell with three signals on the orbit. The heads
 * carry the state through `swarm.css`: pulled in when off, on the shell when
 * on. Without a `data-state` ancestor (the title-bar badge) they sit on the
 * shell.
 */
export function SwarmMark({
  className,
  size = 16,
}: {
  className?: string
  size?: number
}): React.JSX.Element {
  return (
    <svg
      className={clsx('swarm-mark', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle
        cx="12"
        cy="12"
        r="8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        opacity="0.35"
      />
      <circle cx="12" cy="12" r="2.5" fill="currentColor" />
      <g className="swarm-heads">
        <circle className="swarm-head" cx="12" cy="4" r="1.9" fill="currentColor" />
        <circle className="swarm-head" cx="18.93" cy="16" r="1.9" fill="currentColor" />
        <circle className="swarm-head" cx="5.07" cy="16" r="1.9" fill="currentColor" />
      </g>
    </svg>
  )
}

/**
 * True once pi has reported the switch going on during this mount, until it
 * goes off again: the fan-out's trigger. A lane reopened with Swarm already
 * on mounts quiet, because nothing changed.
 */
function useActivation(enabled: boolean): boolean {
  const [seen, setSeen] = useState(enabled)
  const [activated, setActivated] = useState(false)
  if (seen !== enabled) {
    setSeen(enabled)
    setActivated(enabled)
  }
  return activated
}

/** Only native status changes the appearance. A successful prompt is not an activation receipt. */
export function SwarmSwitch({ sessionId }: { sessionId: string }): React.JSX.Element {
  const state = useSwarm(sessionId)
  const [sending, setSending] = useState(false)
  const locked = useRef(false)
  const hintId = useId()
  const look = swarmLook(state)
  const pending = look === 'pending'
  const enabled = state?.enabled ?? false
  const unavailable = look === 'unavailable'
  const hint = swarmHint(state)
  const activated = useActivation(enabled)

  // A click's receipt. Armed before the command goes out, because pi publishes
  // the new status before it answers the prompt, so the status can land first.
  // Consumed by the status that reflects the click, which is the only place
  // that knows whether it applied now or waits for the turn to end.
  const receipt = useRef<{ requested: boolean; cancel: boolean } | null>(null)
  useEffect(() => {
    const armed = receipt.current
    if (!armed || !state || state.requested !== armed.requested) return
    receipt.current = null
    const toast = useExtensionUiStore.getState().pushToast
    if (armed.cancel) toast('Swarm request cancelled.')
    else if (swarmLook(state) === 'pending')
      toast(`Swarm turns ${armed.requested ? 'on' : 'off'} after this turn.`)
  }, [state])

  async function toggle(): Promise<void> {
    if (locked.current || unavailable || !state) return
    locked.current = true
    setSending(true)
    const requested = !state.requested
    receipt.current = { requested, cancel: pending }
    let sent = false
    try {
      const commands = await piCall(sessionId, { type: 'get_commands' })
      if (!commands) return // piCall already surfaced the original failure.
      if (!commands.commands.some((c) => c.name === SWARM_COMMAND && c.source === 'extension'))
        throw new Error('This lane does not support the Swarm control. Restart it to update.')
      sent = await piCallOk(sessionId, {
        type: 'prompt',
        message: `/${SWARM_COMMAND} ${requested ? 'on' : 'off'}`,
      })
    } catch (error) {
      useChatStore.getState().setError(sessionId, ipcErrorText(error))
    } finally {
      if (!sent) receipt.current = null
      locked.current = false
      setSending(false)
    }
  }

  return (
    <TooltipButton
      type="button"
      role="switch"
      aria-label="Swarm"
      aria-checked={enabled}
      aria-busy={sending || pending}
      aria-disabled={sending || unavailable}
      aria-describedby={hintId}
      tooltip={{ label: swarmAction(state), description: hint }}
      data-state={look}
      data-activated={activated ? 'true' : undefined}
      data-applying={sending ? 'true' : undefined}
      onClick={() => void toggle()}
      className={clsx(
        'swarm-switch flex h-6 shrink-0 items-center gap-1 rounded-full pr-2 pl-1.5 text-base font-medium transition-colors',
        look === 'unavailable' && 'cursor-default opacity-50',
        look === 'off' && 'text-text-secondary hover:bg-bg-secondary hover:text-text',
        look === 'pending' && 'text-text',
        look === 'on' && 'bg-accent-soft text-text',
      )}
    >
      <SwarmMark
        size={14}
        className={clsx((look === 'on' || look === 'pending') && 'text-accent')}
      />
      <span>Swarm</span>
      {pending && (
        <span role="status" className="text-accent text-2xs font-mono tracking-wide uppercase">
          {state?.requested ? 'on' : 'off'} next turn
        </span>
      )}
      {sending && (
        <span className="sr-only" role="status">
          Applying…
        </span>
      )}
      <span id={hintId} className="sr-only">
        {hint}
      </span>
    </TooltipButton>
  )
}
