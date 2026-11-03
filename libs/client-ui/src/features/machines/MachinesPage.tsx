import { usePlatform } from '@/platform/Platform'
import { useEffect, useRef, useState } from 'react'
import type { MachineView } from '@shared/control-api'
import { PageShell } from '@/components/PageShell'
import { PageBody } from '@/components/PageBody'
import './MachinesPage.css'
import { PaneTitle } from '@/components/PaneShell'
import { Button } from '@/components/form'
import { TooltipButton } from '@/components/Tooltip'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { useAccount } from '@/features/settings/useAccount'
import { machinesAccountGeneration, useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { AddMachineDialog } from './AddMachineDialog'
import { controlMessage } from './controlMessages'
import { MachinesPageActions } from './MachinesPageActions'
import { HostGuide, HostSetup } from './MachineControls'
import { HostMachineDetail, MachineDetail } from './MachineDetail'
import { MachineFilesButton } from './MachineFilesButton'
import { useOpenSettings } from '@/features/settings/useOpenSettings'
import { MachineList } from './MachineList'
import { machineHeadline } from './machineReachability'
import { useLocalOverview, type MachineOverview } from './machineOverview'
import { TrafficLogPanel } from './TrafficLogPanel'

/** This computer's part of the fleet summary: "This Mac ready". */
function localSummary({ label, headline }: MachineOverview): string {
  if (headline.tone === 'ok') return `${label} ready`
  return headline.tone === 'pending' ? `Checking ${label}…` : `${label} needs attention`
}

/** One line under the title that says how the fleet is doing, in words. */
function fleetSummary(
  local: MachineOverview | null,
  machines: readonly MachineView[],
  hosts: ReturnType<typeof useRemoteLanesStore.getState>['hosts'],
  now: number,
): string {
  const here = local && localSummary(local)
  if (!machines.length)
    return here
      ? `${here}. Hosts you add to your account appear here.`
      : 'Your enrolled Hosts appear here.'
  const tones = machines.map((m) => machineHeadline(m, hosts[m.id], now).tone)
  const connected = tones.filter((t) => t === 'ok').length
  const attention = tones.filter((t) => t === 'warn' || t === 'error').length
  const offline = tones.filter((t) => t === 'off').length
  return [
    here,
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
  const local = useLocalOverview()
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
  const now = state.nowMs || Date.now()
  const openSettings = useOpenSettings()
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
      title={
        selected ? (
          <TooltipButton aria-label="Back to machines" className="machine-page-back" onClick={back}>
            ← Machines
          </TooltipButton>
        ) : (
          <PaneTitle label="Machines" />
        )
      }
      actions={
        !selected && (
          <MachinesPageActions
            signedIn={signedIn}
            onAdd={() => setAdding(true)}
            logOpen={logOpen}
            onToggleLog={() => setLogOpen((open) => !open)}
            onOpenLog={() => setLogOpen(true)}
          />
        )
      }
    >
      <PageBody data-testid="machines-page" className="machines-page">
        <div className="space-y-4">
          {!selected && (
            <p className="text-text-secondary text-sm">
              {signedIn
                ? fleetSummary(local, state.machines, hosts, now + state.clockOffsetMs)
                : local
                  ? `${localSummary(local)}. Sign in to add Hosts.`
                  : 'Sign in to see your Hosts.'}
            </p>
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
              local={local}
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
                      {platform.localLanes
                        ? 'Sign-in is optional. Your local lanes stay on this computer.'
                        : 'This browser connects to your enrolled Hosts; it does not run local lanes.'}
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
          ) : local && selected === local.id ? (
            <MachineDetail overview={local} />
          ) : machine && signedIn ? (
            <HostMachineDetail
              key={machine.id}
              machine={machine}
              now={now}
              offset={state.clockOffsetMs}
              navigation={
                <nav aria-label="Machine views" className="border-border flex gap-5 border-b">
                  <TooltipButton
                    tooltip="Machine readiness and diagnostics"
                    aria-current="page"
                    className="machine-view-tab text-base"
                  >
                    Overview
                  </TooltipButton>
                  <TooltipButton
                    tooltip={`Configure ${machine.label} in Settings`}
                    aria-label="Machine settings"
                    className="machine-view-tab text-base"
                    onClick={() => openSettings(machine.id, 'accounts')}
                  >
                    Settings
                  </TooltipButton>
                  <MachineFilesButton machine={machine} />
                </nav>
              }
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
      </PageBody>
      {logOpen && <TrafficLogPanel onClose={() => setLogOpen(false)} />}
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
