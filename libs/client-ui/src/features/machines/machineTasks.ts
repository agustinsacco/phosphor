import type { HostConnectionView, HostLaneView } from '@shared/ipc'
import type { LaneKey } from '@/navigation/location'
import { remoteLaneTitle } from '@/features/sessions/remoteLaneView'

/** A lane with work in flight: a turn running, or a question waiting on you. */
export interface MachineTask {
  key: string
  title: string
  branch?: string
  state: 'working' | 'needs-input'
  lane: LaneKey
}

/** Questions first, since they wait on you; then the order the source listed them in. */
export function orderTasks(tasks: MachineTask[]): MachineTask[] {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort(
      (a, b) =>
        Number(b.task.state === 'needs-input') - Number(a.task.state === 'needs-input') ||
        a.index - b.index,
    )
    .map(({ task }) => task)
}

function active(lane: HostLaneView): lane is HostLaneView & { activity: MachineTask['state'] } {
  return lane.activity === 'working' || lane.activity === 'needs-input'
}

/**
 * A Host's running lanes, from its live snapshot. A Host that is not ready
 * reports nothing: its last-known activity is history, not work in flight.
 * (Heartbeats carry no lane activity; the control plane never sees lanes.)
 */
export function hostTasks(hostId: string, host: HostConnectionView | undefined): MachineTask[] {
  if (host?.state !== 'ready' || !host.capabilities.includes('sessions.read')) return []
  return orderTasks(
    host.lanes.filter(active).map((lane) => ({
      key: lane.laneId,
      title: remoteLaneTitle(undefined, lane.title),
      ...(lane.branch ? { branch: lane.branch } : {}),
      state: lane.activity,
      lane: { hostId, laneId: lane.laneId },
    })),
  )
}

/** "2 running · 1 needs you", or null when nothing is in flight. */
export function taskCounts(tasks: readonly MachineTask[]): string | null {
  const running = tasks.filter((task) => task.state === 'working').length
  const asking = tasks.length - running
  return (
    [running && `${running} running`, asking && `${asking} ${asking === 1 ? 'needs' : 'need'} you`]
      .filter(Boolean)
      .join(' · ') || null
  )
}
