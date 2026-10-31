import { useCallback } from 'react'
import { confirmSettingsAccess } from '@/features/machines/settingsAccess'
import { machineMoveTargets } from '@/lib/claudeGateway'
import { machineLabel, useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { AccountSwitcher } from './AccountSwitcher'

/**
 * A Host lane's account switcher: the same control as This Mac's, fed by the
 * Host. The Host does the move (`claude.account`: stop, rebind, resume under the
 * lane's fence), so it needs lane control plus the Host's configuration grant,
 * which it asks for with the dialog Settings uses.
 */
export function HostAccountRouting({
  sessionId,
  onMoved,
}: {
  sessionId: string
  onMoved: () => void
}): React.JSX.Element | null {
  const live = useSessionsStore((s) => s.live[sessionId])
  const hostId = live?.target?.kind === 'remote' ? live.target.hostId : undefined
  const laneId = live?.laneId
  const host = useRemoteLanesStore((s) => (hostId ? s.hosts[hostId] : undefined))
  const ready = host?.state === 'ready'
  const configurable = ready && host.capabilities.includes('machine.configure')
  const held =
    ready &&
    host.capabilities.includes('sessions.control') &&
    host.lanes.find((l) => l.laneId === laneId)?.control.controller?.self === true

  const load = useCallback(async () => {
    if (!hostId || !laneId) return []
    const data = await window.phosphor.invoke('hosts:settingsRead', hostId, 'providers')
    return machineMoveTargets(data.providers?.accounts ?? [], laneId)
  }, [hostId, laneId])

  if (!hostId || !laneId || host?.configurationSupported !== true) return null
  const label = machineLabel(hostId)
  return (
    <AccountSwitcher
      summary={`Move this lane to another Claude account on ${label}.`}
      blocked={held ? undefined : 'Take control of this lane to move it to another account.'}
      where={label}
      ready={configurable}
      beforeOpen={async () => {
        if (configurable) return true
        if (!(await confirmSettingsAccess(label))) return false
        await window.phosphor.invoke('hosts:settingsAccess', hostId)
        return true
      }}
      load={load}
      move={async (accountId) => {
        await window.phosphor.invoke('hosts:claudeAccount', hostId, laneId, accountId)
        onMoved()
      }}
    />
  )
}
