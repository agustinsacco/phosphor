import { describe, expect, it } from 'vitest'
import { prKey } from '@shared/github-pr-refs'
import type { HostLaneView, HostsSnapshot } from '@shared/ipc'
import type { LanePrSignals } from '@shared/models'
import { MOCK_HOST_ID, mockRemoteHosts } from '@/dev/mockRemoteLanes'
import { prRef } from './__fixtures__/pullRequests'
import { prLaneIndex, type PrLaneFile, type PrLaneIndexInput } from './prLaneIndex'

const signals = (patch: Partial<LanePrSignals>): LanePrSignals => ({
  opened: [],
  branches: [],
  reviewing: [],
  mentioned: [],
  pinned: [],
  hidden: [],
  ...patch,
})
const meta = (path: string, patch: Partial<PrLaneFile>): PrLaneFile => ({
  path,
  cwd: '/repo',
  mtimeMs: 0,
  ...patch,
})
const input = (disk: PrLaneIndexInput['disk'], patch: Partial<PrLaneIndexInput> = {}) => ({
  disk,
  live: {},
  gitByCwd: {},
  byRepo: {},
  status: {},
  ...patch,
})

it('indexes the PRs a lane owns, never its suggestions', () => {
  const index = prLaneIndex(
    input({
      '/repo': [
        meta('/s/a.jsonl', {
          name: 'Refactor auth module',
          pullRequests: signals({
            opened: [prRef(57)],
            pinned: [prRef(70)],
            reviewing: [prRef(55)],
            mentioned: [prRef(61)],
          }),
        }),
      ],
    }),
  )
  expect([...index.keys()].sort()).toEqual([prKey(prRef(57)), prKey(prRef(70))].sort())
  expect(index.get(prKey(prRef(57)))).toMatchObject({
    path: '/s/a.jsonl',
    workspacePath: '/repo',
    title: 'Refactor auth module',
    sessionId: undefined,
  })
})

it('gives a shared PR to the lane touched last, named by its live name when running', () => {
  const opened = signals({ opened: [prRef(57)] })
  const index = prLaneIndex(
    input(
      {
        '/repo': [
          meta('/s/old.jsonl', { name: 'Old', mtimeMs: 1, pullRequests: opened }),
          meta('/s/new.jsonl', { name: 'Scanned', mtimeMs: 2, pullRequests: opened }),
        ],
      },
      {
        live: { p1: { phosphorId: 'p1', diskPath: '/s/new.jsonl' } },
        liveNames: new Map([['p1', 'Renamed']]),
      },
    ),
  )
  expect(index.get(prKey(prRef(57)))).toMatchObject({
    path: '/s/new.jsonl',
    title: 'Renamed',
    sessionId: 'p1',
  })
})

it('leaves out a PR the lane hid', () => {
  const index = prLaneIndex(
    input({
      '/repo': [
        meta('/s/a.jsonl', {
          pullRequests: signals({ opened: [prRef(57)], hidden: [prRef(57)] }),
        }),
      ],
    }),
  )
  expect(index.size).toBe(0)
})

describe('Host lanes', () => {
  const HOST = MOCK_HOST_ID
  function hosts(patch: Partial<HostLaneView>, prStatus = true): HostsSnapshot {
    const snapshot = structuredClone(mockRemoteHosts)
    const host = snapshot[HOST]!
    host.capabilities.push('workspaces.read')
    host.prStatus = prStatus
    host.lanes[0] = { ...host.lanes[0]!, ...patch }
    return snapshot
  }
  const laneId = mockRemoteHosts[HOST]!.lanes[0]!.laneId

  it('indexes the PRs a Host lane owns by Host and lane, never a path', () => {
    const index = prLaneIndex(
      input(
        {},
        {
          hosts: hosts({
            title: 'Host lane',
            pullRequests: signals({ opened: [prRef(57)], mentioned: [prRef(61)] }),
          }),
          live: { s1: { phosphorId: 's1', target: { kind: 'remote', hostId: HOST }, laneId } },
          liveNames: new Map([['s1', 'Renamed on the Host']]),
        },
      ),
    )
    expect([...index.keys()]).toEqual([prKey(prRef(57))])
    const owner = index.get(prKey(prRef(57)))!
    expect(owner).toMatchObject({
      hostId: HOST,
      laneId,
      title: 'Renamed on the Host',
      sessionId: 's1',
    })
    expect('path' in owner).toBe(false)
  })

  it('keeps only the checkout branch of a lane on a Host that folds no PRs', () => {
    const index = prLaneIndex(
      input({}, { hosts: hosts({ pullRequests: signals({ opened: [prRef(57)] }) }, false) }),
    )
    expect(index.size).toBe(0)
  })

  it('gives a PR a This Mac lane and a Host lane share to the one touched last', () => {
    const opened = signals({ opened: [prRef(57)] })
    const disk = {
      '/repo': [meta('/s/a.jsonl', { name: 'Mac lane', mtimeMs: 2_000, pullRequests: opened })],
    }
    const host = (updatedAt: string) =>
      prLaneIndex(input(disk, { hosts: hosts({ pullRequests: opened, updatedAt }) })).get(
        prKey(prRef(57)),
      )
    expect(host(new Date(1_000).toISOString())).toMatchObject({ path: '/s/a.jsonl' })
    expect(host(new Date(3_000).toISOString())).toMatchObject({ hostId: HOST, laneId })
  })
})
