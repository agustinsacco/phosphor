import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostLaneView } from '@shared/ipc'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import {
  hostOrbit,
  orbitPoint,
  orbitStateText,
  orbitStep,
  orbitSummary,
  orbitTone,
  type OrbitCounts,
} from './orbitLanes'

const NOW = Date.parse('2026-11-25T12:00:00.000Z')
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()

function lane(over: Partial<HostLaneView> = {}): HostLaneView {
  return {
    ...structuredClone(mockRemoteHosts[MOCK_HOST_ID]!.lanes[0]!),
    attention: 0,
    read: 0,
    updatedAt: ago(5),
    ...over,
  }
}
const counts = (over: Partial<OrbitCounts>): OrbitCounts => ({
  'needs-you': 0,
  working: 0,
  unread: 0,
  live: 0,
  idle: 0,
  ...over,
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

describe('orbitTone', () => {
  it('asks for you on a question or a failure, then names work, unread and live lanes', () => {
    expect(orbitTone(lane({ activity: 'needs-input' }), true)).toBe('needs-you')
    expect(orbitTone(lane({ activity: 'failed' }), true)).toBe('needs-you')
    expect(orbitTone(lane({ activity: 'working', attention: 2 }), true)).toBe('working')
    expect(orbitTone(lane({ activity: 'idle', attention: 1 }), true)).toBe('unread')
    expect(orbitTone(lane({ activity: 'idle' }), true)).toBe('live')
    expect(orbitTone(lane({ activity: 'stopped' }), true)).toBe('idle')
  })

  it('reads a Host that is not ready as history: nothing in flight or waiting', () => {
    expect(orbitTone(lane({ activity: 'working' }), false)).toBe('idle')
    expect(orbitTone(lane({ activity: 'needs-input' }), false)).toBe('idle')
    expect(orbitTone(lane({ activity: 'idle', attention: 1 }), false)).toBe('unread')
  })
})

describe('hostOrbit', () => {
  it('runs from what needs you to what is quiet, newest first within each, and counts all', () => {
    const lanes = [
      lane({ laneId: 'old-idle', activity: 'stopped', updatedAt: ago(500) }),
      lane({ laneId: 'working', activity: 'working', updatedAt: ago(1) }),
      lane({ laneId: 'new-idle', activity: 'stopped', updatedAt: ago(10) }),
      lane({ laneId: 'asks', activity: 'needs-input', updatedAt: ago(300) }),
      lane({ laneId: 'unread', activity: 'idle', attention: 1, updatedAt: ago(2) }),
    ]
    const orbit = hostOrbit(lanes, true)
    expect(orbit.shown.map((e) => e.lane.laneId)).toEqual([
      'asks',
      'working',
      'unread',
      'new-idle',
      'old-idle',
    ])
    expect(orbit.counts).toEqual(counts({ 'needs-you': 1, working: 1, unread: 1, idle: 2 }))
    expect(orbit.total).toBe(5)
  })

  it('drops the oldest quiet lanes past the limit but still counts them', () => {
    const lanes = [
      lane({ laneId: 'old', activity: 'stopped', updatedAt: ago(90) }),
      lane({ laneId: 'asks', activity: 'failed', updatedAt: ago(60) }),
      lane({ laneId: 'new', activity: 'stopped', updatedAt: ago(30) }),
    ]
    const orbit = hostOrbit(lanes, true, 2)
    expect(orbit.shown.map((e) => e.lane.laneId)).toEqual(['asks', 'new'])
    expect(orbit.total).toBe(3)
  })
})

describe('orbitSummary', () => {
  it('leads with what needs you and keeps work and the total in the detail', () => {
    expect(orbitSummary(counts({ 'needs-you': 2, working: 3, idle: 4 }), 9)).toEqual({
      count: 2,
      label: 'need you',
      tone: 'needs-you',
      detail: '3 working · 9 lanes',
    })
    expect(orbitSummary(counts({ 'needs-you': 1 }), 1)).toMatchObject({
      label: 'needs you',
      detail: '1 lane',
    })
  })

  it('falls back to work, then unread, then quiet, then an empty Host', () => {
    expect(orbitSummary(counts({ working: 2, unread: 1 }), 5)).toEqual({
      count: 2,
      label: 'working',
      tone: 'working',
      detail: '1 unread · 5 lanes',
    })
    expect(orbitSummary(counts({ unread: 3 }), 4)).toMatchObject({ count: 3, label: 'unread' })
    expect(orbitSummary(counts({ idle: 4 }), 4)).toEqual({ label: 'All quiet', detail: '4 lanes' })
    expect(orbitSummary(counts({}), 0)).toEqual({
      label: 'No lanes yet',
      detail: 'Describe a task below.',
    })
  })
})

it('describes a lane in one line, with its age once nothing is happening', () => {
  const text = (over: Partial<HostLaneView>) => {
    const view = lane(over)
    return orbitStateText({ lane: view, tone: orbitTone(view, true) })
  }
  expect(text({ activity: 'failed' })).toBe('Failed · needs you')
  expect(text({ activity: 'needs-input' })).toBe('Needs you')
  expect(text({ activity: 'working' })).toBe('Working')
  expect(text({ activity: 'idle', attention: 1, updatedAt: ago(120) })).toBe(
    'New activity · 2h ago',
  )
  expect(text({ activity: 'idle', updatedAt: ago(5) })).toBe('Live · 5m ago')
  expect(text({ activity: 'stopped', updatedAt: ago(5) })).toBe('5m ago')
})

it('places dots clockwise from twelve o’clock on the ring', () => {
  expect(orbitPoint(0, 4)).toEqual({ x: 50, y: 10 })
  expect(orbitPoint(1, 4)).toEqual({ x: 90, y: 50 })
  expect(orbitPoint(2, 4)).toEqual({ x: 50, y: 90 })
  expect(orbitPoint(0, 0)).toEqual({ x: 50, y: 10 })
})

it('walks the ring with arrows, wrapping, and jumps with Home and End', () => {
  expect(orbitStep('ArrowRight', 2, 3)).toBe(0)
  expect(orbitStep('ArrowDown', 0, 3)).toBe(1)
  expect(orbitStep('ArrowLeft', 0, 3)).toBe(2)
  expect(orbitStep('ArrowUp', 2, 3)).toBe(1)
  expect(orbitStep('Home', 2, 3)).toBe(0)
  expect(orbitStep('End', 0, 3)).toBe(2)
  expect(orbitStep('Enter', 0, 3)).toBeNull()
  expect(orbitStep('ArrowRight', 0, 0)).toBeNull()
})
