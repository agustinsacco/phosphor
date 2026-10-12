import { TooltipButton } from '@/components/Tooltip'
import clsx from 'clsx'
import { useLayoutStore } from '@/stores/layout'
import { useMachinesStore } from '@/stores/machines'
import {
  FAKE_MACHINES,
  LANE_STATE_LABEL,
  LOCAL_MACHINE,
  localMachineName,
  machineById,
  type RemoteLane,
} from './fakeMachines'

/**
 * The Machines preview's sidebar parts: a filter by machine, a machine chip on
 * every lane, and rows for lanes on other machines. Rendered by Sidebar.tsx
 * only while the preview is on.
 */

export function MachineFilterBar(): React.JSX.Element {
  const filter = useMachinesStore((s) => s.filter)
  const options = [
    { id: 'all', label: 'All' },
    { id: LOCAL_MACHINE, label: localMachineName(window.phosphor.platform).long, up: true },
    ...FAKE_MACHINES.map((machine) => ({ id: machine.id, label: machine.name, up: machine.up })),
  ]
  return (
    <div
      role="group"
      aria-label="Show lanes on"
      data-testid="machine-filter"
      className="flex flex-wrap gap-1 px-1 pb-1 pt-1.5"
    >
      {options.map((option) => (
        <TooltipButton
          key={option.id}
          aria-pressed={filter === option.id}
          title={option.up === undefined ? undefined : option.up ? 'Up' : 'Down'}
          onClick={() => useMachinesStore.getState().setFilter(option.id)}
          className={clsx(
            'flex items-center gap-1 rounded-md px-1.5 py-0.5 text-sm transition-colors',
            filter === option.id
              ? 'bg-sidebar-active text-text'
              : 'text-text-secondary hover:text-text hover:bg-sidebar-hover',
          )}
        >
          {option.up !== undefined && <MachineDot up={option.up} />}
          {option.label}
        </TooltipButton>
      ))}
    </div>
  )
}

/** Up or down. Decorative: every place that shows it also says it in words or a tooltip. */
export function MachineDot({ up }: { up: boolean }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={clsx(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        up ? 'bg-success' : 'border-border-strong border',
      )}
      data-tooltip={up ? 'Up' : 'Down'}
    />
  )
}

/** Where a lane runs, at the end of its row. */
export function MachineChip({ label }: { label: string }): React.JSX.Element {
  return (
    <span
      data-testid="lane-machine"
      className="bg-chip text-text-secondary shrink-0 rounded px-1.5 py-px text-2xs font-medium"
    >
      {label}
    </span>
  )
}

/**
 * A lane on another machine. A down machine's lanes stay listed, greyed, as
 * it last reported them; the real thing keeps that list in Desktop's own
 * cache, never on the server.
 */
export function RemoteLaneRow({ lane }: { lane: RemoteLane }): React.JSX.Element {
  const machine = machineById(lane.machineId)
  const down = machine?.up !== true
  const active = useLayoutStore((s) => s.page === 'machines')
  const viewing = useMachinesStore((s) => s.view.kind === 'lane' && s.view.id === lane.id)
  const name = machine?.name ?? lane.machineId
  return (
    <TooltipButton
      data-testid="remote-lane-row"
      tooltip={
        down
          ? { label: lane.title, description: `${name} is down · last reported state` }
          : lane.title
      }
      data-machine={lane.machineId}
      data-state={lane.state}
      onClick={() => useMachinesStore.getState().show({ kind: 'lane', id: lane.id })}
      className={clsx(
        'lane-row group flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left transition-colors',
        active && viewing ? 'bg-sidebar-active' : 'hover:bg-sidebar-hover',
        down && 'opacity-55',
      )}
    >
      <LaneStateDot lane={lane} />
      <span className="min-w-0 flex-1">
        <span className="text-text block truncate text-lg font-medium leading-5">{lane.title}</span>
        <span className="text-text-secondary flex items-center gap-1 text-base leading-4">
          <span className="shrink-0">{LANE_STATE_LABEL[lane.state]}</span>
          <span className="shrink-0">·</span>
          <span className="min-w-0 truncate">⎇ {lane.branch}</span>
          {lane.pr !== undefined && <span className="shrink-0">· #{lane.pr}</span>}
        </span>
      </span>
      <MachineChip label={down ? `${name} · down` : name} />
    </TooltipButton>
  )
}

function LaneStateDot({ lane }: { lane: RemoteLane }): React.JSX.Element {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center">
      <span
        className={clsx(
          'h-2 w-2 rounded-full',
          lane.state === 'running' && 'bg-success animate-pulse',
          lane.state === 'waiting' && 'bg-warning',
          lane.state === 'done' && 'bg-success',
          lane.state === 'idle' && 'border-border-strong border',
        )}
      />
    </span>
  )
}

/** A project that has lanes only on other machines. */
export function RemoteProjectGroup({
  name,
  lanes,
}: {
  name: string
  lanes: RemoteLane[]
}): React.JSX.Element {
  const machines = [...new Set(lanes.map((lane) => machineById(lane.machineId)?.name))]
  return (
    <div data-testid="remote-project-group">
      <div className="flex items-center gap-1.5 pb-0.5 pl-2 pr-1 pt-2.5">
        <span className="text-text-secondary min-w-0 truncate text-sm font-semibold font-mono uppercase tracking-wider">
          {name}
        </span>
        <span className="text-text-tertiary shrink-0 text-xs">on {machines.join(', ')}</span>
      </div>
      {lanes.map((lane) => (
        <RemoteLaneRow key={lane.id} lane={lane} />
      ))}
    </div>
  )
}
