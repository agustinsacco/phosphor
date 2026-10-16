import { OnThisMachine } from './OnThisMachine'
import { ProviderSignIn } from './ProviderSignIn'
import { useEffect, useRef, useState } from 'react'
import { machineStatus, type MachineView } from '@shared/control-api'
import type { ClaudeStatus, PiHealth, SubscriptionProviderStatus } from '@shared/models'
import { PageShell } from '@/components/PageShell'
import { PaneTitle } from '@/components/PaneShell'
import { StatTile } from '@/components/StatTile'
import { Button } from '@/components/form'
import { TooltipButton, tooltipProps } from '@/components/Tooltip'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { useAccount } from '@/features/settings/useAccount'
import { useSettingsUiStore } from '@/features/settings/settingsUiStore'
import { machinesAccountGeneration, useMachinesStore } from '@/stores/machines'
import { useSessionsStore } from '@/stores/sessions'
import { AddMachineDialog } from './AddMachineDialog'
import { MachineLabel } from './MachineLabel'
import { CopyCommand, HostGuide, HostSetup } from './MachineControls'
import {
  HOST_RUN,
  HOST_SERVICE_INSTALL,
  HOST_SERVICE_STATUS,
  LOCAL_MACHINE,
  PI_INSTALL,
  localMachineLabel,
  machineSubtitle,
  platformName,
  readinessFreshness,
  readinessChecks,
  relativeTime,
  sortMachines,
  statusText,
  type ReadinessCheck,
} from './machinePresentation'
import { controlMessage } from './controlMessages'

interface Computer {
  health: PiHealth | null
  claude: ClaudeStatus | null
  providers: SubscriptionProviderStatus[] | null
  error: boolean
}
function useThisComputer(): Computer {
  const [state, setState] = useState<Computer>({
    health: null,
    claude: null,
    providers: null,
    error: false,
  })
  useEffect(() => {
    let live = true
    const merge = (patch: Partial<Computer>): void => {
      if (live) setState((current) => ({ ...current, ...patch }))
    }
    void window.phosphor.invoke('pi:health').then(
      (health) => merge({ health }),
      () => merge({ error: true }),
    )
    void window.phosphor.invoke('packages:claudeStatus').then(
      (claude) => merge({ claude }),
      () => merge({ error: true }),
    )
    void window.phosphor.invoke('pi:subscriptionAuth').then(
      (providers) => merge({ providers }),
      () => merge({ error: true }),
    )
    return () => {
      live = false
    }
  }, [])
  return state
}
function Dot({ online }: { online: boolean }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={`h-2 w-2 shrink-0 rounded-full ${online ? 'bg-success' : 'bg-text-tertiary'}`}
    />
  )
}
function ReadinessChips({ checks }: { checks: ReadinessCheck[] }): React.JSX.Element {
  const problems = checks.filter((check) => !check.ok)
  return (
    <span className="flex flex-wrap gap-1.5">
      {problems.length ? (
        problems.map((check) => (
          <span
            key={check.name}
            {...tooltipProps(check.detail)}
            className="bg-warning/10 text-warning rounded px-2 py-0.5 text-sm"
          >
            {check.short}
          </span>
        ))
      ) : (
        <span className="text-success text-base">Ready</span>
      )}
    </span>
  )
}
/**
 * The right side of a row. Readiness shows only while it is current: a
 * machine that never connected has reported nothing, and an offline one's
 * last report may no longer be true (its status line already says offline).
 */
