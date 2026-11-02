import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { machineReachability } from '../machineReachability'
import { useClaudeReadiness } from '../machineOverview'
import { CheckIcon, ReloadIcon } from '@/components/icons'
import { useEffect, useState } from 'react'
import { type MachineView } from '@shared/control-api'
import { useMachinesStore } from '@/stores/machines'
import { useOpenSettings } from '@/features/settings/useOpenSettings'
import { Button } from '@/components/form'
import { CopyCommand, Troubleshooting } from '../MachineControls'
import { CheckRow } from '../MachineUi'
import { MachineProviders } from '../MachineProviders'

export function OnlineAndProviders({
  added,
  providers,
  onProviders,
  onOpen,
}: {
  added: MachineView
  providers: boolean
  onProviders: () => void
  onOpen: () => void
}): React.JSX.Element {
  const directory = useMachinesStore()
  const machine = directory.machines.find((m) => m.id === added.id) ?? added
  const connection = useRemoteLanesStore((s) => s.hosts[added.id])
  const openSettings = useOpenSettings()
  const reachability = machineReachability(
    machine,
    connection?.state,
    (directory.nowMs || Date.now()) + directory.clockOffsetMs,
  )
  const online = reachability.ok
  const [attempt, setAttempt] = useState(0)
  const { check: claude, loading: claudeLoading } = useClaudeReadiness(
    providers ? added.id : '',
    attempt,
  )
  useEffect(() => {
    if (providers || !online) return
    const timer = setTimeout(onProviders, 1500)
    return () => clearTimeout(timer)
  }, [online, providers, onProviders])
  if (!providers)
    return (
      <section className="space-y-3" aria-label="Online">
        <h2 className="text-xl font-semibold">{added.label} added</h2>
        <p role="status" className="flex items-center gap-2 font-medium">
          {online ? (
            <CheckIcon size={18} className="text-success" />
          ) : (
            <ReloadIcon size={18} className="text-accent animate-spin" />
          )}
          {online ? `${added.label} is online` : reachability.detail}
        </p>
        {reachability.command && <CopyCommand command={reachability.command} />}
        <Troubleshooting summary="Stuck?">
          <p className="pt-2">
            {!machine.lastSeenAt
              ? 'Waiting for the first connection. Start the Host and check its service.'
              : 'Offline. Wake the machine and check Tailscale and the Host service.'}
          </p>
          <p>
            Enrolled but not reachable? Confirm both computers are on the same tailnet, MagicDNS and
            HTTPS certificates are enabled, and Tailscale access rules allow the Host endpoint.
            Enrollment alone does not prove reachability.
          </p>
        </Troubleshooting>
      </section>
    )
  return (
    <section className="space-y-3" aria-label="Providers">
      <h2 className="text-xl font-semibold">Choose how the Host runs models</h2>
      <p className="text-text-secondary">
        Provider credentials stay on {added.label}, not on this computer.
      </p>
      {(claude || claudeLoading) && (
        <CheckRow
          check={claude ?? { name: 'Claude Code', ok: false, loading: true, short: '', detail: '' }}
        />
      )}
      <MachineProviders
        hostId={added.id}
        refresh={attempt}
        onConfigure={
          connection?.configurationSupported
            ? () => {
                onOpen()
                openSettings(added.id, 'accounts')
              }
            : undefined
        }
      />
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setAttempt((n) => n + 1)}>Check readiness again</Button>
        <Button onClick={onOpen}>Open machine</Button>
      </div>
    </section>
  )
}
