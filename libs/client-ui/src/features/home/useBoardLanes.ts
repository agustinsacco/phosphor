import { useMemo } from 'react'
import { localMachineLabel } from '@/lib/localMachine'
import { projectName } from '@/lib/path'
import { useLocalLanes } from '@/features/machines/LocalLanePreview'
import { useLocalTasks } from '@/features/machines/MachineTasks'
import { machineCaps } from '@/stores/machineCaps'
import { useMachinesStore } from '@/stores/machines'
import { hostReconnecting, useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { hostLaneUrgency, laneTime, type BoardLane } from './homeBoard'

/**
 * Every lane this client can see: This Mac's (none in a browser) and each Host's. A Host
 * that is retrying keeps its last-known lanes listed, as the sidebar does; one that cannot
 * be read lists nothing.
 */
export function useBoardLanes(): BoardLane[] {
  const machines = useMachinesStore((s) => s.machines)
  const hosts = useRemoteLanesStore((s) => s.hosts)
  const local = useLocalLanes()
  const tasks = useLocalTasks()
  const gitByCwd = useSessionsStore((s) => s.gitByCwd)
  return useMemo(() => {
    const localName = localMachineLabel()
    const asking = new Map(
      tasks.map((task) => ['sessionId' in task.lane ? task.lane.sessionId : '', task.state]),
    )
    const localLanes: BoardLane[] = local.map((lane) => {
      const state = lane.phosphorId ? asking.get(lane.phosphorId) : undefined
      return {
        kind: 'local',
        key: `local:${lane.key}`,
        lane,
        where: `${localName} · ${projectName(lane.workspacePath, gitByCwd[lane.workspacePath])}`,
        // A live lane without a file yet is the newest thing there is.
        updatedAt: lane.meta ? laneTime(lane.meta.lastActivityAt) || lane.meta.mtimeMs : Date.now(),
        urgency: state === 'needs-input' ? 'needs-you' : state === 'working' ? 'working' : 'idle',
      }
    })
    const hostLanes = machines.flatMap((machine): BoardLane[] => {
      const host = hosts[machine.id]
      const caps = machineCaps(host)
      if (!host || !caps.granted('sessions.read') || !(caps.ready || hostReconnecting(host.state)))
        return []
      const folders = new Map(host.repositories.map((repo) => [repo.id, repo.name]))
      return host.lanes.map((lane) => ({
        kind: 'host',
        key: `${machine.id}:${lane.laneId}`,
        hostId: machine.id,
        lane,
        ready: caps.ready,
        where: [machine.label, folders.get(lane.repositoryId)].filter(Boolean).join(' · '),
        updatedAt: laneTime(lane.updatedAt),
        urgency: hostLaneUrgency(lane, caps.ready),
      }))
    })
    return [...localLanes, ...hostLanes]
  }, [machines, hosts, local, tasks, gitByCwd])
}
