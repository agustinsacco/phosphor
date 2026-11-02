import { afterEach, expect, it, vi } from 'vitest'
import { createRequests } from './requests'

afterEach(() => vi.useRealTimers())
it('retries backpressure with browser timers even without an unref port', () => {
  vi.useFakeTimers()
  const write = vi.fn(() => false)
  const requests = createRequests({
    now: Date.now,
    write,
    later: setTimeout,
    canReplay: () => true,
    changed: () => {},
    transportFailed: () => {},
  })
  requests.track({ type: 'command', requestId: 'request', op: { type: 'abort' } }, () => {})
  requests.prepareReplay()
  requests.flushReplay()
  expect(write).toHaveBeenCalledTimes(1)
  write.mockReturnValue(true)
  vi.advanceTimersByTime(250)
  expect(write).toHaveBeenCalledTimes(2)
  expect(requests.replaying()).toBe(false)
  requests.close()
  expect(vi.getTimerCount()).toBe(0)
})

function laneStartRequests() {
  const changed = vi.fn()
  const requests = createRequests({
    now: Date.now,
    write: () => true,
    later: setTimeout,
    canReplay: () => true,
    changed,
    transportFailed: () => {},
  })
  return { requests, changed }
}
const create = (requestId: string, branch?: string) =>
  ({
    type: 'command',
    requestId,
    op: {
      type: 'lane.create',
      repositoryId: 'repo',
      worktree: branch ? { branch, fresh: true as const } : null,
      prompt: 'Never in the snapshot',
    },
  }) as const

it('lists unsettled creations without their prompt, phased by pending receipts', () => {
  const { requests, changed } = laneStartRequests()
  const resolve = vi.fn()
  requests.track(create('a', 'phosphor/fix'), resolve)
  requests.track({ type: 'command', requestId: 'b', op: { type: 'abort' } }, () => {})
  expect(changed).toHaveBeenCalledTimes(1)
  expect(requests.laneStarts()).toEqual([{ repositoryId: 'repo', branch: 'phosphor/fix' }])

  expect(requests.receipt({ requestId: 'a', status: 'pending', phase: 'starting' })).toBeUndefined()
  expect(resolve).not.toHaveBeenCalled()
  expect(requests.laneStarts()).toEqual([
    { repositoryId: 'repo', branch: 'phosphor/fix', phase: 'starting' },
  ])
  expect(JSON.stringify(requests.laneStarts())).not.toContain('Never in the snapshot')

  expect(requests.receipt({ requestId: 'a', status: 'done', laneId: 'lane' })).toBe('lane.create')
  expect(resolve).toHaveBeenCalledWith({ requestId: 'a', status: 'done', laneId: 'lane' })
  expect(requests.laneStarts()).toEqual([])
  expect(changed).toHaveBeenCalledTimes(3)
  requests.close()
})

it('ignores phases for other commands and for unknown requests', () => {
  const { requests, changed } = laneStartRequests()
  const resolve = vi.fn()
  requests.track({ type: 'command', requestId: 'b', op: { type: 'abort' } }, resolve)
  requests.receipt({ requestId: 'b', status: 'pending', phase: 'queued' })
  requests.receipt({ requestId: 'nobody', status: 'pending', phase: 'queued' })
  expect(resolve).not.toHaveBeenCalled()
  expect(changed).not.toHaveBeenCalled()
  requests.track(create('a'), () => {})
  expect(requests.laneStarts()).toEqual([{ repositoryId: 'repo', branch: null }])
  requests.close()
  expect(requests.laneStarts()).toEqual([])
})

it('drops a creation from the list once it expires into an unknown outcome', () => {
  vi.useFakeTimers()
  const { requests, changed } = laneStartRequests()
  const resolve = vi.fn()
  requests.track(create('a'), resolve)
  requests.receipt({ requestId: 'a', status: 'pending', phase: 'branching' })
  vi.advanceTimersByTime(60000)
  expect(resolve).toHaveBeenCalledWith({ requestId: 'a', status: 'unknown' })
  expect(requests.laneStarts()).toEqual([])
  // A late phase for a settled request changes nothing.
  requests.receipt({ requestId: 'a', status: 'pending', phase: 'starting' })
  expect(requests.laneStarts()).toEqual([])
  expect(changed).toHaveBeenCalledTimes(3)
  requests.close()
})
