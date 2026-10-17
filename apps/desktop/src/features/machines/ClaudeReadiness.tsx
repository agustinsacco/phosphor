import { useEffect, useState } from 'react'
import type { IpcInvokeMap } from '@shared/ipc'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { CopyCommand } from './MachineControls'
import type { ReadinessCheck } from './machinePresentation'

type ClaudeDetail = NonNullable<IpcInvokeMap['hosts:claude']['result']>
export function claudeReadiness(detail: ClaudeDetail): ReadinessCheck {
  if (detail.provider !== 'ok')
    return {
      name: 'Claude Code',
      ok: false,
      short: `Claude Code provider ${detail.provider}`,
      detail: `Claude Code provider ${detail.provider}. Install or update the pi provider on this machine.`,
      command: 'pi install npm:@saccolabs/pi-claude-cli',
    }
  if (detail.cli !== 'ok')
    return {
      name: 'Claude Code',
      ok: false,
      short: 'Claude Code missing',
      detail: 'Claude Code is missing. Run phosphor setup on this machine.',
      command: 'phosphor setup',
    }
  return {
    name: 'Claude Code',
    ok: detail.auth === 'ok',
    short: `Claude Code ${detail.auth}`,
    detail:
      detail.auth === 'ok'
        ? 'Signed in and ready'
        : detail.auth === 'signed-out'
          ? 'Sign in to Claude Code on this machine.'
          : 'Claude Code sign-in status is unknown. Run phosphor setup on this machine.',
    command:
      detail.auth === 'ok'
        ? undefined
        : detail.auth === 'signed-out'
          ? 'phosphor providers login claude'
          : 'phosphor setup',
  }
}
/**
 * The Host's live Claude detail. `loading` is true while a read for this Host
 * is in flight; `check` stays null when the Host is older or unreachable.
 */
export function useClaudeReadiness(
  hostId: string,
  refresh: number,
): { check: ReadinessCheck | null; loading: boolean } {
  const connection = useRemoteLanesStore((s) => s.hosts[hostId])
  const connected = connection?.state === 'ready'
  const [state, setState] = useState<{
    hostId: string
    check: ReadinessCheck | null
    loading: boolean
  } | null>(null)
  useEffect(() => {
    let live = true
    setState(connected ? { hostId, check: null, loading: true } : null)
    if (connected)
      void window.phosphor.invoke('hosts:claude', hostId).then(
        (detail) => {
          if (live)
            setState({ hostId, check: detail ? claudeReadiness(detail) : null, loading: false })
        },
        () => {
          if (live) setState({ hostId, check: null, loading: false })
        },
      )
    return () => {
      live = false
    }
  }, [hostId, connected, connection?.connectionToken, refresh])
  const current = connected && state?.hostId === hostId ? state : null
  return { check: current?.check ?? null, loading: current?.loading ?? false }
}
export function ClaudeReadiness({ check }: { check: ReadinessCheck | null }) {
  return check ? (
    <div>
      <p>Claude Code: {check.detail}</p>
      {check.command && <CopyCommand command={check.command} />}
    </div>
  ) : null
}
