// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { useSessionsStore } from './sessions'
import { useRemoteLanesStore } from './remoteLanes'
import { repoPullRequests, usePullRequestsStore } from './pullRequests'
import type { GhRepoPullRequests } from '@shared/models'

const pr = {
  number: 1,
  title: 'Known',
  state: 'OPEN' as const,
  url: 'https://github.com/a/b/pull/1',
}
const read = vi.fn<(...args: unknown[]) => Promise<GhRepoPullRequests | null>>()
let restore: () => void
let dispose: () => void
beforeEach(() => {
  useSessionsStore.setState({ live: {}, gitByCwd: {}, activeSessionId: null })
  useRemoteLanesStore.setState({ hosts: {} })
  usePullRequestsStore.setState({ byRepo: {}, available: true })
  read.mockReset()
  const fake = createFakePhosphor({ 'gh:prsForRepo': read })
  restore = installFakePhosphor(fake)
  dispose = fake.dispose
})
afterEach(() => {
  restore()
  dispose()
  vi.useRealTimers()
})

it('pages more than 100 interested lanes, bounds each tick, and prioritizes the active branch', async () => {
  vi.useFakeTimers()
  useSessionsStore.setState({
    live: { active: { phosphorId: 'active', workspacePath: '/repo/w120' } },
    activeSessionId: 'active',
    gitByCwd: Object.fromEntries(
      Array.from({ length: 121 }, (_, i) => [
        `/repo/w${i}`,
        {
          isRepo: true,
          mainRepoPath: '/repo',
          branch: `b${i}`,
        },
      ]),
    ),
  })
  read.mockImplementation(async (...args) => {
    const branches = (args[1] as { branches: string[] } | undefined)?.branches ?? []
    return {
      byBranch: Object.fromEntries(branches.map((branch) => [branch, pr])),
      complete: false,
      coverage: Object.fromEntries(
        branches.map((branch) => [
          branch,
          { state: 'found', checkedAt: Date.now(), attemptedAt: Date.now() },
        ]),
      ),
    }
  })
  await usePullRequestsStore.getState().refresh('/repo')
  expect(read).toHaveBeenCalledTimes(4)
  expect((read.mock.calls[0]?.[1] as { branches: string[] }).branches[0]).toBe('b120')
  for (const args of read.mock.calls)
    expect((args[1] as { branches: string[] }).branches.length).toBeLessThanOrEqual(20)
  await vi.advanceTimersByTimeAsync(60_001)
  await usePullRequestsStore.getState().refresh('/repo')
  expect(
    Object.keys(repoPullRequests(usePullRequestsStore.getState(), '/repo').byBranch),
  ).toHaveLength(121)
})

it('merges partial replies, preserves uncovered and failed chips, and deletes only explicit absence', async () => {
  read.mockResolvedValueOnce({
    byBranch: { known: pr, removed: pr, uncovered: pr },
    complete: false,
  })
  await usePullRequestsStore.getState().refresh('/repo')
  const coverage = {
    known: { state: 'unavailable', checkedAt: 10, attemptedAt: 20 },
    removed: { state: 'absent', checkedAt: 20, attemptedAt: 20 },
  }
  read.mockResolvedValueOnce({ byBranch: {}, complete: false, coverage } as GhRepoPullRequests)
  await usePullRequestsStore.getState().refresh('/repo', { force: true })
  const slice = repoPullRequests(usePullRequestsStore.getState(), '/repo')
  expect(slice.byBranch.known).toEqual(pr)
  expect(slice.byBranch.uncovered).toEqual(pr)
  expect(slice.byBranch.removed).toBeUndefined()
  expect(slice).toMatchObject({ coverage })
})

it('continues after a failed page without dropping its known chips or successful pages', async () => {
  useSessionsStore.setState({
    gitByCwd: Object.fromEntries(
      Array.from({ length: 41 }, (_, i) => [
        `/repo/w${i}`,
        { isRepo: true, mainRepoPath: '/repo', branch: `b${i}` },
      ]),
    ),
  })
  usePullRequestsStore.setState({
    byRepo: {
      '/repo': {
        byBranch: { b0: pr, b20: pr },
        complete: false,
        loading: false,
        fetchedAt: 10,
        attemptedAt: 0,
        coverage: { b20: { state: 'found', checkedAt: 10, attemptedAt: 0 } },
      },
    },
  })
  read
    .mockResolvedValueOnce({
      byBranch: {},
      complete: false,
      coverage: {
        b0: { state: 'absent', checkedAt: 20, attemptedAt: 20 },
      },
    })
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({
      byBranch: { b40: pr },
      complete: false,
      coverage: {
        b40: { state: 'found', checkedAt: 30, attemptedAt: 30 },
      },
    })
  await usePullRequestsStore.getState().refresh('/repo')
  const slice = repoPullRequests(usePullRequestsStore.getState(), '/repo')
  expect(read).toHaveBeenCalledTimes(3)
  expect(slice.byBranch).toEqual({ b20: pr, b40: pr })
  expect(slice.coverage?.b0?.state).toBe('absent')
  expect(slice.coverage?.b20).toMatchObject({ state: 'unavailable', checkedAt: 10 })
  expect(slice.coverage?.b40?.checkedAt).toBe(30)
  expect(slice.loading).toBe(false)
})

it('stops after a legacy Host listing and throttles it even with more than four pages of interests', async () => {
  useSessionsStore.setState({
    gitByCwd: Object.fromEntries(
      Array.from({ length: 121 }, (_, i) => [
        `/repo/w${i}`,
        { isRepo: true, mainRepoPath: '/repo', branch: `b${i}` },
      ]),
    ),
  })
  read.mockResolvedValue({ byBranch: { b120: pr }, complete: false })
  await usePullRequestsStore.getState().refresh('/repo')
  await usePullRequestsStore.getState().refresh('/repo')
  expect(read).toHaveBeenCalledTimes(1)
  expect(repoPullRequests(usePullRequestsStore.getState(), '/repo').byBranch.b120).toEqual(pr)
})
