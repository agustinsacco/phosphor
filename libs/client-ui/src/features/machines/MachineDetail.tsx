import { CopyButton } from '@/components/CopyButton'
import { Button } from '@/components/form'
import { TooltipSummary } from '@/components/Tooltip'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { machineStatus, type MachineView } from '@shared/control-api'
import { useEffect, useRef, useState } from 'react'
import { useClaudeReadiness } from './ClaudeReadiness'
import { CopyCommand } from './MachineControls'
import { MachineDetailHeader } from './MachineDetailHeader'
import {
  HOST_RUN,
  HOST_SERVICE_INSTALL,
  HOST_SERVICE_STATUS,
  platformName,
  readinessChecks,
  readinessFreshness,
  relativeTime,
} from './machinePresentation'
import { machineHeadline } from './machineReachability'
import { confirmSettingsNavigation } from './machineSettingsDrafts'
import { Card, CheckRow, Fact, Facts, Spinner, type CheckItem } from './MachineUi'
import { MachineTerminal } from './MachineTerminal'
import { OnThisMachine } from './OnThisMachine'
import { ProviderSignIn } from './ProviderSignIn'

const DAY_MS = 86_400_000

export function MachineDetail({
  machine,
  now,
  offset,
  onRemove,
  navigation,
  settings,
}: {
  machine: MachineView
  now: number
  offset: number
  onRemove: () => void
  navigation?: React.ReactNode
  settings?: React.ReactNode
}): React.JSX.Element {
  const connection = useRemoteLanesStore((s) => s.hosts[machine.id])
  const [refresh, setRefresh] = useState(0)
  const [checking, setChecking] = useState(false)
  const [checkedAt, setCheckedAt] = useState<number | null>(null)
  const [reconnecting, setReconnecting] = useState(false)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const claude = useClaudeReadiness(machine.id, refresh)
  const corrected = now + offset
  const headline = machineHeadline(machine, connection, corrected)
  const freshness = readinessFreshness(machine, now, offset)
  const version = connection?.hostVersion || machine.hostVersion
  const offlineLong =
    !!machine.lastSeenAt &&
    machineStatus(machine, now, offset) === 'down' &&
    corrected - Date.parse(machine.lastSeenAt) > DAY_MS

  async function checkAgain(): Promise<void> {
    setChecking(true)
    try {
      await useMachinesStore.getState().refresh()
    } finally {
      if (live.current) {
        setRefresh((n) => n + 1)
        setChecking(false)
        setCheckedAt(Date.now())
      }
    }
  }
  async function reconnect(): Promise<void> {
    setReconnecting(true)
    try {
      await window.phosphor.invoke('hosts:reconnect', machine.id)
    } catch {
      /* The connection status says what happened. */
    } finally {
      if (live.current) setReconnecting(false)
    }
  }

  const connectionCheck: CheckItem = {
    name: 'Connection',
    ok: headline.ok,
    // Waiting and connecting are progress, not failures: the setup panel holds the one command.
    loading: headline.tone === 'pending',
    loadingText: headline.label,
    short: headline.label,
    detail: headline.detail,
    command: headline.command,
  }
  const reported: CheckItem[] = readinessChecks(machine.readiness, machine.endpoint).map(
    (check) => {
      // An offline machine's last report is history: shown, but not a list of fixes.
      if (freshness === 'stale') return { ...check, muted: !check.ok }
      if (check.name !== 'Claude Code') return check
      if (claude.loading) return { ...check, loading: true }
      return claude.check ?? check
    },
  )

  return (
    <div data-testid="machine-detail" className="space-y-4">
      <MachineDetailHeader
        machine={machine}
        headline={headline}
        version={version}
        now={corrected}
        checking={checking}
        reconnecting={reconnecting}
        onCheck={() => void checkAgain()}
        onReconnect={() => void reconnect()}
        onUpdate={() =>
          void confirmSettingsNavigation(machine.id).then((go) => {
            if (go)
              useMachinesStore
                .getState()
                .show({ kind: 'machine', id: machine.id, settings: 'advanced' })
          })
        }
      />
      {navigation}
      {settings ?? (
        <>
          {!machine.lastSeenAt && (
            <section
              aria-label="Finish setup"
              className="border-border bg-bg-secondary space-y-3 rounded-lg border p-4"
            >
              <div className="flex items-center gap-2">
                <Spinner size={13} />
                <h2 className="text-lg font-semibold">
                  Waiting for {machine.label} to finish setup
                </h2>
              </div>
              <p className="text-text-secondary text-base">
                This page updates on its own once {machine.label} checks in. If setup stopped, run
                it again on {machine.label}; it resumes where it left off.
              </p>
              <CopyCommand command="phosphor setup" />
              <Troubleshooting />
            </section>
          )}
          {offlineLong && (
            <section
              aria-label="Offline"
              className="border-border space-y-3 rounded-lg border p-4 text-base"
            >
              <p className="text-text-secondary">
                Offline for more than a day. Check the service on {machine.label}.
              </p>
              <CopyCommand command={HOST_SERVICE_STATUS} />
            </section>
          )}

          {/* Two stacks, not a row-by-row grid: a tall Readiness card leaves no hole beside it. */}
          <div className="grid items-start gap-4 lg:grid-cols-2">
            <div className="space-y-4">
              <Card
                title="Readiness"
                aside={
                  checking ? (
                    <>
                      <Spinner size={10} /> Checking
                    </>
                  ) : (
                    // The report rides each heartbeat; "checked" is when this computer last asked.
                    <span role="status">
                      {[
                        machine.lastSeenAt
                          ? `Reported ${relativeTime(machine.lastSeenAt, corrected)}`
                          : 'Not reported yet',
                        checkedAt
                          ? `checked ${relativeTime(new Date(checkedAt).toISOString(), Date.now())}`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  )
                }
              >
                <CheckRow check={connectionCheck} />
                {freshness === 'none' ? (
                  <p className="text-text-secondary py-1.5 text-base">
                    {machine.label} reports pi, Claude and Tailscale once it first connects.
                  </p>
                ) : (
                  <>
                    {freshness === 'stale' && machine.lastSeenAt && (
                      <p className="text-text-tertiary py-1 text-sm">
                        As last reported, {relativeTime(machine.lastSeenAt, corrected)}. It may have
                        changed since.
                      </p>
                    )}
                    {reported.map((check) => (
                      <CheckRow key={check.name} check={check} />
                    ))}
                  </>
                )}
              </Card>
              {connection && (
                <Card title="On this machine">
                  <OnThisMachine hostId={machine.id} />
                </Card>
              )}
            </div>
            <div className="space-y-4">
              <Card title="Providers">
                <ProviderSignIn
                  key={machine.id}
                  hostId={machine.id}
                  refresh={refresh}
                  onConfigure={
                    connection?.configurationSupported
                      ? () =>
                          useMachinesStore
                            .getState()
                            .show({ kind: 'machine', id: machine.id, settings: 'providers' })
                      : undefined
                  }
                />
              </Card>
              <MachineDetailFacts machine={machine} version={version} />
            </div>
          </div>
          {connection && <MachineTerminal hostId={machine.id} label={machine.label} />}

          <section
            aria-label="Remove machine"
            className="border-border flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3"
          >
            <p className="text-text-secondary min-w-0 flex-1 text-base">
              Remove this machine from your account. Lanes, routines and files stay on the machine
              and return when you add it again.
            </p>
            <Button size="sm" variant="danger" onClick={onRemove}>
              Remove machine
            </Button>
          </section>
        </>
      )}
    </div>
  )
}

function Troubleshooting(): React.JSX.Element {
  return (
    <details className="text-text-secondary space-y-2 text-base">
      <TooltipSummary className="cursor-pointer">Troubleshooting</TooltipSummary>
      <p className="pt-2">Check the Host service:</p>
      <CopyCommand command={HOST_SERVICE_STATUS} />
      <p>If no service is installed, install it:</p>
      <CopyCommand command={HOST_SERVICE_INSTALL} />
      <p>To watch it run in the foreground:</p>
      <CopyCommand command={HOST_RUN} />
    </details>
  )
}

function MachineDetailFacts({
  machine,
  version,
}: {
  machine: MachineView
  version: string | null | undefined
}): React.JSX.Element {
  return (
    <details className="machine-facts">
      <TooltipSummary>Connection & identity</TooltipSummary>
      <Card title="Details">
        <Facts>
          <Fact label="Hostname">{machine.hostname}</Fact>
          <Fact label="Platform">
            {platformName(machine.platform)} {machine.arch}
          </Fact>
          <Fact label="Host version">{version ?? 'Not reported'}</Fact>
          <Fact label="Enrolled">{new Date(machine.enrolledAt).toLocaleDateString()}</Fact>
          <Fact label="Address">{machine.endpoint ?? 'Not published'}</Fact>
          <Fact label="Fingerprint">
            <span className="flex items-center gap-1">
              <code className="truncate font-mono text-sm">{machine.keyFingerprint}</code>
              <CopyButton size="icon" text={machine.keyFingerprint} title="Copy fingerprint" />
            </span>
          </Fact>
          <Fact label="Machine id">
            <span className="flex items-center gap-1">
              <code className="truncate font-mono text-sm">{machine.id}</code>
              <CopyButton size="icon" text={machine.id} title="Copy machine id" />
            </span>
          </Fact>
        </Facts>
      </Card>
    </details>
  )
}
