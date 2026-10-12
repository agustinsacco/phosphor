import { useEffect, useState } from 'react'
import clsx from 'clsx'
import type { ClaudeStatus, PiHealth, SubscriptionProviderStatus } from '@shared/models'
import { PageShell } from '@/components/PageShell'
import { PaneTitle } from '@/components/PaneShell'
import { Button } from '@/components/form'
import { StatTile } from '@/components/StatTile'
import { AccountsTab } from '@/features/settings/tabs/AccountsTab'
import { useMachinesStore, type MachineTab } from '@/stores/machines'
import { useSessionsStore } from '@/stores/sessions'
import {
  FAKE_MACHINES,
  LANE_STATE_LABEL,
  LOCAL_MACHINE,
  isLive,
  localMachineName,
  machineById,
  machineStatus,
  nextToFinish,
  ago,
  type FakeDependency,
  type FakeMachine,
} from './fakeMachines'
import { useAccount } from '@/features/settings/useAccount'
import { EnrolledMachines } from './EnrolledMachines'
import { MachineChip, MachineDot, RemoteLaneRow } from './MachineSidebar'

/** Why a made-up machine's buttons do nothing yet. */
const NOT_YET = 'Preview: this needs Phosphor to reach the Host (component 21)'

/**
 * The Machines preview's page: every machine, one machine's page, or a lane on
 * another machine. Signed in, the list is enrolled machines; signed out,
 * this computer's rows are real and bee1 and bee2 are samples.
 */
export function MachinesPage(): React.JSX.Element {
  const { view: account } = useAccount()
  const signedIn = account?.preview === true && account.account.status === 'signed-in'
  const view = useMachinesStore((s) => s.view)
  const canFinish = useMachinesStore((s) => nextToFinish(s.lanes) !== undefined)
  const show = useMachinesStore((s) => s.show)
  return (
    <PageShell
      title={<PaneTitle label="Machines" meta="preview" />}
      actions={
        !signedIn && (
          <Button
            size="xs"
            disabled={!canFinish}
            onClick={() => useMachinesStore.getState().pretendFinished()}
            title="Sends the notice a real lane sends when it finishes"
          >
            Pretend a lane finishes
          </Button>
        )
      }
    >
      <div
        data-testid="machines-page"
        className="mx-auto w-full max-w-4xl flex-1 overflow-y-auto px-5 pb-8"
      >
        {signedIn ? (
          <EnrolledMachines />
        ) : (
          <>
            <p className="border-border bg-surface text-text-secondary mb-4 rounded-lg border px-3 py-2 text-sm">
              Sample machines. Sign in under Settings → Advanced → Phosphor account to see yours.
              bee1 and bee2 are not real. {localMachineName(window.phosphor.platform).long} is real.
            </p>
            {view.kind !== 'list' && (
              <button
                onClick={() => show({ kind: 'list' })}
                className="text-text-secondary hover:text-text mb-3 text-sm"
              >
                ← All machines
              </button>
            )}
            {view.kind === 'list' && <MachineList />}
            {view.kind === 'machine' && <MachineDetail id={view.id} tab={view.tab} />}
            {view.kind === 'lane' && <RemoteLaneView id={view.id} />}
          </>
        )}
      </div>
    </PageShell>
  )
}

interface ThisComputer {
  health: PiHealth | null
  providers: SubscriptionProviderStatus[] | null
  claude: ClaudeStatus | null
  claudeCli: string | null
}