function RowSummary({
  machine,
  now,
  offset,
}: {
  machine: MachineView
  now: number
  offset: number
}): React.JSX.Element | null {
  const freshness = readinessFreshness(machine, now, offset)
  if (!machine.lastSeenAt)
    return (
      <span className="bg-accent-soft text-accent rounded px-2 py-0.5 text-sm">Finish setup</span>
    )
  if (freshness !== 'live') return null
  return <ReadinessChips checks={readinessChecks(machine.readiness)} />
}
export function MachineRow({
  machine,
  now,
  offset,
  onOpen,
}: {
  machine: MachineView
  now: number
  offset: number
  onOpen: () => void
}): React.JSX.Element {
  return (
    <TooltipButton
      tooltip={`Open ${machine.label}`}
      data-testid="enrolled-machine-row"
      data-status={machineStatus(machine, now, offset)}
      className="hover:bg-bg-secondary focus-visible:bg-bg-secondary focus-visible:outline-accent flex w-full items-center gap-4 px-5 py-4 text-left transition-colors"
      onClick={onOpen}
    >
      <Dot online={machineStatus(machine, now, offset) === 'up'} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-lg font-medium">{machine.label}</span>
        <span className="text-text-secondary mt-1 block truncate text-base">
          {machineSubtitle(machine, now, offset)}
        </span>
      </span>
      <span className="flex max-w-72 flex-col items-end gap-1.5">
        <RowSummary machine={machine} now={now} offset={offset} />
        {machine.lanes && (machine.lanes.running > 0 || machine.lanes.waiting > 0) && (
          <span className="text-text-secondary text-sm">
            {machine.lanes.running} running · {machine.lanes.waiting} waiting
          </span>
        )}
      </span>
      <span aria-hidden className="text-text-tertiary">
        ›
      </span>
    </TooltipButton>
  )
}
function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="border-border border-t pt-5">
      <h3 className="text-text-tertiary mb-4 font-mono text-xs font-semibold uppercase tracking-wider">
        {title}
      </h3>
      {children}
    </section>
  )
}
function Checks({
  checks,
  local = false,
}: {
  checks: ReadinessCheck[]
  local?: boolean
}): React.JSX.Element {
  return (
    <div className="space-y-4">
      {checks.map((check) => (
        <div key={check.name}>
          <div className="flex items-center gap-2">
            <Dot online={check.ok} />
            <h4 className="text-lg font-medium">{check.name}</h4>
          </div>
          <p className="text-text-secondary mb-2 mt-1 text-base">{check.detail}</p>
          {!check.ok && check.command && <CopyCommand command={check.command} />}
        </div>
      ))}
      {local && (
        <Button
          onClick={() => {
            useSettingsUiStore.getState().setTab('accounts')
            useSettingsUiStore.getState().setOpen(true)
          }}
        >
          Provider sign-ins
        </Button>
      )}
    </div>
  )
}
export function MachinesPage(): React.JSX.Element {
  const { view: account, error: accountError } = useAccount()
  const signedIn = account?.account.status === 'signed-in'
  const state = useMachinesStore()
  const computer = useThisComputer()
  const liveHere = useSessionsStore((s) => Object.keys(s.live).length)
  useEffect(() => () => useMachinesStore.setState({ adding: false }), [])
  const adding = state.adding
  const setAdding = (adding: boolean): void => useMachinesStore.setState({ adding })
  const [removing, setRemoving] = useState<MachineView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const selected = state.view.kind === 'machine' ? state.view.id : null
  const machine = state.machines.find((entry) => entry.id === selected)
  const local = selected === LOCAL_MACHINE
  const now = state.nowMs || Date.now()
  const correctedNow = now + state.clockOffsetMs
  const localChecks: ReadinessCheck[] = [
    {
      name: 'pi',
      ok: computer.health?.ok === true,
      short: computer.health ? 'pi unavailable' : 'Checking pi',
      detail: computer.health
        ? computer.health.ok
          ? `Ready · ${computer.health.version}`
          : (computer.health.reason ?? 'Install pi to run lanes.')
        : 'Checking pi…',
      command: computer.health && !computer.health.ok ? PI_INSTALL : undefined,
    },
    {
      name: 'Claude',
      ok: computer.claude?.binary.found === true && computer.claude.auth.loggedIn === true,
      short: !computer.claude
        ? 'Checking Claude'
        : !computer.claude.binary.found
          ? 'Claude missing'
          : 'Claude signed out',
      detail: computer.claude
        ? !computer.claude.binary.found
          ? 'Install the Claude CLI under Settings → Extensions → Claude Code.'
          : computer.claude.auth.loggedIn
            ? 'Signed in'
            : 'Sign in under Settings → Accounts.'
        : 'Checking Claude…',
    },
  ]
  const back = (): void => {
    state.show({ kind: 'list' })
    setError(null)
  }
  async function remove(): Promise<void> {
    if (!removing || busy) return
    const generation = machinesAccountGeneration()
    setBusy(true)
    setError(null)
    try {
      const result = await window.phosphor.invoke('control:removeMachine', removing.id)
      if (!live.current) return
      if (
        generation !== machinesAccountGeneration() ||
        !useMachinesStore.getState().remoteEnabled
      ) {
        setError(controlMessage('signed-out'))
        return
      }
      if (result.ok || result.error.code === 'not-found') {
        setRemoving(null)
        back()
        setNotice(result.ok ? 'Machine removed.' : 'That machine was already removed.')
        await state.refresh()
      } else setError(controlMessage(result.error.code))
    } catch {
      if (live.current) setError(controlMessage('offline'))
    } finally {
      if (live.current) setBusy(false)
    }
  }
  return (
    <PageShell title={<PaneTitle label="Machines" />}>
      <div data-testid="machines-page" className="flex-1 overflow-y-auto px-6 pb-10 pt-5">
        <div className="mx-auto max-w-4xl space-y-6">
          {selected && (
            <TooltipButton
              tooltip="Back to all machines"
              className="text-text-secondary hover:text-text -mb-3 text-base"
              onClick={back}
            >
              ← Machines
            </TooltipButton>
          )}
          <header className="flex flex-wrap items-start justify-between gap-4">
            <div>
              {machine && signedIn ? (
                <MachineLabel
                  key={machine.id}
                  machine={machine}
                  onSaved={(updated) => {
                    useMachinesStore.setState((current) => ({
                      machines: current.machines.map((entry) =>
                        entry.id === updated.id ? updated : entry,
                      ),
                    }))
                    void state.refresh()
                  }}
                />
              ) : (
                <h1 className="text-3xl font-semibold">
                  {local ? localMachineLabel(window.phosphor.platform) : 'Machines'}
                </h1>
              )}
              <p className="text-text-secondary mt-2 max-w-xl text-lg">
                {machine
                  ? machineSubtitle(machine, now, state.clockOffsetMs)
                  : local
                    ? `${platformName(window.phosphor.platform)} · Your local lanes run here`
                    : "This computer and the Hosts you've added. Lanes on other machines come later."}
              </p>
            </div>
            {!selected && (
              <span {...tooltipProps(signedIn ? undefined : 'Sign in with GitHub to add machines')}>
                <Button variant="primary" disabled={!signedIn} onClick={() => setAdding(true)}>
                  Add a machine
                </Button>
              </span>
            )}
          </header>
          {notice && (
            <p role="status" className="text-success text-base">
              {notice}
            </p>
          )}
          {(accountError || state.error || (error && !removing)) && (
            <div
              role="alert"
              className="border-border bg-bg-secondary rounded-lg border p-4 text-base"
            >
              {accountError ?? error ?? controlMessage(state.error ?? 'offline')}{' '}
              <Button size="xs" onClick={() => void state.refresh()}>
                Retry
              </Button>
            </div>
          )}
          {!selected ? (
            <>
              {state.loading && (
                <p role="status" className="text-text-secondary text-base">
                  Updating machines…
                </p>
              )}
              <div className="border-border divide-border overflow-hidden rounded-lg border bg-surface divide-y">
                <TooltipButton
                  tooltip={`Open ${localMachineLabel(window.phosphor.platform)}`}
                  data-testid="local-machine-row"
                  className="hover:bg-bg-secondary focus-visible:bg-bg-secondary focus-visible:outline-accent flex w-full items-center gap-4 px-5 py-4 text-left"
                  onClick={() => state.show({ kind: 'machine', id: LOCAL_MACHINE })}
                >
                  <Dot online />
                  <span className="min-w-0 flex-1">
                    <span className="block text-lg font-medium">
                      {localMachineLabel(window.phosphor.platform)}
                    </span>
                    <span className="text-text-secondary mt-1 block text-base">
                      {platformName(window.phosphor.platform)} · Online
                      {liveHere > 0
                        ? ` · ${liveHere} live ${liveHere === 1 ? 'lane' : 'lanes'}`
                        : ''}
                    </span>
                  </span>
                  <span className="hidden md:block">
                    <ReadinessChips checks={localChecks} />
                  </span>
                  <span aria-hidden className="text-text-tertiary">
                    ›
                  </span>
                </TooltipButton>
                {signedIn &&
                  sortMachines(state.machines, now, state.clockOffsetMs).map((entry) => (
                    <MachineRow
                      key={entry.id}
                      machine={entry}
                      now={now}
                      offset={state.clockOffsetMs}
                      onOpen={() => {
                        setError(null)
                        state.show({ kind: 'machine', id: entry.id })
                      }}
                    />
                  ))}
              </div>
              {!signedIn ? (
                <div className="border-border rounded-lg border p-5">
                  <h2 className="text-lg font-medium">Sign in with GitHub to add other machines</h2>
                  <p className="text-text-secondary mb-4 mt-1 text-base">
                    Sign-in is optional. Your local lanes stay on this computer.
                  </p>
                  <Button
                    disabled={account?.account.status === 'signing-in'}
                    onClick={() => {
                      void window.phosphor
                        .invoke('account:signIn')
                        .catch(() => setError('Could not start sign-in. Try again.'))
                    }}
                  >
                    {account?.account.status === 'signing-in'
                      ? 'Finish in your browser…'
                      : 'Sign in with GitHub'}
                  </Button>
                </div>
              ) : (
                !state.loading &&
                !state.error &&
                !state.machines.length && (
                  <section className="border-border rounded-lg border p-6">
                    <h2 className="mb-2 text-xl font-semibold">Bring another machine online</h2>
                    <p className="text-text-secondary mb-5 text-base">
                      Run these steps on the other machine, then approve its code here.
                    </p>
                    <HostSetup collapsed />
                    <div className="mt-5 flex items-center gap-4">
                      <Button onClick={() => setAdding(true)}>Add a machine</Button>
                      <HostGuide />
                    </div>
                  </section>
                )
              )}
            </>
          ) : local ? (
            <div data-testid="machine-detail" className="space-y-6">
              <Section title="Status">
                <div className="grid grid-cols-2 gap-4">
                  <StatTile label="State" value="Online" />
                  <StatTile label="Live lanes" value={String(liveHere)} />
                </div>
              </Section>
              <Section title="Readiness">
                {computer.error && (
                  <p role="alert" className="text-danger mb-3 text-base">
                    Could not read all local checks. Open Settings to retry.
                  </p>
                )}
                <Checks checks={localChecks} local />
                <div className="mt-4 space-y-2">
                  {computer.providers?.map((provider) => (
                    <p key={provider.id} className="text-text-secondary text-base">
                      {provider.name}: {provider.status === 'ready' ? 'Signed in' : 'Not signed in'}
                    </p>
                  ))}
                </div>
              </Section>
              <Section title="About">
                <p className="text-text-secondary text-base">
                  {platformName(window.phosphor.platform)} · pi{' '}
                  {computer.health?.version ?? 'not available'}
                </p>
                <p className="text-text-secondary mt-2 text-base">
                  Local lanes run here. Sharing this computer comes later.
                </p>
              </Section>
            </div>
          ) : machine && signedIn ? (
            <div data-testid="machine-detail" className="space-y-6">
              {!machine.lastSeenAt && (
                <div className="border-border bg-bg-secondary space-y-3 rounded-lg border p-5">
                  <h2 className="text-xl font-semibold">Finish setting up {machine.label}</h2>
                  <p className="text-text-secondary text-base">Try it now on {machine.label}:</p>
                  <CopyCommand command={HOST_RUN} />
                  <p className="text-text-secondary text-base">
                    On Linux, keep it online after logout and reboot:
                  </p>
                  <CopyCommand command={HOST_SERVICE_INSTALL} />
                </div>
              )}
              {machine.lastSeenAt &&
                machineStatus(machine, now, state.clockOffsetMs) === 'down' &&
                correctedNow - Date.parse(machine.lastSeenAt) > 86400000 && (
                  <div className="border-border space-y-3 rounded-lg border p-5">
                    <p className="text-text-secondary text-base">
                      Offline for more than a day. Check the service on {machine.label}.
                    </p>
                    <CopyCommand command={HOST_SERVICE_STATUS} />
                  </div>
                )}
              <Section title="Status">
                <dl className="grid grid-cols-1 gap-4 text-base sm:grid-cols-3">
                  <div>
                    <dt className="text-text-secondary">State</dt>
                    <dd className="mt-1 font-medium">
                      {statusText(machine, now, state.clockOffsetMs)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-text-secondary">Last seen</dt>
                    <dd className="mt-1">
                      {machine.lastSeenAt
                        ? relativeTime(machine.lastSeenAt, correctedNow)
                        : 'No heartbeat yet'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-text-secondary">Enrolled</dt>
                    <dd className="mt-1">{new Date(machine.enrolledAt).toLocaleDateString()}</dd>
                  </div>
                </dl>
              </Section>
              <Section title="Readiness">
                {readinessFreshness(machine, now, state.clockOffsetMs) === 'none' ? (
                  <p className="text-text-secondary text-base">
                    {machine.label} reports pi, Claude and Tailscale once it first connects.
                  </p>
                ) : (
                  <>
                    {readinessFreshness(machine, now, state.clockOffsetMs) === 'stale' &&
                      machine.lastSeenAt && (
                        <p className="text-text-secondary mb-4 text-base">
                          As last reported, {relativeTime(machine.lastSeenAt, correctedNow)}. It may
                          have changed since.
                        </p>
                      )}
                    <Checks checks={readinessChecks(machine.readiness)} />
                    <ProviderSignIn key={machine.id} hostId={machine.id} />
                  </>
                )}
              </Section>
              <Section title="About">
                <dl className="mb-5 grid grid-cols-2 gap-4 text-base">
                  <div>
                    <dt className="text-text-secondary">Hostname</dt>
                    <dd>{machine.hostname}</dd>
                  </div>
                  <div>
                    <dt className="text-text-secondary">OS and architecture</dt>
                    <dd>
                      {platformName(machine.platform)} {machine.arch}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-text-secondary">Host version</dt>
                    <dd>{machine.hostVersion ?? 'Not reported'}</dd>
                  </div>
                </dl>
                <p className="text-text-secondary mb-2 text-base">Key fingerprint</p>
                <CopyCommand command={machine.keyFingerprint} />
                <p className="text-text-secondary mb-2 mt-4 text-base">Machine id</p>
                <CopyCommand command={machine.id} />
              </Section>
              <OnThisMachine hostId={machine.id} />
              <Section title="Remove machine">
                <p className="text-text-secondary mb-3 text-base">
                  Remove this machine from your account. Lanes, routines and files stay on the
                  machine and return when you add it again.
                </p>
                <Button
                  variant="danger"
                  onClick={() => {
                    setError(null)
                    setRemoving(machine)
                  }}
                >
                  Remove machine
                </Button>
              </Section>
            </div>
          ) : (
            <div className="border-border rounded-lg border p-5 text-base">
              {signedIn
                ? 'This machine is no longer in your account.'
                : 'Sign in again to see this machine.'}
              <Button className="ml-3" onClick={back}>
                All machines
              </Button>
            </div>
          )}
        </div>
      </div>
      {adding && <AddMachineDialog onClose={() => setAdding(false)} />}
      {removing && (
        <ModalOverlay
          onClose={() => {
            if (!busy) setRemoving(null)
          }}
        >
          <div role="dialog" aria-modal="true" aria-label="Remove machine">
            <ModalPanel
              width={480}
              title={`Remove ${removing.label}?`}
              footer={
                <>
                  <Button disabled={busy} onClick={() => setRemoving(null)}>
                    Cancel
                  </Button>
                  <Button variant="danger" disabled={busy} onClick={() => void remove()}>
                    {busy ? 'Removing…' : 'Remove machine'}
                  </Button>
                </>
              }
            >
              <div className="space-y-3 p-5 text-base">
                <p>
                  The Host stops at its next heartbeat. Lanes, routines and files stay on the
                  machine and return when you add it again.
                </p>
                <p className="text-text-secondary">
                  Add it again by running <code>phosphor setup</code> on {removing.label}.
                </p>
                {error && (
                  <p role="alert" className="text-danger">
                    {error}
                  </p>
                )}
              </div>
            </ModalPanel>
          </div>
        </ModalOverlay>
      )}
    </PageShell>
  )
}
