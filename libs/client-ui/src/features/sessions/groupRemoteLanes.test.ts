import { expect, it } from 'vitest'
import { groupRemoteLanes } from './groupRemoteLanes'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'

it('preserves repository and per-repository lane order without mutating the snapshot', () => {
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  const base = host.lanes[0]!
  host.repositories.push({ id: 'second', name: 'Another folder', path: '/second' })
  host.lanes = [
    { ...base, laneId: 'second-first', repositoryId: 'second' },
    { ...base, laneId: 'first-first' },
    { ...base, laneId: 'orphan-first', repositoryId: 'missing' },
    { ...base, laneId: 'first-second' },
    { ...base, laneId: 'orphan-second', repositoryId: 'missing' },
    { ...base, laneId: 'other-orphan', repositoryId: 'another-missing' },
  ]
  const original = structuredClone(host)
  const groups = groupRemoteLanes(host.repositories, host.lanes)
  expect(groups.map((group) => group.repositoryId)).toEqual([
    base.repositoryId,
    'second',
    'missing',
    'another-missing',
  ])
  expect(groups.map((group) => group.lanes.map((lane) => lane.laneId))).toEqual([
    ['first-first', 'first-second'],
    ['second-first'],
    ['orphan-first', 'orphan-second'],
    ['other-orphan'],
  ])
  expect(groups.map((group) => group.available)).toEqual([true, true, false, false])
  expect(groups.flatMap((group) => group.lanes)).toHaveLength(host.lanes.length)
  expect(host).toEqual(original)
})

it('puts the newest lane at the top of its repository, as Desktop does for sessions', () => {
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  const base = host.lanes[0]!
  // The Host lists lanes oldest first (`ORDER BY created_at`), and a lane
  // created during the session arrives as a delta appended at the end.
  host.lanes = [
    { ...base, laneId: 'oldest', createdAt: '2026-10-01T10:00:00.000Z' },
    { ...base, laneId: 'middle', createdAt: '2026-10-02T10:00:00.000Z' },
    { ...base, laneId: 'unparsable', createdAt: 'not a date' },
    { ...base, laneId: 'newest', createdAt: '2026-10-03T10:00:00.000Z' },
  ]
  const [group] = groupRemoteLanes(host.repositories, host.lanes)
  expect(group!.lanes.map((lane) => lane.laneId)).toEqual([
    'newest',
    'middle',
    'oldest',
    'unparsable',
  ])
  expect(host.lanes.map((lane) => lane.laneId)).toEqual([
    'oldest',
    'middle',
    'unparsable',
    'newest',
  ])
})

it('keeps empty known repositories and unknown lanes even when no active folders remain', () => {
  const host = mockRemoteHosts[MOCK_HOST_ID]!
  expect(groupRemoteLanes(host.repositories, [])[0]?.lanes).toEqual([])
  expect(groupRemoteLanes([], host.lanes)[0]).toMatchObject({
    name: `Unavailable folder (${host.lanes[0]!.repositoryId})`,
    available: false,
    lanes: host.lanes,
  })
  expect(groupRemoteLanes([], [])).toEqual([])
})