/** This computer's real state, read once per mount over the IPC Settings uses. */
function useThisComputer(): ThisComputer {
  const [state, setState] = useState<ThisComputer>({
    health: null,
    providers: null,
    claude: null,
    claudeCli: null,
  })
  useEffect(() => {
    let stale = false
    const merge = (patch: Partial<ThisComputer>): void => {
      if (!stale) setState((current) => ({ ...current, ...patch }))
    }
    void window.phosphor.invoke('pi:health').then((health) => merge({ health }))
    void window.phosphor.invoke('pi:subscriptionAuth').then((providers) => merge({ providers }))
    void window.phosphor.invoke('packages:claudeStatus').then((claude) => merge({ claude }))
    void window.phosphor.invoke('packages:list').then((packages) =>
      merge({
        claudeCli:
          packages.find((entry) => entry.name === '@saccolabs/pi-claude-cli')?.version ?? null,
      }),
    )
    return () => {
      stale = true
    }
  }, [])
  return state
}

function signedInNames(computer: ThisComputer): string[] {
  const names = (computer.providers ?? []).filter((p) => p.status === 'ready').map((p) => p.name)
  if (computer.claude?.auth.loggedIn) names.push('Claude Code')
  return names
}

function MachineList(): React.JSX.Element {
  const computer = useThisComputer()
  const liveHere = useSessionsStore((s) => Object.keys(s.live).length)
  const lanes = useMachinesStore((s) => s.lanes)
  const show = useMachinesStore((s) => s.show)
  const local = localMachineName(window.phosphor.platform).long
  const loginsHere = signedInNames(computer)
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-xl font-semibold">Machines</h2>
        <Button size="xs" disabled title="Preview: adding a Host comes with enrollment (17)">
          + Add a Host
        </Button>
      </div>
      <div className="border-border divide-border divide-y rounded-lg border">
        <MachineListRow
          id={LOCAL_MACHINE}
          name={local}
          up
          summary={[
            `${liveHere} live`,
            computer.health?.version ? `pi ${computer.health.version}` : 'pi …',
            loginsHere.length ? loginsHere.map((name) => `${name} ✓`).join(' ') : 'no logins',
          ]}
          onOpen={() => show({ kind: 'machine', id: LOCAL_MACHINE, tab: 'overview' })}
        />
        {FAKE_MACHINES.map((machine) => (
          <MachineListRow
            key={machine.id}
            id={machine.id}
            name={machine.name}
            up={machine.up}
            summary={
              machine.up
                ? [
                    `${lanes.filter((l) => l.machineId === machine.id && isLive(l)).length} live`,
                    `pi ${machine.dependencies[0]?.version ?? '?'}`,
                    machine.logins.map((l) => `${l.name} ${l.signedIn ? '✓' : '✗'}`).join(' '),
                    ...(machine.hostUpdate ? ['Host update'] : []),
                  ]
                : [machineStatus(machine), `last seen v${machine.hostVersion}`]
            }
            onOpen={() => show({ kind: 'machine', id: machine.id, tab: 'overview' })}
          />
        ))}
      </div>
    </div>
  )
}

function MachineListRow({
  id,
  name,
  up,
  summary,
  onOpen,
}: {
  id: string
  name: string
  up: boolean
  summary: string[]
  onOpen: () => void
}): React.JSX.Element {
  return (
    <button
      data-testid="machine-row"
      data-machine={id}
      onClick={onOpen}
      className="hover:bg-bg-secondary flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors"
    >
      <MachineDot up={up} />
      <span className="w-28 shrink-0 font-medium">{name}</span>
      <span
        className={clsx(
          'min-w-0 truncate text-sm',
          up ? 'text-text-secondary' : 'text-text-tertiary',
        )}
      >
        {summary.join(' · ')}
      </span>
    </button>
  )
}

const TABS: { id: MachineTab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'lanes', label: 'Lanes' },
  { id: 'dependencies', label: 'Dependencies' },
  { id: 'logins', label: 'Logins' },
]

