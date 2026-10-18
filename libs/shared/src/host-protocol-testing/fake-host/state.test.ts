import { afterEach, describe, expect, it, vi } from 'vitest'
import { HOST_LIMITS } from '../../host-protocol'
import { createFakeHostState, now, resolveLimits, type FakeHostOptions } from './state'

function options(extra: Partial<FakeHostOptions> = {}): FakeHostOptions & { epochs: () => number } {
  let epochs = 0
  return {
    expectations: { iss: 'https://control.test', hostId: 'host', owner: 'owner', epoch: 1 },
    verify: () => true,
    sign: () => new Uint8Array(64),
    id: () => 'id',
    epoch: () => `epoch-${++epochs}`,
    epochs: () => epochs,
    ...extra,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('resolveLimits', () => {
  it('starts from the contract and accepts only lower positive safe integers', () => {
    expect(resolveLimits(undefined)).toEqual({ ...HOST_LIMITS })
    expect(resolveLimits(undefined)).not.toBe(HOST_LIMITS)
    const lowered = resolveLimits({ receiptsKept: 1, sendQueueBytes: HOST_LIMITS.sendQueueBytes })
    expect(lowered).toEqual({ ...HOST_LIMITS, receiptsKept: 1 })
    for (const value of [0, -1, 1.5, NaN, Infinity, HOST_LIMITS.receiptsKept + 1])
      expect(() => resolveLimits({ receiptsKept: value })).toThrow('Invalid limit')
  })

  it('ignores explicitly undefined entries', () => {
    expect(resolveLimits({ replayEvents: undefined })).toEqual({ ...HOST_LIMITS })
  })
})

describe('createFakeHostState', () => {
  it('initializes the epoch once, empty collections, zero counters and default capabilities', () => {
    const o = options()
    const state = createFakeHostState(o)
    expect(o.epochs()).toBe(1)
    expect(state).toMatchObject({
      options: o,
      epoch: 'epoch-1',
      hostSeq: 0,
      stopped: false,
      executions: 0,
      caps: ['sessions.read', 'sessions.control'],
      repositories: [{ id: '0123456789abcdef', name: 'Test repository', path: '/test/repository' }],
    })
    for (const empty of [state.connections, state.lanes, state.receipts, state.timers])
      expect(empty.size).toBe(0)
    expect([...state.revokedSessions, ...state.revokedClients, ...state.attention]).toEqual([])
  })

  it('gives every Host its own maps, sets and arrays', () => {
    const o = options()
    const one = createFakeHostState(o),
      two = createFakeHostState(o)
    for (const key of [
      'connections',
      'lanes',
      'receipts',
      'revokedSessions',
      'revokedClients',
      'attention',
      'timers',
      'limits',
    ] as const)
      expect(one[key]).not.toBe(two[key])
    one.revokedClients.add('client')
    one.attention.push({
      cursor: { epoch: one.epoch, seq: 1 },
      event: { id: 'a', laneId: 'l', kind: 'finished', attention: 1, at: now(), title: null },
    })
    expect([two.revokedClients.size, two.attention.length]).toEqual([0, 0])
    expect([one.epoch, two.epoch]).toEqual(['epoch-1', 'epoch-2'])
  })

  it('keeps injected capabilities and repositories as given', () => {
    const repositories = [{ id: 'fedcba9876543210', name: 'Other', path: '/other' }]
    const state = createFakeHostState(
      options({ capabilities: ['sessions.read'], repositories, limits: { replayEvents: 3 } }),
    )
    expect(state.caps).toEqual(['sessions.read'])
    expect(state.repositories).toBe(repositories)
    expect(state.limits.replayEvents).toBe(3)
  })

  it('refuses invalid limits or too many repositories before consuming an epoch', () => {
    const invalid = options({ limits: { lanesPerHost: 0 } })
    expect(() => createFakeHostState(invalid)).toThrow('Invalid limit')
    const repositories = [
      { id: '0123456789abcdef', name: 'One', path: '/one' },
      { id: 'fedcba9876543210', name: 'Two', path: '/two' },
    ]
    const crowded = options({ repositories, limits: { repositoriesPerHost: 1 } })
    expect(() => createFakeHostState(crowded)).toThrow('Too many repositories')
    expect([invalid.epochs(), crowded.epochs()]).toEqual([0, 0])
  })
})

it('stamps times from the current clock', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  expect(now()).toBe('2026-01-01T00:00:00.000Z')
})
