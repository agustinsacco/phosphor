import { expect, it } from 'vitest'
import type { HostLaneView } from '@shared/ipc'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { homeSections, hostLaneUrgency, laneTime, type BoardLane } from './homeBoard'

const base = mockRemoteHosts[MOCK_HOST_ID]!.lanes[0]!
const lane = (activity: HostLaneView['activity']): HostLaneView => ({ ...base, activity })
const entry = (key: string, urgency: BoardLane['urgency'], updatedAt: number): BoardLane => ({
  kind: 'host',
  key,
  hostId: MOCK_HOST_ID,
  lane: base,
  ready: true,
  where: 'Host',
  updatedAt,
  urgency,
})

it('a question or a failure needs you; a running turn is working; the rest is idle', () => {
  expect(hostLaneUrgency(lane('needs-input'), true)).toBe('needs-you')
  expect(hostLaneUrgency(lane('failed'), true)).toBe('needs-you')
  expect(hostLaneUrgency(lane('working'), true)).toBe('working')
  expect(hostLaneUrgency(lane('idle'), true)).toBe('idle')
  expect(hostLaneUrgency(lane('stopped'), true)).toBe('idle')
})

it('a Host that is not ready reports nothing in flight: its activity is history', () => {
  expect(hostLaneUrgency(lane('needs-input'), false)).toBe('idle')
  expect(hostLaneUrgency(lane('working'), false)).toBe('idle')
})

it('sorts each section newest first and caps Recent, never what needs you', () => {
  const lanes = [
    entry('old-ask', 'needs-you', 1),
    entry('new-ask', 'needs-you', 9),
    entry('run', 'working', 5),
    ...Array.from({ length: 12 }, (_, i) => entry(`idle-${i}`, 'idle', i)),
  ]
  const sections = homeSections(lanes, 3)
  expect(sections.needsYou.map((l) => l.key)).toEqual(['new-ask', 'old-ask'])
  expect(sections.working.map((l) => l.key)).toEqual(['run'])
  expect(sections.recent.map((l) => l.key)).toEqual(['idle-11', 'idle-10', 'idle-9'])
})

it('an unknown or malformed time sorts last', () => {
  expect(laneTime(undefined)).toBe(0)
  expect(laneTime('not a date')).toBe(0)
  expect(laneTime('1970-01-01T00:00:01.000Z')).toBe(1000)
})
