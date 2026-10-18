import { usePlatform } from '@/platform/Platform'
import { useEffect, useRef, useState } from 'react'
import type { MachineView } from '@shared/control-api'
import { PageShell } from '@/components/PageShell'
import { PaneTitle } from '@/components/PaneShell'
import { Button } from '@/components/form'
import { TerminalIcon } from '@/components/icons'
import { TooltipButton, tooltipProps } from '@/components/Tooltip'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { useAccount } from '@/features/settings/useAccount'
import { machinesAccountGeneration, useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { AddMachineDialog } from './AddMachineDialog'
import { controlMessage } from './controlMessages'
import { HealthBadge } from './HealthBadge'
import { LocalMachineDetail, useThisComputer } from './LocalMachine'
import { HostGuide, HostSetup } from './MachineControls'
import { MachineDetail } from './MachineDetail'
import { MachineList } from './MachineList'
import { machineHeadline } from './machineReachability'
import { LOCAL_MACHINE } from './machinePresentation'
import { TrafficLogPanel } from './TrafficLogPanel'

/** One line under the title that says how the fleet is doing, in words. */
function fleetSummary(
  machines: readonly MachineView[],
  hosts: ReturnType<typeof useRemoteLanesStore.getState>['hosts'],
  now: number,
): string {
  if (!machines.length) return 'This computer, and any Hosts you add to your account.'
  const tones = machines.map((m) => machineHeadline(m, hosts[m.id], now).tone)
  const connected = tones.filter((t) => t === 'ok').length
  const attention = tones.filter((t) => t === 'warn' || t === 'error').length
  const offline = tones.filter((t) => t === 'off').length
  return [
    `${machines.length} ${machines.length === 1 ? 'Host' : 'Hosts'}`,
    `${connected} connected`,
    attention ? `${attention} ${attention === 1 ? 'needs' : 'need'} attention` : null,
    offline ? `${offline} offline` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

export function MachinesPage(): React.JSX.Element {
  const platform = usePlatform()
  const { view: account, error: accountError } = useAccount()
  const signedIn = account?.account.status === 'signed-in'
  const state = useMachinesStore()
  const computer = useThisComputer()
  const hosts = useRemoteLanesStore((s) => s.hosts)
  useEffect(() => () => useMachinesStore.setState({ adding: false }), [])
  const adding = state.adding
  const setAdding = (adding: boolean): void => useMachinesStore.setState({ adding })
  const [logOpen, setLogOpen] = useState(false)
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
    <PageShell
      title={<PaneTitle label="Machines" />}
      actions={
        <div className="flex items-center gap-1">
          {platform.localLanes && (
            <HealthBadge signedIn={signedIn} onOpenLog={() => setLogOpen(true)} />
          )}
          <TooltipButton
            tooltip={logOpen ? 'Hide debug log' : 'Show debug log'}
            aria-label="Debug log"
            aria-pressed={logOpen}
            onClick={() => setLogOpen((open) => !open)}
            className={`hover:bg-bg-secondary flex h-8 w-8 items-center justify-center rounded-sm transition-colors ${logOpen ? 'text-accent' : 'text-text-secondary hover:text-text'}`}
          >
            <TerminalIcon size={14} />
          </TooltipButton>
        </div>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div data-testid="machines-page" className="min-h-0 flex-1 overflow-y-auto px-6 pb-10 pt-5">
          <div className="mx-auto max-w-4xl space-y-5">
            {selected ? (
              <TooltipButton
                tooltip="Back to all machines"
                className="text-text-secondary hover:text-text -mb-2 text-base"
                onClick={back}
              >
                ← Machines
              </TooltipButton>
            ) : (
              <header className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <h1 className="text-3xl font-semibold">Machines</h1>
                  <p className="text-text-secondary mt-1.5 text-lg">
                    {signedIn
                      ? !platform.localLanes && !state.machines.length
                        ? 'Your enrolled Hosts appear here.'
                        : fleetSummary(state.machines, hosts, now + state.clockOffsetMs)
                      : 'This computer. Sign in to add Hosts.'}
                  </p>
                </div>
                <span
                  {...tooltipProps(signedIn ? undefined : 'Sign in with GitHub to add machines')}
                >
                  <Button variant="primary" disabled={!signedIn} onClick={() => setAdding(true)}>
                    Add a machine
                  </Button>
                </span>
              </header>
            )}
            {notice && (
              <p role="status" className="text-success text-base">
                {notice}
              </p>
            )}
            {(accountError || state.error || (error && !removing)) && (
              <div
                role="alert"
                className="border-border bg-bg-secondary flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3 text-base"
              >
                <span className="min-w-0 flex-1">
                  {accountError ?? error ?? controlMessage(state.error ?? 'offline')}
                </span>
                <Button size="xs" disabled={state.loading} onClick={() => void state.refresh()}>
                  {state.loading ? 'Retrying…' : 'Retry'}
                </Button>
              </div>
            )}
            {!selected ? (
              <MachineList
                computer={computer}
                signedIn={signedIn}
                machines={signedIn ? state.machines : []}
                loading={state.loading}
                now={now}
                offset={state.clockOffsetMs}
                onOpen={(id) => {
                  setError(null)
                  state.show({ kind: 'machine', id })
                }}
                empty={
                  !signedIn ? (
                    <div className="border-border rounded-lg border p-5">
                      <h2 className="text-lg font-medium">
                        Sign in with GitHub to add other machines
                      </h2>
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
                  ) : state.error ? null : (
                    <section className="border-border rounded-lg border p-5">
                      <h2 className="mb-1 text-xl font-semibold">Bring another machine online</h2>
                      <p className="text-text-secondary mb-4 text-base">
                        Run one command on the other machine, then approve its code here.
                      </p>
                      <HostSetup collapsed />
                      <div className="mt-4 flex items-center gap-4">
                        <Button onClick={() => setAdding(true)}>Add a machine</Button>
                        <HostGuide />
                      </div>
                    </section>
                  )
                }
              />
            ) : local ? (
              <LocalMachineDetail computer={computer} />
            ) : machine && signedIn ? (
              <MachineDetail
                machine={machine}
                now={now}
                offset={state.clockOffsetMs}
                onRemove={() => {
                  setError(null)
                  setRemoving(machine)
                }}
              />
            ) : (
              <div className="border-border flex items-center gap-3 rounded-lg border p-5 text-base">
                <span className="flex-1">
                  {signedIn
                    ? state.loading
                      ? 'Loading this machine…'
                      : 'This machine is no longer in your account.'
                    : 'Sign in again to see this machine.'}
                </span>
                <Button onClick={back}>All machines</Button>
              </div>
            )}
          </div>
        </div>
        {logOpen && <TrafficLogPanel onClose={() => setLogOpen(false)} />}
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
