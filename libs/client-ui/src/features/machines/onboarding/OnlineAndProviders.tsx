import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { machineReachability } from '../machineReachability'
import { ClaudeReadiness, useClaudeReadiness } from '../ClaudeReadiness'
import { CheckIcon, ReloadIcon } from '@/components/icons'
import { TooltipSummary } from '@/components/Tooltip'
import { useEffect, useState } from 'react'
import { type MachineView } from '@shared/control-api'
import type { MachineProvider } from '@shared/host-protocol-machine'
import { useMachinesStore } from '@/stores/machines'
import { Button } from '@/components/form'
import { CopyCommand } from '../MachineControls'
import { HOST_RUN, HOST_SERVICE_STATUS, HOST_SERVICE_INSTALL } from '../machinePresentation'

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
  const connection = useRemoteLanesStore((s) => s.hosts[added.id]?.state)
  const reachability = machineReachability(
    machine,
    connection,
    (directory.nowMs || Date.now()) + directory.clockOffsetMs,
  )
  const online = reachability.ok
  const [readiness, setReadiness] = useState<MachineProvider[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const { check: claude, loading: claudeLoading } = useClaudeReadiness(
    providers ? added.id : '',
    attempt,
  )
  useEffect(() => {
    if (!providers) return
    let live = true
    setReadiness(null)
    setFailed(false)
    void window.phosphor.invoke('hosts:providers', added.id).then(
      (value) => {
        if (live) setReadiness(value)
      },
      () => {
        if (live) setFailed(true)
      },
    )
    return () => {
      live = false
    }
  }, [providers, added.id, attempt])
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
        <details className="space-y-3 text-text-secondary">
          <TooltipSummary>Stuck?</TooltipSummary>
          <p>
            {!machine.lastSeenAt
              ? 'Waiting for the first connection. Start the Host and check its service.'
              : 'Offline. Wake the machine and check Tailscale and the Host service.'}
          </p>
          <p>1. Check the Host service.</p>
          <CopyCommand command={HOST_SERVICE_STATUS} />
          <p>2. If no service is installed, install it.</p>
          <CopyCommand command={HOST_SERVICE_INSTALL} />
          <p>3. For debugging, run the Host in the foreground.</p>
          <CopyCommand command={HOST_RUN} />
          <p>
            Enrolled but not reachable? Confirm both computers are on the same tailnet, MagicDNS and
            HTTPS certificates are enabled, and Tailscale access rules allow the Host endpoint.
            Enrollment alone does not prove reachability.
          </p>
        </details>
      </section>
    )
  return (
    <section className="space-y-3" aria-label="Providers">
      <h2 className="text-xl font-semibold">Choose how the Host runs models</h2>
      <p className="text-text-secondary">
        Provider credentials stay on {added.label}, not on this computer.
      </p>
      {claudeLoading ? (
        <p role="status">Checking Claude Code…</p>
      ) : (
        <ClaudeReadiness check={claude} />
      )}
      {readiness
        ?.filter((provider) => !claude || !['claude', 'pi-claude-cli'].includes(provider.id))
        .map((provider) => (
          <p key={provider.id}>
            {provider.name}:{' '}
            {provider.status === 'ready'
              ? 'Ready'
              : provider.status === 'not_ready'
                ? 'Sign-in needed'
                : 'Not reported'}
          </p>
        ))}
      {!readiness && (
        <p role="status">
          {failed
            ? 'Host not reachable. Bring it online, then check readiness again.'
            : 'Checking provider readiness…'}
        </p>
      )}
      {readiness?.length === 0 && (
        <p>No providers reported yet. Check the machine’s Readiness section.</p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setAttempt((n) => n + 1)}>Check readiness again</Button>
        <Button onClick={onOpen}>Open machine Readiness</Button>
      </div>
      <p>
        Use Sign in in the machine’s Readiness section. If unavailable, run this in a terminal over
        SSH, replacing PROVIDER with your provider:
      </p>
      <CopyCommand command="phosphor providers login PROVIDER" />
    </section>
  )
}
