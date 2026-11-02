import { expect, it } from 'vitest'
import type { HostConnectionView, HostLaneView } from '@shared/ipc'
import { hostTasks, taskCounts } from './machineTasks'

const lane = (laneId: string, activity: HostLaneView['activity'], title: string | null = laneId) =>
  ({
    laneId,
    repositoryId: 'repo',
    cwd: '/w',
    title,
    branch: `agustin/${laneId}`,
    worktree: true,
    model: null,
    activity,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    attention: 0,
    read: 0,
    control: { fence: 0, controller: null },
  }) satisfies HostLaneView

const host = (
  lanes: HostLaneView[],
  state: HostConnectionView['state'] = 'ready',
): HostConnectionView => ({
  connectionToken: 't',
  state,
  capabilities: ['sessions.read'],
  repositories: [],
  lanes,
})

it('lists working and waiting lanes, questions first, and skips idle, stopped and failed', () => {
  const tasks = hostTasks(
    'h',
    host([
      lane('a', 'working'),
      lane('b', 'idle'),
      lane('c', 'needs-input'),
      lane('d', 'stopped'),
      lane('e', 'failed'),
      lane('f', 'working', null),
    ]),
  )
  expect(tasks.map((t) => [t.key, t.state])).toEqual([
    ['c', 'needs-input'],
    ['a', 'working'],
    ['f', 'working'],
  ])
  expect(tasks[0]).toMatchObject({ branch: 'agustin/c', lane: { hostId: 'h', laneId: 'c' } })
  expect(tasks[2]?.title).toBe('Untitled lane')
  expect(taskCounts(tasks)).toBe('2 running · 1 needs you')
})

it('reports nothing from a Host that is not ready or cannot read sessions', () => {
  expect(hostTasks('h', host([lane('a', 'working')], 'reconnecting'))).toEqual([])
  expect(hostTasks('h', { ...host([lane('a', 'working')]), capabilities: [] })).toEqual([])
  expect(hostTasks('h', undefined)).toEqual([])
  expect(taskCounts([])).toBeNull()
})
