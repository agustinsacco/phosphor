import { useEffect, useState } from 'react'
import type { IpcInvokeMap } from '@shared/ipc'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { CopyCommand } from './MachineControls'
import type { ReadinessCheck } from './machinePresentation'

type ClaudeDetail = NonNullable<IpcInvokeMap['hosts:claude']['result']>
export function claudeReadiness(detail: ClaudeDetail): ReadinessCheck {
  if (detail.provider !== 'ok')
    return {
      name: 'Claude',
      ok: false,
      short: `Claude provider ${detail.provider}`,
      detail: `Claude provider ${detail.provider}. Install or update the pi provider on this machine.`,
      command: 'pi install npm:@saccolabs/pi-claude-cli',
    }
  if (detail.cli !== 'ok')
    return {
      name: 'Claude',
      ok: false,
      short: 'Claude Code missing',
      detail: 'Claude Code is missing. Run phosphor setup on this machine.',
      command: 'phosphor setup',
    }
  return {
    name: 'Claude',
    ok: detail.auth === 'ok',
    short: `Claude ${detail.auth}`,
    detail:
      detail.auth === 'ok'
        ? 'Signed in and ready'
        : detail.auth === 'signed-out'
          ? 'Sign in to Claude on this machine.'
          : 'Claude sign-in status is unknown. Run phosphor setup on this machine.',
    command:
      detail.auth === 'ok'
        ? undefined
        : detail.auth === 'signed-out'
          ? 'phosphor providers login claude'
          : 'phosphor setup',
  }
}
export function useClaudeReadiness(hostId: string, refresh: number): ReadinessCheck | null {
  const connection = useRemoteLanesStore((s) => s.hosts[hostId])
  const connected = connection?.state === 'ready'
  const [check, setCheck] = useState<{ hostId: string; check: ReadinessCheck } | null>(null)
  useEffect(() => {
    let live = true
    setCheck(null)
    if (connected)
      void window.phosphor.invoke('hosts:claude', hostId).then(
        (detail) => {
          if (live) setCheck(detail ? { hostId, check: claudeReadiness(detail) } : null)
        },
        () => {
          if (live) setCheck(null)
        },
      )
    return () => {
      live = false
    }
  }, [hostId, connected, connection?.connectionToken, refresh])
  return connected && check?.hostId === hostId ? check.check : null
}
export function ClaudeReadiness({ check }: { check: ReadinessCheck | null }) {
  return check ? (
    <div>
      <p>Claude: {check.detail}</p>
      {check.command && <CopyCommand command={check.command} />}
    </div>
  ) : null
}