function MachineDetail({ id, tab }: { id: string; tab: MachineTab }): React.JSX.Element {
  const machine = machineById(id)
  const show = useMachinesStore((s) => s.show)
  const local = id === LOCAL_MACHINE
  const name = local ? localMachineName(window.phosphor.platform).long : (machine?.name ?? id)
  return (
    <div data-testid="machine-detail" data-machine={id}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <MachineDot up={local || machine?.up === true} />
        <h2 className="text-xl font-semibold">{name}</h2>
        <span className="text-text-secondary text-sm">
          {local
            ? `this computer · ${window.phosphor.platform === 'darwin' ? 'macOS' : window.phosphor.platform}`
            : machine &&
              `${machineStatus(machine)} · ${machine.platform} · Host ${machine.hostVersion}`}
        </span>
        {machine?.hostUpdate && (
          <Button size="xs" disabled title={NOT_YET}>
            Update to {machine.hostUpdate}
          </Button>
        )}
      </div>
      <div role="tablist" className="border-border mb-4 flex gap-1 border-b">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => show({ kind: 'machine', id, tab: t.id })}
            className={clsx(
              '-mb-px border-b-2 px-2.5 py-1.5 text-base transition-colors',
              tab === t.id
                ? 'border-accent text-text'
                : 'text-text-secondary hover:text-text border-transparent',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {local ? (
        <ThisComputerTab tab={tab} />
      ) : (
        machine && <FakeMachineTab machine={machine} tab={tab} />
      )}
    </div>
  )
}

function ThisComputerTab({ tab }: { tab: MachineTab }): React.JSX.Element {
  const computer = useThisComputer()
  const liveHere = useSessionsStore((s) => Object.keys(s.live).length)
  if (tab === 'logins') return <AccountsTab />
  if (tab === 'lanes')
    return (
      <p className="text-text-secondary text-base">
        {liveHere} live. This computer&apos;s lanes are the sidebar rows tagged{' '}
        <MachineChip label={localMachineName(window.phosphor.platform).short} />.
      </p>
    )
  const dependencies: FakeDependency[] = [
    {
      name: 'pi',
      version: computer.health?.version ?? '',
      note: computer.health?.ok ? 'runs lanes' : (computer.health?.reason ?? 'checking…'),
      ok: computer.health?.ok === true,
    },
    {
      name: 'pi-claude-cli',
      version: computer.claudeCli ?? '',
      note: computer.claudeCli ? 'runs Claude lanes' : 'not installed: no Claude lanes',
      ok: computer.claudeCli !== null,
    },
    {
      name: 'Claude Code',
      version: computer.claude?.binary.version ?? '',
      note: computer.claude?.auth.loggedIn ? 'logged in' : 'not logged in',
      ok: computer.claude?.binary.found === true,
    },
  ]
  if (tab === 'dependencies')
    return (
      <DependencyTable dependencies={dependencies} note="Upgrades stay in Settings → Extensions." />
    )
  return (
    <div className="grid grid-cols-3 gap-3">
      <StatTile label="Lanes" value={`${liveHere} live`} />
      <StatTile label="pi" value={computer.health?.version ?? '…'} />
      <StatTile label="Logins" value={String(signedInNames(computer).length)} />
    </div>
  )
}

function FakeMachineTab({
  machine,
  tab,
}: {
  machine: FakeMachine
  tab: MachineTab
}): React.JSX.Element {
  // Select the stored array and filter here: a selector that returns a new
  // array on every read makes zustand re-render without end.
  const allLanes = useMachinesStore((s) => s.lanes)
  const lanes = allLanes.filter((lane) => lane.machineId === machine.id)
  if (tab === 'lanes')
    return (
      <div data-testid="machine-lanes">
        {lanes.map((lane) => (
          <RemoteLaneRow key={lane.id} lane={lane} />
        ))}
      </div>
    )
  if (tab === 'dependencies')
    return <DependencyTable dependencies={machine.dependencies} disabled />
  if (tab === 'logins')
    return (
      <div className="border-border divide-border divide-y rounded-lg border">
        {machine.logins.map((login) => (
          <div key={login.name} className="flex items-center gap-3 px-3 py-2">
            <span className="flex-1 font-medium">{login.name}</span>
            <span
              className={login.signedIn ? 'text-success text-sm' : 'text-text-tertiary text-sm'}
            >
              {login.signedIn ? 'signed in' : 'not signed in'}
            </span>
            <Button size="xs" disabled title={NOT_YET}>
              {login.signedIn ? 'Sign out' : 'Sign in'}
            </Button>
          </div>
        ))}
        <p className="text-text-tertiary px-3 py-2 text-sm">
          On a real Host, Sign in runs that provider&apos;s own login there, as{' '}
          <code>phosphor providers login</code> does today. The credential stays on the Host.
        </p>
      </div>
    )
  return (
    <div className="grid grid-cols-3 gap-3">
      <StatTile label="Lanes" value={`${lanes.filter(isLive).length} live`} />
      <StatTile label="Status" value={machine.up ? 'up' : `down ${ago(machine.seenMinutesAgo)}`} />
      <StatTile label="Logins" value={String(machine.logins.filter((l) => l.signedIn).length)} />
    </div>
  )
}

function DependencyTable({
  dependencies,
  disabled = false,
  note,
}: {
  dependencies: FakeDependency[]
  disabled?: boolean
  note?: string
}): React.JSX.Element {
  return (
    <div
      className="border-border divide-border divide-y rounded-lg border"
      data-testid="dependencies"
    >
      {dependencies.map((dependency) => (
        <div key={dependency.name} className="flex items-center gap-3 px-3 py-2">
          <span className="w-32 shrink-0 font-medium">{dependency.name}</span>
          <span className="w-20 shrink-0 font-mono text-sm">{dependency.version || '-'}</span>
          <span
            className={clsx(
              'flex-1 text-sm',
              dependency.ok ? 'text-text-secondary' : 'text-warning',
            )}
          >
            {dependency.ok ? '✓' : '✗'} {dependency.note}
          </span>
          {disabled && dependency.upgrade && (
            <Button size="xs" disabled title={NOT_YET}>
              Upgrade to {dependency.upgrade}
            </Button>
          )}
        </div>
      ))}
      {note && <p className="text-text-tertiary px-3 py-2 text-sm">{note}</p>}
    </div>
  )
}

function RemoteLaneView({ id }: { id: string }): React.JSX.Element {
  const lane = useMachinesStore((s) => s.lanes.find((l) => l.id === id))
  const show = useMachinesStore((s) => s.show)
  if (!lane) return <p className="text-text-secondary">This lane is gone.</p>
  const machine = machineById(lane.machineId)
  const name = machine?.name ?? lane.machineId
  return (
    <div data-testid="remote-lane-view" className="border-border rounded-lg border p-4">
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-xl font-semibold">{lane.title}</h2>
        <MachineChip label={machine?.up ? name : `${name} · down`} />
      </div>
      <p className="text-text-secondary mb-3 text-sm">
        {LANE_STATE_LABEL[lane.state]} · ⎇ {lane.branch}
        {lane.pr !== undefined && ` · PR #${lane.pr}`} · {lane.project} ·{' '}
        {lane.minutesAgo === 0 ? 'just now' : `${ago(lane.minutesAgo)} ago`}
      </p>
      <p className="mb-4 text-base">
        {machine?.up
          ? `This lane runs on ${name}. Once Phosphor can reach a Host (component 21), its chat opens here like a lane on this computer, streamed from ${name}.`
          : `${name} is down. This is what it last reported, ${ago(machine?.seenMinutesAgo ?? 0)} ago; the chat opens when it is back.`}
      </p>
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => show({ kind: 'machine', id: lane.machineId, tab: 'overview' })}
        >
          Open {name}
        </Button>
        <Button
          size="sm"
          disabled={!isLive(lane) || !machine?.up}
          onClick={() => useMachinesStore.getState().pretendFinished(lane.id)}
        >
          Pretend it finished
        </Button>
      </div>
    </div>
  )
}
