import { TooltipButton } from '@/components/Tooltip'
import { useId, useRef, useState } from 'react'
import './swarm.css'
import clsx from 'clsx'
import { SWARM_COMMAND, SWARM_STATUS_KEY, parseSwarmStatus } from '@phosphor/pi-extensions/swarm'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useChatStore } from '@/stores/chat'
import { piCall, piCallOk } from '@/lib/rpc'
import { ipcErrorText } from '@shared/errors'

export function useSwarm(sessionId: string) {
  const text = useExtensionUiStore((s) => s.statuses[sessionId]?.[SWARM_STATUS_KEY])
  return parseSwarmStatus(text)
}

export function SwarmBadge({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const state = useSwarm(sessionId)
  if (!state?.enabled) return null
  return (
    <span
      className="bg-accent-soft text-text inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-sm"
      data-tooltip="Swarm authorization enabled for this lane"
    >
      <SwarmMark /> Swarm
    </span>
  )
}

export function SwarmMark(): React.JSX.Element {
  return (
    <svg className="swarm-mark" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 12 5 5M12 12l7-7M12 12v9" fill="none" stroke="currentColor" />
      <circle cx="12" cy="12" r="2.5" fill="currentColor" />
      <circle className="swarm-satellite" cx="5" cy="5" r="2" fill="currentColor" />
      <circle className="swarm-satellite" cx="19" cy="5" r="2" fill="currentColor" />
      <circle className="swarm-satellite" cx="12" cy="21" r="2" fill="currentColor" />
    </svg>
  )
}

/** Only native status changes the appearance. A successful prompt is not an activation receipt. */
export function SwarmSwitch({ sessionId }: { sessionId: string }): React.JSX.Element {
  const state = useSwarm(sessionId)
  const [sending, setSending] = useState(false)
  const locked = useRef(false)
  const hintId = useId()
  const pending = !!state && state.requested !== state.enabled && state.available
  const enabled = state?.enabled ?? false
  const unavailable = !state || (!state.available && !state.requested)
  const hint = !state
    ? 'Restart this lane to load the Swarm control.'
    : !state.available
      ? 'Swarm requires pi-subagents loaded and available in this lane.'
      : pending
        ? `Swarm ${state.requested ? 'on' : 'off'} after the current turn. Existing children are not stopped.`
        : enabled
          ? 'Swarm enabled: proactive delegation is authorized. Switch off to remove that context; existing children continue.'
          : 'Authorize proactive delegation in this lane. No agents launch just from switching on.'

  async function toggle(): Promise<void> {
    if (locked.current || unavailable) return
    locked.current = true
    setSending(true)
    try {
      const commands = await piCall(sessionId, { type: 'get_commands' })
      if (!commands) return // piCall already surfaced the original failure.
      if (!commands.commands.some((c) => c.name === SWARM_COMMAND && c.source === 'extension'))
        throw new Error('This lane does not support the Swarm control. Restart it to update.')
      await piCallOk(sessionId, {
        type: 'prompt',
        message: `/${SWARM_COMMAND} ${state?.requested ? 'off' : 'on'}`,
      })
    } catch (error) {
      useChatStore.getState().setError(sessionId, ipcErrorText(error))
    } finally {
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
      tooltip={unavailable || pending || sending ? hint : `${enabled ? 'Disable' : 'Enable'} Swarm`}
      onClick={() => void toggle()}
      className={clsx(
        'swarm-switch focus-ring flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-base',
        unavailable && 'opacity-50',
        enabled ? 'bg-accent-soft text-text' : 'text-text-secondary hover:bg-bg-secondary',
      )}
    >
      <SwarmMark />
      <span>Swarm</span>
      <span id={hintId} className="sr-only">
        {hint}
      </span>
      <span className="swarm-track" data-on={enabled} aria-hidden="true">
        <span />
      </span>
      {(sending || pending) && (
        <span className={sending ? 'sr-only' : 'text-sm'} role="status">
          {sending ? 'Applying…' : `${state?.requested ? 'On' : 'Off'} next turn`}
        </span>
      )}
    </TooltipButton>
  )
}
