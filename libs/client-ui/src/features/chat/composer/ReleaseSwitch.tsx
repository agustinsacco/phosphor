import { useId, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  RELEASE_COMMAND,
  RELEASE_STATUS_KEY,
  parseReleaseStatus,
  type ReleaseStatus,
} from '@phosphor/pi-extensions/release-status'
import { TooltipButton } from '@/components/Tooltip'
import { SwarmSwitch } from './SwarmSwitch'
import { runExtensionCommand } from '@/lib/extensionCommand'
import { useChatStore } from '@/stores/chat'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { ipcErrorText } from '@shared/errors'

export function useRelease(sessionId: string): ReleaseStatus | null {
  const text = useExtensionUiStore((s) => s.statuses[sessionId]?.[RELEASE_STATUS_KEY])
  return useMemo(() => parseReleaseStatus(text), [text])
}

/** The state's sentence: the hint's description and the switch's accessible description. */
export function releaseHint(state: ReleaseStatus): string {
  const problem = state.problem ? ` Last problem: ${state.problem}` : ''
  switch (state.role) {
    case 'active':
      return `This lane is the repository's release manager (lease epoch ${state.epoch ?? '?'}): it reviews, merges and releases ready pull requests. Switch off to hand over.${problem}`
    case 'standby':
      if (!state.holder)
        return `Release mode is on; this lane has not claimed the release lease yet.${problem}`
      return `Release mode is on, but a lane on ${state.holder} holds the release lease. This lane takes over if that lease lapses; /${RELEASE_COMMAND} takeover takes it now.${problem}`
    default:
      return "Make this lane the repository's release manager. Only one lane per repository holds the release lease at a time."
  }
}

/** Shown only in a repository set up for release management, or while release mode is on. */
export function ReleaseSwitch({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const state = useRelease(sessionId)
  const [sending, setSending] = useState(false)
  const locked = useRef(false)
  const hintId = useId()
  if (!state || (!state.available && !state.enabled)) return null
  const current = state

  async function toggle(): Promise<void> {
    if (locked.current) return
    locked.current = true
    setSending(true)
    try {
      await runExtensionCommand(sessionId, RELEASE_COMMAND, current.enabled ? 'off' : 'on', {
        control: 'release',
        failed: 'Could not change release mode.',
      })
    } catch (error) {
      useChatStore.getState().setError(sessionId, ipcErrorText(error))
    } finally {
      locked.current = false
      setSending(false)
    }
  }

  const hint = releaseHint(state)
  return (
    <>
      <TooltipButton
        type="button"
        role="switch"
        aria-label="Release manager"
        aria-checked={state.enabled}
        aria-busy={sending}
        aria-disabled={sending}
        aria-describedby={hintId}
        tooltip={{
          label: state.enabled ? 'Switch release mode off' : 'Release manager',
          description: hint,
        }}
        data-state={state.role}
        onClick={() => {
          if (!sending) void toggle()
        }}
        className={clsx(
          'flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-base font-medium transition-colors',
          state.role === 'off' && 'text-text-secondary hover:bg-bg-secondary hover:text-text',
          state.role === 'standby' && 'text-text',
          state.role === 'active' && 'bg-accent-soft text-text',
        )}
      >
        <span
          aria-hidden="true"
          className={clsx(
            'h-1.5 w-1.5 rounded-full',
            state.problem
              ? 'bg-warning'
              : state.role === 'active'
                ? 'bg-accent'
                : 'bg-text-tertiary',
          )}
        />
        <span>Release</span>
        {state.role === 'standby' && (
          <span className="text-text-tertiary text-2xs font-mono tracking-wide uppercase">
            standby
          </span>
        )}
        <span id={hintId} className="sr-only">
          {hint}
        </span>
      </TooltipButton>
      <span role="status" className="sr-only">
        {sending ? 'Applying…' : ''}
      </span>
    </>
  )
}

/** A live lane's composer switches: Swarm, then Release where the repository has a policy. */
export function LaneSwitches({ sessionId }: { sessionId: string }): React.JSX.Element {
  return (
    <>
      <SwarmSwitch sessionId={sessionId} />
      <ReleaseSwitch sessionId={sessionId} />
    </>
  )
}
